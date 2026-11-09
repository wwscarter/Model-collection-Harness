import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunDependencies } from '../../src/core/agent/RunCoordinator';
import type { ProjectRecord } from '../../src/core/storage/ProjectStorage';
import { AgentRuntime } from '../../src/core/agent/AgentRuntime';
import type { ModelConfig } from '../../src/core/models/ModelConfig';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  appEvents: new Map<string, (...args: any[]) => any>(),
  userData: '',
  showOpenDialog: vi.fn(),
  openPath: vi.fn(async () => ''),
  executeRun: vi.fn(async (_request: unknown, _deps: unknown, _emit: unknown) => ({ output: 'done' })),
}));

vi.mock('electron', () => ({
  app: {
    whenReady: async () => undefined,
    getPath: () => state.userData,
    requestSingleInstanceLock: () => true,
    on: (name: string, listener: (...args: any[]) => any) => state.appEvents.set(name, listener),
    quit: vi.fn(),
  },
  BrowserWindow: class {
    webContents = { send: vi.fn() };
    loadFile = vi.fn();
    loadURL = vi.fn();
    on = vi.fn();
  },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => state.handlers.set(channel, handler) },
  nativeTheme: { shouldUseDarkColors: false, on: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
  session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } },
  dialog: { showOpenDialog: state.showOpenDialog, showMessageBox: vi.fn(), showErrorBox: vi.fn() },
  shell: { openPath: state.openPath },
}));

vi.mock('../../src/core/agent/RunCoordinator', () => ({ executeRun: state.executeRun }));

let directory: string;
let projectA: ProjectRecord;
let projectB: ProjectRecord;
const event = { senderFrame: { url: 'file:///newai/dist/renderer/index.html' } };
const invoke = (channel: string, ...args: unknown[]) => state.handlers.get(channel)!(event, ...args);

async function addProject(name: string): Promise<ProjectRecord> {
  const root = path.join(directory, name);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'README.md'), name);
  state.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [root] });
  const picked = await invoke('projects:pick-directory');
  return invoke('projects:create', { root: picked.root, name });
}

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newai-main-session-'));
  state.userData = path.join(directory, 'user-data');
  await import('../../src/main/main');
  await vi.waitFor(() => expect(state.handlers.has('session:execute')).toBe(true));
  projectA = await addProject('project-a');
  projectB = await addProject('project-b');
});

beforeEach(() => { state.executeRun.mockClear(); });

afterAll(async () => {
  await state.appEvents.get('before-quit')?.();
  fs.rmSync(directory, { recursive: true, force: true });
});

function saveSession(id: string, projectId?: string) {
  return invoke('session:save', { id, title: id, prompt: '', output: '', projectId, createdAt: new Date(), updatedAt: new Date() });
}

