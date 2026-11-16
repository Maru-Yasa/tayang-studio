import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { useRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, MessagePart } from '@tayang/shared';
import { MessageList } from '@/components/MessageList';
import { ScrollToBottom } from '@/components/ScrollToBottom';

const tool = (id: string, title: string, extra: Partial<Extract<MessagePart, { type: 'tool' }>> = {}): MessagePart => ({
  type: 'tool',
  toolCallId: id,
  title,
  status: 'done',
  ...extra,
});
const agent = (parts: MessagePart[]): ChatMessage => ({ id: 'a', chatId: 'c', role: 'agent', parts, createdAt: '' });
const text = (t: string): MessagePart => ({ type: 'text', text: t });

describe('inline activity', () => {
  const full = agent([
    text('Before'),
    tool('1', 'Run npm install', { toolKind: 'execute' }),
    { type: 'thought', text: 'hmm' },
    tool('2', 'Run `npm test`', { toolKind: 'execute' }),
    tool('3', 'Load skill: tayang-studio:tayang-studio', { toolKind: 'other' }),
    text('After'),
  ]);

  it('puts one summary between the texts, hides skill loading, has no card', () => {
    const { container } = render(<MessageList streaming={false} messages={[full]} />);
    const el = container.querySelector('[data-testid="agent-message"]')!;
    const order = ['Before', 'Thought process · Ran 2 commands', 'After'].map((t) => el.textContent!.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(screen.getAllByRole('button', { expanded: false })).toHaveLength(1);
    expect(container.textContent).not.toMatch(/Load skill|finished|is working/i);
  });

  it('counts, pluralises and shows failures', () => {
    const m = agent([
      tool('1', 'Edit a.ts', { toolKind: 'edit', path: '/w/a.ts' }),
      tool('2', 'Read b.ts', { toolKind: 'read', path: '/w/b.ts' }),
      tool('3', 'Read c.ts', { toolKind: 'read', path: '/w/c.ts', status: 'failed' }),
      tool('4', 'Search x', { toolKind: 'search' }),
      tool('5', 'Fetch y', { toolKind: 'fetch' }),
      tool('6', 'Mystery'),
    ]);
    render(<MessageList streaming={false} messages={[m]} />);
    expect(screen.getByRole('button')).toHaveTextContent(
      'Edited 1 file · read 2 files · searched 1 time · fetched 1 page · called 1 tool · 1 failed',
    );
  });

  it('expands into rows with verbs, file chips, mono commands and error colour', async () => {
    const m = agent([
      tool('1', 'Run `ls -la`', { toolKind: 'execute' }),
      tool('2', 'Edit src', { toolKind: 'edit', path: '/w/src/App.tsx' }),
      tool('3', 'Read broken', { toolKind: 'read', path: '/w/x.md', status: 'failed' }),
      { type: 'thought', text: 'deep thoughts' },
    ]);
    render(<MessageList streaming={false} messages={[m]} />);
    await userEvent.click(screen.getByRole('button', { name: /Ran 1 command/ }));
    const cmd = screen.getByTitle('ls -la');
    expect(cmd).toHaveClass('font-mono');
    expect(screen.getByText('Run')).toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('App.tsx')).toBeInTheDocument();
    expect(screen.getByText('Read').closest('li')).toHaveClass('text-error');
    expect(screen.queryByText('deep thoughts')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Thought process' }));
    expect(screen.getByText('deep thoughts')).toBeInTheDocument();
  });

  it('shows the running tool with a pulse while streaming, and Working when empty', () => {
    const { container, rerender } = render(
      <MessageList streaming messages={[agent([tool('1', 'Run npm install', { toolKind: 'execute', status: 'running' })])]} />,
    );
    expect(screen.getByRole('button')).toHaveTextContent('Ran 1 command');
    expect(screen.getByTestId('activity-running')).toHaveTextContent(/Run\s*npm install/);
    expect(container.querySelector('.tayang-pulse')).not.toBeNull();
    rerender(<MessageList streaming messages={[agent([])]} />);
    expect(screen.getByText('Working')).toBeInTheDocument();
    expect(container.querySelector('.tayang-pulse')).not.toBeNull();
    rerender(<MessageList streaming messages={[agent([tool('1', 'Load skill: x')])]} />);
    expect(screen.getByText('Working')).toBeInTheDocument();
  });
});

describe('ScrollToBottom', () => {
  function Box() {
    const ref = useRef<HTMLDivElement>(null);
    return (
      <div>
        <div
          data-testid="box"
          ref={(el) => {
            ref.current = el;
            if (el) {
              Object.defineProperty(el, 'clientHeight', { configurable: true, value: 500 });
              Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 2000 });
              el.scrollTo = vi.fn() as unknown as typeof el.scrollTo;
            }
          }}
        />
        <ScrollToBottom scrollRef={ref} />
      </div>
    );
  }
  it('is hidden at the bottom, shown when scrolled up, and scrolls to the end on click', async () => {
    render(<Box />);
    const box = screen.getByTestId('box');
    box.scrollTop = 1500;
    fireEvent.scroll(box);
    expect(screen.queryByRole('button', { name: 'Scroll to bottom' })).toBeNull();
    box.scrollTop = 300;
    fireEvent.scroll(box);
    await userEvent.click(screen.getByRole('button', { name: 'Scroll to bottom' }));
    expect(box.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'smooth' });
  });
});

