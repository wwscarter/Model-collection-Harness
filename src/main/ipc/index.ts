import type { MainContext } from '../MainContext';
import { register as registerModel } from './modelIpc';
import { register as registerSession } from './sessionIpc';
import { register as registerProject } from './projectIpc';
import { register as registerRouting } from './routingIpc';
import { register as registerMemory } from './memoryIpc';
import { register as registerMetrics } from './metricsIpc';
import { register as registerTrace } from './traceIpc';
import { register as registerAgent } from './agentIpc';
import { register as registerExecution } from './executionIpc';
import { register as registerPreferences } from './preferencesIpc';
import { register as registerCodebase } from './codebaseIpc';
import { register as registerSandbox } from './sandboxIpc';
import { register as registerRules } from './rulesIpc';
import { register as registerHooks } from './hooksIpc';
import { register as registerSkills } from './skillsIpc';
import { register as registerToolTrust } from './toolTrustIpc';
import { register as registerMcp } from './mcpIpc';

export function registerHandlers(ctx: MainContext): void {
  registerModel(ctx);
  registerSession(ctx);
  registerProject(ctx);
  registerRouting(ctx);
  registerMemory(ctx);
  registerMetrics(ctx);
  registerTrace(ctx);
  registerAgent(ctx);
  registerExecution(ctx);
  registerPreferences(ctx);
  registerCodebase(ctx);
  registerSandbox(ctx);
  registerRules(ctx);
  registerHooks(ctx);
  registerSkills(ctx);
  registerToolTrust(ctx);
  registerMcp(ctx);
}
