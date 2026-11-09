import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Screens and components must not carry English copy of their own: JSX text, and the text attributes
 * a screen reader or tooltip shows, go through `t(...)`. A parser (not a regex) finds them. Put
 * `i18n-ignore` in a comment on the same or the line above to allow a deliberate exception.
 */
const SRC = resolve(__dirname, '..');
const ROOTS = ['screens', 'components', 'a2ui', 'state', 'lib'].map((d) => join(SRC, d));
/** shadcn primitives are not ours to translate; their one visible string is `common.close`. */
const SKIP = [join(SRC, 'components', 'ui')];
/** Props that never carry words a person reads; every other string prop is checked. */
const TECHNICAL = new Set([
  'className', 'variant', 'size', 'side', 'align', 'type', 'role', 'id', 'htmlFor', 'href', 'src', 'value', 'defaultValue',
  'name', 'key', 'style', 'target', 'rel', 'mood', 'tag', 'loading', 'decoding', 'autoComplete', 'inputMode', 'spellCheck', 'orientation',
  'kind', 'color', 'mode', 'viewBox', 'd', 'fill', 'stroke', 'width', 'height', 'xmlns', 'selector', 'preload', 'crossOrigin',
]);
/** The aria-* props that do carry words. */
const ARIA_TEXT = new Set(['aria-label', 'aria-description', 'aria-placeholder', 'aria-valuetext', 'aria-roledescription']);
const isTextProp = (name: string) =>
  name.startsWith('aria-') ? ARIA_TEXT.has(name) : !TECHNICAL.has(name) && !name.startsWith('data-') && !/^on[A-Z]/.test(name);
/** Object properties that hold a label, in tables like the ones this task removed. */
const TEXT_KEYS = new Set(['label', 'title', 'text', 'hint', 'description', 'message', 'heading', 'note', 'verb', 'placeholder']);
/** Calls whose string argument reaches the user. */
const SAY = new Set(['appendSystem', 'fail', 'setError', 'setApiError', 'setUrlError', 'setSetupLine', 'say']);
/** Names that stay as they are in every language. */
const BRANDS = [
  'Tayang', 'Claude Code', 'Claude', 'claude', 'opencode', 'Codex', 'Gemini CLI', 'Gemini', 'HyperFrames', 'Remotion',
  'ElevenLabs', 'FFmpeg', 'yt-dlp', 'Node.js', 'Chrome', 'Oyen', 'TikTok', 'Instagram', 'Reels', 'YouTube', 'ACP', 'MCP',
  'DeepSeek', '9router', 'CommandCode', 'sk_', 'Shift', 'Esc', 'MP4', 'API', 'Bahasa Indonesia', 'English',
];

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (SKIP.includes(p)) return [];
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(p) && !p.endsWith('.d.ts') ? [p] : [];
  });

/** Whether `text` has a word of plain English once brand names are taken out. */
export function hasCopy(text: string): boolean {
  let rest = text;
  for (const b of BRANDS) rest = rest.split(b).join(' ');
  return /[A-Za-z]{2,}/.test(rest);
}

export function findCopy(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = source.split('\n');
  const hits: string[] = [];
  const ignored = (pos: number) => {
    const line = sf.getLineAndCharacterOfPosition(pos).line;
    return /i18n-ignore/.test(lines[line] ?? '') || /i18n-ignore/.test(lines[line - 1] ?? '');
  };
  const report = (node: ts.Node, text: string) => {
    const start = node.getStart(sf);
    if (ignored(start)) return;
    hits.push(`${relative(SRC, file)}:${sf.getLineAndCharacterOfPosition(start).line + 1}  ${JSON.stringify(text.trim().slice(0, 60))}`);
  };
  /** Text nodes a JSX expression or prop can show: through ?:, && and ||, and the fixed parts of `${}` templates. */
  const literals = (e: ts.Expression, out: { node: ts.Node; text: string }[] = []) => {
    if (ts.isParenthesizedExpression(e)) return literals(e.expression, out);
    if (ts.isConditionalExpression(e)) return literals(e.whenTrue, literals(e.whenFalse, out));
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      // `a && 'text'` shows the right side; comparisons show nothing
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return literals(e.right, out);
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return literals(e.left, literals(e.right, out));
    }
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) out.push({ node: e, text: e.text });
    if (ts.isTemplateExpression(e)) {
      out.push({ node: e, text: [e.head.text, ...e.templateSpans.map((sp) => sp.literal.text)].join(' ') });
    }
    return out;
  };
  const check = (e: ts.Expression) => {
    for (const l of literals(e)) if (hasCopy(l.text)) report(l.node, l.text);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      if (hasCopy(node.text)) report(node, node.text);
    } else if (ts.isJsxAttribute(node) && isTextProp(node.name.getText(sf))) {
      const init = node.initializer;
      if (init && ts.isStringLiteral(init) && hasCopy(init.text)) report(init, init.text);
      if (init && ts.isJsxExpression(init) && init.expression) check(init.expression);
    } else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      check(node.expression);
    } else if (ts.isPropertyAssignment(node) && TEXT_KEYS.has(node.name.getText(sf).replace(/['"]/g, ''))) {
      // label tables: `{ label: 'Queued' }`
      check(node.initializer);
    } else if (ts.isCallExpression(node) && SAY.has(node.expression.getText(sf).split('.').pop()!)) {
      for (const arg of node.arguments) check(arg);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe('no English copy outside t()', () => {
  it('finds none in screens, components, a2ui, state and lib', () => {
    const found = ROOTS.flatMap(files).flatMap((f) => findCopy(f, readFileSync(f, 'utf8')));
    expect(found).toEqual([]);
  });

  it('does catch text, attributes and string literals, and lets brands and marked lines through', () => {
    const bad = `export const A = () => <div title="Close it" aria-label={x ? 'Open' : t('a')}>Hello there{ok && 'Saved'}</div>;`;
    expect(findCopy('a.tsx', bad)).toHaveLength(4);
    // template literals, any text prop, label tables and say-calls
    expect(findCopy('c.tsx', 'export const D = () => <Row hint="Be careful" title={`Open ${x} now`} variant="ghost" />;')).toHaveLength(2);
    expect(findCopy('d.ts', "const T = [{ label: 'Queued' }]; appendSystem(id, 'Hello there'); fail(`Could not ${x}`);")).toHaveLength(3);
    expect(findCopy('e.ts', "const T = [{ id: 'queued' }]; fail(t('a'), msg); ")).toEqual([]);
    const fine = [
      `export const B = () => <div title={t('a')}>{t('b')} · Claude Code · yt-dlp {'→'}</div>;`,
      `export const C = () => <p>\n  {/* i18n-ignore: a sample */}\n  Kenapa rupiah melemah?\n</p>;`,
    ];
    for (const src of fine) expect(findCopy('b.tsx', src)).toEqual([]);
  });
});