describe('fix round', () => {
  it('shows auto-approved runs as muted notes, not tools', async () => {
    const m = agent([
      tool('1', 'Run npm test', { toolKind: 'execute' }),
      tool('auto-9', 'Ran without asking: npm test'),
    ]);
    render(<MessageList streaming={false} messages={[m]} />);
    expect(screen.getByRole('button')).toHaveTextContent(/^Ran 1 command$/);
    await userEvent.click(screen.getByRole('button'));
    const note = screen.getByText('Ran without asking: npm test');
    expect(note).toHaveClass('font-mono', 'truncate', 'text-text-3');
  });

  it('uses the error token for failed rows, their chip and the summary', async () => {
    const m = agent([tool('1', 'Read x', { toolKind: 'read', path: '/w/x.md', status: 'failed' })]);
    render(<MessageList streaming={false} messages={[m]} />);
    expect(screen.getByText('1 failed')).toHaveClass('text-error');
    await userEvent.click(screen.getByRole('button'));
    const li = screen.getByText('Read').closest('li')!;
    expect(li).toHaveClass('text-error');
    expect(screen.getByText('x.md').parentElement).toHaveClass('text-current');
  });

  it('draws no avatar for a reply that only loaded a skill', () => {
    const { container } = render(<MessageList streaming={false} messages={[agent([tool('1', 'Load skill: x')])]} />);
    expect(container.querySelector('[data-testid="agent-message"]')).toBeNull();
  });

  it('the pill turns stick-to-bottom back on', async () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    function Both({ n }: { n: number }) {
      const ref = useRef<HTMLDivElement>(null);
      return (
        <div>
          <div
            data-testid="box"
            ref={(el) => {
              ref.current = el;
              if (el) {
                Object.defineProperty(el, 'clientHeight', { configurable: true, value: 500 });
                Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 2000 });
                el.scrollTo = vi.fn() as unknown as typeof el.scrollTo;
              }
            }}
          >
            <MessageList streaming={false} messages={Array.from({ length: n }, (_, i) => agent([text(`m${i}`)]))} scrollRef={ref} />
          </div>
          <ScrollToBottom scrollRef={ref} />
        </div>
      );
    }
    const view = render(<Both n={1} />);
    const box = screen.getByTestId('box');
    box.scrollTop = 100;
    fireEvent.scroll(box);
    spy.mockClear();
    view.rerender(<Both n={2} />);
    expect(spy).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Scroll to bottom' }));
    box.scrollTop = 100; // a chunk landed mid-animation, still far away
    view.rerender(<Both n={3} />);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a small scroll up while the agent writes stops following (issue #27)', () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    function Box({ n }: { n: number }) {
      const ref = useRef<HTMLDivElement>(null);
      return (
        <div
          data-testid="box"
          ref={(el) => {
            ref.current = el;
            if (el) {
              Object.defineProperty(el, 'clientHeight', { configurable: true, value: 500 });
              Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 2000 });
            }
          }}
        >
          <MessageList streaming messages={Array.from({ length: n }, (_, i) => agent([text(`m${i}`)]))} scrollRef={ref} />
        </div>
      );
    }
    const view = render(<Box n={1} />);
    const box = screen.getByTestId('box');
    box.scrollTop = 1500;
    fireEvent.scroll(box);
    box.scrollTop = 1460; // one wheel notch up: still within 80px of the end
    fireEvent.scroll(box);
    spy.mockClear();
    view.rerender(<Box n={2} />);
    expect(spy).not.toHaveBeenCalled();
    box.scrollTop = 1490; // back down near the end: follow again
    fireEvent.scroll(box);
    view.rerender(<Box n={3} />);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  describe('opening a chat lands on the latest message', () => {
    const msgs = (chatId: string, n: number): ChatMessage[] =>
      Array.from({ length: n }, (_, i) => ({ ...agent([text(`${chatId}-${i}`)]), id: `${chatId}-${i}`, chatId }));
    function Chat({ messages }: { messages: ChatMessage[] }) {
      const ref = useRef<HTMLDivElement>(null);
      return (
        <div
          data-testid="box"
          ref={(el) => {
            ref.current = el;
            if (el) {
              Object.defineProperty(el, 'clientHeight', { configurable: true, value: 500 });
              Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 2000 });
            }
          }}
        >
          <MessageList streaming={false} messages={messages} scrollRef={ref} />
        </div>
      );
    }
    let resized: (() => void)[] = [];
    beforeEach(() => {
      resized = [];
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(cb: () => void) {
            resized.push(cb);
          }
          observe() {}
          disconnect() {}
        },
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    it('switching to another chat scrolls to its end, even after reading up in the last one', () => {
      const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
      const view = render(<Chat messages={msgs('c1', 5)} />);
      expect(spy).toHaveBeenCalledWith({ block: 'end' });
      const box = screen.getByTestId('box');
      box.scrollTop = 100;
      fireEvent.scroll(box);
      spy.mockClear();
      view.rerender(<Chat messages={msgs('c2', 8)} />);
      expect(spy).toHaveBeenCalledWith({ block: 'end' });
      spy.mockRestore();
    });

    it('history loaded after the screen opened also lands at the end', () => {
      const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
      const view = render(<Chat messages={[]} />);
      spy.mockClear();
      view.rerender(<Chat messages={msgs('c1', 6)} />);
      expect(spy).toHaveBeenCalledWith({ block: 'end' });
      spy.mockRestore();
    });

    it('keeps to the end while the messages finish laying out, unless the reader scrolled up', () => {
      const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
      render(<Chat messages={msgs('c1', 5)} />);
      const box = screen.getByTestId('box');
      box.scrollTop = 1500;
      fireEvent.scroll(box);
      spy.mockClear();
      // Images and cards grow the list after the first scroll.
      resized.forEach((cb) => cb());
      expect(spy).toHaveBeenCalledWith({ block: 'end' });
      box.scrollTop = 100;
      fireEvent.scroll(box);
      spy.mockClear();
      resized.forEach((cb) => cb());
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  it('never pairs outline-none with a focus outline width but no outline style', () => {
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const path = join(dir, f);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx$/.test(f) && !/\.test\./.test(f)) {
          for (const m of readFileSync(path, 'utf8').matchAll(/"[^"]*\boutline-none\b[^"]*"/g)) {
            if (/focus-visible:outline-\d/.test(m[0]) && !m[0].includes('focus-visible:outline-solid')) bad.push(`${path}: ${m[0]}`);
          }
        }
      }
    };
    walk(join(__dirname, '..'));
    expect(bad).toEqual([]);
  });
});