describe('main process session projects', () => {
  it('routes selected skill previews, confirmation, enabled state and tool trust through startup IPC', async () => {
    const source = path.join(directory, 'ordinary-guide');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: ordinary-guide\ndescription: Explain project conventions.\n---\nUse clear task summaries.');
    state.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [source] });
    const preview = await invoke('agent:skills:preview-import');
    expect(preview).toMatchObject({ token: expect.any(String), preview: { name: 'ordinary-guide', fileCount: 1, content: expect.stringContaining('Use clear task summaries.') } });
    expect(await invoke('agent:skills:confirm-import', preview.token)).toMatchObject({ name: 'ordinary-guide' });
    expect((await invoke('agent:skills:list')).skills).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'ordinary-guide', enabled: true })]));
    await invoke('agent:skills:set-enabled', 'ordinary-guide', false);
    expect((await invoke('agent:skills:list')).skills).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'ordinary-guide', enabled: false })]));
    expect(await invoke('agent:skills:open-directory')).toEqual({ success: true });
    expect(state.openPath).toHaveBeenCalledWith(path.join(fs.realpathSync(state.userData), 'agent', 'skills'));
    expect(await invoke('agent:tool-trust:set', 'read', 'ask')).toMatchObject({ read: 'ask' });
    expect((await invoke('agent:tool-trust:get')).tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'read', trust: 'ask', source: 'builtin' })]));
  });

  it('routes Hooks configuration and current project confirmation through the startup IPC registration', async () => {
    const config = { version: 1, hooks: [{ id: 'lint', event: 'run_start', run: 'npm run lint' }] };
    const projectFile = path.join(projectA.root, '.newai', 'hooks.json');
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, JSON.stringify(config, null, 2) + '\n');
    await invoke('projects:open', projectA.id);
    try {
      expect(await invoke('agent:hooks:save', config)).toEqual(config);
      const listing = await invoke('agent:hooks:list');
      expect(listing.global).toMatchObject({ trusted: true, config });
      expect(listing.project).toMatchObject({ path: projectFile, trusted: false, config });
      expect(await invoke('agent:hooks:trust', listing.project.hash)).toEqual({ success: true });
      expect((await invoke('agent:hooks:list')).project.trusted).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(state.userData, 'trust.json'), 'utf8')).grants).toEqual(expect.arrayContaining([expect.objectContaining({ projectRoot: projectA.root, file: '.newai/hooks.json', sha256: listing.project.hash })]));
    } finally {
      await invoke('agent:hooks:save', { version: 1, hooks: [] });
      fs.rmSync(projectFile, { force: true });
    }
  });

  it('forwards the agent stop reason and preserves zero usage through streamed model responses', async () => {
    const run = vi.spyOn(AgentRuntime.prototype, 'run').mockResolvedValue({ content: 'Current stage summary', inputTokens: 0, outputTokens: 17, toolCalls: 80, stopReason: 'tool_limit' });
    const onRulesLoaded = vi.fn();
    const afterTurn = vi.fn();
    const hookRunner = { run: vi.fn() };
    const current = { ...invoke('model:list')[0], id: 'synthetic', name: 'Synthetic model', provider: 'custom', apiKey: '', baseURL: 'http://127.0.0.1/v1' } as ModelConfig;
    state.executeRun.mockImplementationOnce(async (_request, supplied) => {
      const response = await (supplied as RunDependencies).invokeStreamed(current, 'hello', 100, () => undefined, { sessionRules: 'Prefer concise answers.', onRulesLoaded, afterTurn, hookRunner });
      return { output: response.content, response };
    });
    try {
      expect(await invoke('session:execute', { sessionId: 'forward-stop-reason', prompt: 'hello', projectId: null })).toMatchObject({ response: { content: 'Current stage summary', stopReason: 'tool_limit', inputTokens: 0, outputTokens: 17 } });
      expect(run).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ sessionRules: 'Prefer concise answers.', rulesLoader: expect.objectContaining({ load: expect.any(Function) }), onRulesLoaded, afterTurn, hookRunner }));
    } finally { run.mockRestore(); }
  });

  it('applies saved and restored routing rules to the next run while archiving the previous policy', async () => {
    const current = invoke('model:register', { id: 'ordinary-routing', provider: 'custom', name: 'Ordinary routing fixture', modelId: 'ordinary-routing', apiKey: '', baseURL: 'http://127.0.0.1/v1', enabled: true });
    const routeNextRun = async () => {
      await invoke('session:execute', { sessionId: 'routing-policy-snapshot', prompt: 'hello', projectId: null });
      const deps = state.executeRun.mock.calls.at(-1)![1] as RunDependencies;
      return deps.routing.routeTask({ id: 'ordinary-routing-task', type: 'general', description: 'hello', complexity: 'low' }, deps.models.getAllModels(), undefined, { skipSemantic: true });
    };
    const original = JSON.stringify({ version: 1, rules: [{ id: 'review', enabled: true, priority: 1, when: {}, then: { strategy: 'single' } }], defaults: { strategy: 'single' } });
    const updated = JSON.stringify({ version: 1, rules: [], defaults: { strategy: 'parallel' } });
    invoke('routing:rules:set', original);
    expect(await routeNextRun()).toMatchObject({ modelId: current.id, strategy: 'single', ruleId: 'review' });
    const before = invoke('routing:rules:history');
    expect(() => invoke('routing:rules:set', JSON.stringify({ rules: 'wrong' }))).toThrow();
    expect(invoke('routing:rules:get').text).toBe(original);
    expect(invoke('routing:rules:history')).toEqual(before);

    invoke('routing:rules:set', updated);
    expect(await routeNextRun()).toMatchObject({ modelId: current.id, strategy: 'parallel', ruleId: undefined });
    const history = invoke('routing:rules:history') as Array<{ name: string }>;
    const archivedOriginal = history.find((item) => fs.readFileSync(path.join(state.userData, 'routing-rules.history', item.name), 'utf8') === original)!;
    expect(invoke('routing:rules:restore', archivedOriginal.name).text).toBe(original);
    expect(invoke('routing:rules:get').text).toBe(original);
    expect(await routeNextRun()).toMatchObject({ modelId: current.id, strategy: 'single', ruleId: 'review' });
    const restoredHistory = invoke('routing:rules:history') as Array<{ name: string }>;
    expect(restoredHistory.length).toBe(history.length + 1);
    expect(restoredHistory.some((item) => fs.readFileSync(path.join(state.userData, 'routing-rules.history', item.name), 'utf8') === updated)).toBe(true);
    invoke('model:delete', current.id);
  });

  it('publishes preference changes only after they have been persisted', () => {
    expect(invoke('preferences:set', { approvalMode: 'auto' })).toEqual({ approvalMode: 'auto' });
    const file = path.join(state.userData, 'preferences.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ approvalMode: 'auto' });
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk full'); });
    try {
      expect(() => invoke('preferences:set', { approvalMode: 'ask' })).toThrow('设置保存失败');
      expect(invoke('preferences:get')).toEqual({ approvalMode: 'auto' });
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ approvalMode: 'auto' });
    } finally { rename.mockRestore(); }
  });

  it('executes an explicitly unassociated session without the project shown in the file panel', async () => {
    await invoke('projects:open', projectA.id);
    await invoke('session:execute', { sessionId: 'unassociated', prompt: 'hello', projectId: null });

    const deps = state.executeRun.mock.calls[0][1] as RunDependencies;
    expect(deps.projectContext.getRoot()).toBeUndefined();
    expect(await deps.projectContext.getContextAsync()).toBeUndefined();
    expect(invoke('project:current').id).toBe(projectA.id);
  });

  it('restores the saved session association and retains its context after the file panel changes', async () => {
    await saveSession('saved-project', projectA.id);
    await invoke('projects:open', projectB.id);
    await invoke('session:execute', { sessionId: 'saved-project', prompt: 'continue' });
    const deps = state.executeRun.mock.calls[0][1] as RunDependencies;
    await invoke('project:clear');

    expect(deps.projectContext.getRoot()).toBe(projectA.root);
    expect((await deps.projectContext.getContextAsync())?.text).toContain('project-a');
  });

  it('uses an explicit project selection instead of an older saved association', async () => {
    await saveSession('updated-project', projectA.id);
    await invoke('session:execute', { sessionId: 'updated-project', prompt: 'continue', projectId: projectB.id });

    const deps = state.executeRun.mock.calls[0][1] as RunDependencies;
    expect(deps.projectContext.getRoot()).toBe(projectB.root);
  });

  it('aborts the active run when its session is deleted', async () => {
    await saveSession('deleted-running', projectA.id);
    let finish!: () => void;
    state.executeRun.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { output: 'done' };
    });
    const running = invoke('session:execute', { sessionId: 'deleted-running', prompt: 'continue', projectId: projectA.id });
    const deps = state.executeRun.mock.calls[0][1] as RunDependencies;
    expect(deps.controller.signal.aborted).toBe(false);

    expect(await invoke('session:delete', 'deleted-running')).toEqual({ success: true });
    expect(deps.controller.signal.aborted).toBe(true);
    expect(invoke('session:get', 'deleted-running')).toBeUndefined();
    finish();
    await running;
  });
});
