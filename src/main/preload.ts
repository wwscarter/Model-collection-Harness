import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

const allowedChannels = new Set(['session:model-switched', 'session:chunk', 'session:agent-update', 'session:tool-call', 'session:completed', 'session:trace', 'tty:data', 'execution:data']);

const amdApi = {
  listModels: () => ipcRenderer.invoke('model:list'),
  registerModel: (config: unknown) => ipcRenderer.invoke('model:register', config),
  updateModel: (id: string, updates: unknown) => ipcRenderer.invoke('model:update', id, updates),
  deleteModel: (id: string) => ipcRenderer.invoke('model:delete', id),
  testModel: (id: string) => ipcRenderer.invoke('model:test-connection', id),
  routingStatus: () => ipcRenderer.invoke('routing:status'),
  executeTask: (input: unknown) => ipcRenderer.invoke('session:execute', input),
  getTaskMetrics: (sessionId?: string) => ipcRenderer.invoke('metrics:task', sessionId),
  getRecentInvocations: (limit?: number) => ipcRenderer.invoke('metrics:recent', limit),
  getDashboard: (options?: unknown) => ipcRenderer.invoke('metrics:dashboard', options),
  getReportMarkdown: (options?: unknown) => ipcRenderer.invoke('metrics:report', options),
  trace: {
    get: (runId: string) => ipcRenderer.invoke('trace:get', runId),
    recent: (sessionId: string, limit?: number) => ipcRenderer.invoke('trace:recent', sessionId, limit),
    settings: () => ipcRenderer.invoke('trace:settings:get'),
    setSettings: (options: { maxAgeDays?: number; maxRuns?: number }) => ipcRenderer.invoke('trace:settings:set', options),
    clear: () => ipcRenderer.invoke('trace:clear'),
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
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  off: (channel: string, listener: (payload: unknown) => void) => {
    if (!allowedChannels.has(channel)) return;
    ipcRenderer.removeListener(channel, listener as never);
  },
};

contextBridge.exposeInMainWorld('amd', amdApi);

