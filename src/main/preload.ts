import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

const allowedChannels = new Set(['session:model-switched', 'session:chunk', 'session:agent-update', 'session:tool-call', 'session:completed', 'session:verification', 'session:trace', 'tty:data', 'execution:data']);
type Listener = (payload: unknown) => void;
type IpcListener = (_event: IpcRendererEvent, payload: unknown) => void;
const subscriptions = new Map<string, Map<Listener, Set<IpcListener>>>();

function unsubscribe(channel: string, listener: Listener, handler: IpcListener): void {
  ipcRenderer.removeListener(channel, handler);
  const channelListeners = subscriptions.get(channel);
  const handlers = channelListeners?.get(listener);
  handlers?.delete(handler);
  if (!handlers?.size) channelListeners?.delete(listener);
  if (!channelListeners?.size) subscriptions.delete(channel);
}

const amdApi = {
  sandbox: {
    get: () => ipcRenderer.invoke('sandbox:get'),
    set: (input: unknown) => ipcRenderer.invoke('sandbox:set', input),
    pickDirectory: () => ipcRenderer.invoke('sandbox:pick-directory'),
  },
  codebase: {
    get: () => ipcRenderer.invoke('codebase:get'),
    set: (input: unknown) => ipcRenderer.invoke('codebase:set', input),
    probe: (input: unknown) => ipcRenderer.invoke('codebase:probe', input),
    reindex: () => ipcRenderer.invoke('codebase:reindex'),
  },
  listModels: () => ipcRenderer.invoke('model:list'),
  registerModel: (config: unknown) => ipcRenderer.invoke('model:register', config),
  updateModel: (id: string, updates: unknown) => ipcRenderer.invoke('model:update', id, updates),
  deleteModel: (id: string) => ipcRenderer.invoke('model:delete', id),
  testModel: (id: string) => ipcRenderer.invoke('model:test-connection', id),
  routingStatus: () => ipcRenderer.invoke('routing:status'),
  routingConfig: {
    get: () => ipcRenderer.invoke('routing:config:get'),
    set: (settings: unknown) => ipcRenderer.invoke('routing:config:set', settings),
    probe: (settings?: unknown) => ipcRenderer.invoke('routing:config:probe', settings),
  },
  routingLearning: {
    get: (runId: string) => ipcRenderer.invoke('routing:learning:get', runId),
    correct: (input: unknown) => ipcRenderer.invoke('routing:learning:correct', input),
    export: () => ipcRenderer.invoke('routing:learning:export'),
    clear: () => ipcRenderer.invoke('routing:learning:clear'),
  },
  executeTask: (input: unknown) => ipcRenderer.invoke('session:execute', input),
  getTaskMetrics: (sessionId?: string) => ipcRenderer.invoke('metrics:task', sessionId),
  getRecentInvocations: (limit?: number) => ipcRenderer.invoke('metrics:recent', limit),
  getDashboard: (options?: unknown) => ipcRenderer.invoke('metrics:dashboard', options),
  getReportMarkdown: (options?: unknown) => ipcRenderer.invoke('metrics:report', options),
  trace: {
    get: (runId: string) => ipcRenderer.invoke('trace:get', runId),
    recent: (sessionId: string, limit?: number) => ipcRenderer.invoke('trace:recent', sessionId, limit),
    list: (limit?: number) => ipcRenderer.invoke('trace:list', limit),
    settings: () => ipcRenderer.invoke('trace:settings:get'),
    setSettings: (options: { maxAgeDays?: number; maxRuns?: number }) => ipcRenderer.invoke('trace:settings:set', options),
    clear: () => ipcRenderer.invoke('trace:clear'),
  },
  preferences: {
    get: () => ipcRenderer.invoke('preferences:get'),
    set: (input: { approvalMode: 'ask' | 'auto' | 'full' }) => ipcRenderer.invoke('preferences:set', input),
  },
  routingRules: {
    get: () => ipcRenderer.invoke('routing:rules:get'),
    set: (text: string) => ipcRenderer.invoke('routing:rules:set', text),
    history: () => ipcRenderer.invoke('routing:rules:history'),
    restore: (name: string) => ipcRenderer.invoke('routing:rules:restore', name),
  },
  memory: {
    list: (options?: { scope?: 'global' | 'project' | 'session' }) => ipcRenderer.invoke('memory:list', options),
    add: (input: unknown) => ipcRenderer.invoke('memory:add', input),
    remove: (id: string) => ipcRenderer.invoke('memory:remove', id),
    approve: (id: string) => ipcRenderer.invoke('memory:approve', id),
    approveMany: (ids: string[]) => ipcRenderer.invoke('memory:approve-many', ids),
    removeMany: (ids: string[]) => ipcRenderer.invoke('memory:remove-many', ids),
    exportAll: () => ipcRenderer.invoke('memory:export'),
    clear: () => ipcRenderer.invoke('memory:clear'),
    settings: () => ipcRenderer.invoke('memory:settings'),
    setAutoExtract: (enabled: boolean) => ipcRenderer.invoke('memory:set-auto-extract', enabled),
  },
  verifyAuditLog: () => ipcRenderer.invoke('audit:verify'),
  project: {
    current: () => ipcRenderer.invoke('project:current'),
    select: (root?: string) => ipcRenderer.invoke('project:select', root),
    clear: () => ipcRenderer.invoke('project:clear'),
    tree: (options?: unknown) => ipcRenderer.invoke('project:tree', options),
    context: (options?: unknown) => ipcRenderer.invoke('project:context', options),
    file: (path: string) => ipcRenderer.invoke('project:file', path),
    initGit: () => ipcRenderer.invoke('project:init-git'),
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    open: (id: string) => ipcRenderer.invoke('projects:open', id),
    remove: (id: string) => ipcRenderer.invoke('projects:remove', id),
    pickDirectory: () => ipcRenderer.invoke('projects:pick-directory'),
    create: (input: { root: string; name: string }) => ipcRenderer.invoke('projects:create', input),
  },
  getGrowthProfiles: () => ipcRenderer.invoke('growth:profiles'),
  recordGrowthFeedback: (feedback: unknown) => ipcRenderer.invoke('growth:feedback', feedback),
  tty: {
    list: () => ipcRenderer.invoke('tty:list'),
    create: (options?: unknown) => ipcRenderer.invoke('tty:create', options),
    write: (id: string, data: string) => ipcRenderer.invoke('tty:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('tty:resize', id, cols, rows),
    close: (id: string) => ipcRenderer.invoke('tty:close', id),
  },
  execution: {
    run: (request: unknown) => ipcRenderer.invoke('execution:run', request),
    cancel: (id: string) => ipcRenderer.invoke('execution:cancel', id),
  },
  models: {
    list: () => ipcRenderer.invoke('model:list'),
    register: (config: unknown) => ipcRenderer.invoke('model:register', config),
    update: (id: string, updates: unknown) => ipcRenderer.invoke('model:update', id, updates),
    delete: (id: string) => ipcRenderer.invoke('model:delete', id),
    setPrimary: (id: string) => ipcRenderer.invoke('model:set-primary', id),
    fetchModels: (input: unknown) => ipcRenderer.invoke('model:fetch-models', input),
    testConnection: (input: unknown) => ipcRenderer.invoke('model:test-draft', input),
  },
  sessions: {
    list: () => ipcRenderer.invoke('session:list'),
    get: (id: string) => ipcRenderer.invoke('session:get', id),
    save: (session: unknown) => ipcRenderer.invoke('session:save', session),
    delete: (id: string) => ipcRenderer.invoke('session:delete', id),
    execute: (input: unknown) => ipcRenderer.invoke('session:execute', input),
    cancel: (taskId: string) => ipcRenderer.invoke('session:cancel', taskId),
  },
  agent: {
    describe: () => ipcRenderer.invoke('agent:describe'),
    searchProviders: () => ipcRenderer.invoke('agent:search-providers'),
    setSearchProvider: (id: string) => ipcRenderer.invoke('agent:set-search-provider', id),
  },
  on: (channel: string, listener: (payload: unknown) => void) => {
    if (!allowedChannels.has(channel)) return () => undefined;
    const handler = (_event: IpcRendererEvent, payload: unknown) => listener(payload);
    const channelListeners = subscriptions.get(channel) ?? new Map<Listener, Set<IpcListener>>();
    const handlers = channelListeners.get(listener) ?? new Set<IpcListener>();
    handlers.add(handler);
    channelListeners.set(listener, handlers);
    subscriptions.set(channel, channelListeners);
    ipcRenderer.on(channel, handler);
    return () => unsubscribe(channel, listener, handler);
  },
  off: (channel: string, listener: (payload: unknown) => void) => {
    if (!allowedChannels.has(channel)) return;
    for (const handler of subscriptions.get(channel)?.get(listener) ?? []) unsubscribe(channel, listener, handler);
  },
};

contextBridge.exposeInMainWorld('amd', amdApi);

