import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

vi.mock('@/lib/ipc', () => ({
  listSkills: vi.fn(),
  readSkill: vi.fn(),
  saveSkill: vi.fn(),
  setSkillEnabled: vi.fn(),
  deleteSkill: vi.fn(),
  importSkill: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { deleteSkill, importSkill, listSkills, readSkill, saveSkill, setSkillEnabled } from '@/lib/ipc';
import { Skills } from '@/screens/Skills';

const hooks = { id: 'hooks', description: 'Use when writing hooks', enabled: true, path: '/d/skills/hooks/SKILL.md' };

beforeEach(() => {
  vi.mocked(listSkills).mockReset().mockResolvedValue([hooks]);
});

describe('Skills screen', () => {
  it("shows the user's skills and the built-in one", async () => {
    render(<Skills />);
    expect(await screen.findByText('hooks')).toBeInTheDocument();
    expect(screen.getByText('Use when writing hooks')).toBeInTheDocument();
    expect(screen.getByText('tayang-studio')).toBeInTheDocument();
    expect(screen.getByText('Always on')).toBeInTheDocument();
  });

  it('says how to start when there are none', async () => {
    vi.mocked(listSkills).mockResolvedValue([]);
    render(<Skills />);
    expect(await screen.findByText('No skills of your own yet')).toBeInTheDocument();
  });

  it('turns a skill off', async () => {
    vi.mocked(setSkillEnabled).mockResolvedValue({ ...hooks, enabled: false });
    render(<Skills />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Use hooks' }));
    expect(setSkillEnabled).toHaveBeenCalledWith('hooks', false);
  });

  it('creates a skill from the editor', async () => {
    vi.mocked(saveSkill).mockResolvedValue(hooks);
    render(<Skills />);
    await userEvent.click(screen.getByRole('button', { name: 'New skill' }));
    const dialog = await screen.findByRole('dialog');
    const add = within(dialog).getByRole('button', { name: 'Add skill' });
    expect(add).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Captions');
    await userEvent.type(within(dialog).getByLabelText('When to use it'), 'Use for captions');
    await userEvent.type(within(dialog).getByLabelText('Instructions'), 'Short lines.');
    await userEvent.click(add);
    expect(saveSkill).toHaveBeenCalledWith({ name: 'Captions', description: 'Use for captions', body: 'Short lines.' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('edits a skill with what is on disk', async () => {
    vi.mocked(readSkill).mockResolvedValue({ skill: hooks, body: 'Ask a question.' });
    vi.mocked(saveSkill).mockResolvedValue(hooks);
    render(<Skills />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit hooks' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText('Name')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Instructions')).toHaveValue('Ask a question.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(saveSkill).toHaveBeenCalledWith({ id: 'hooks', name: 'hooks', description: 'Use when writing hooks', body: 'Ask a question.' });
  });

  it('shows why a save was refused and keeps the editor open', async () => {
    vi.mocked(saveSkill).mockRejectedValue('Give the skill a name with letters or numbers');
    render(<Skills />);
    await userEvent.click(screen.getByRole('button', { name: 'New skill' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), '!!!');
    await userEvent.type(within(dialog).getByLabelText('When to use it'), 'd');
    await userEvent.type(within(dialog).getByLabelText('Instructions'), 'b');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add skill' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Give the skill a name');
  });

  it('asks before deleting', async () => {
    vi.mocked(deleteSkill).mockResolvedValue(undefined);
    render(<Skills />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete hooks' }));
    expect(deleteSkill).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deleteSkill).toHaveBeenCalledWith('hooks');
  });

  it('imports the picked SKILL.md, and does nothing when the picker is closed', async () => {
    vi.mocked(importSkill).mockResolvedValue(hooks);
    vi.mocked(openDialog).mockResolvedValueOnce(null).mockResolvedValueOnce('/x/SKILL.md');
    render(<Skills />);
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(importSkill).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(importSkill).toHaveBeenCalledWith('/x/SKILL.md'));
  });
});
