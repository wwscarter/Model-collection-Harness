import { awaitWithSignal } from '@core/tools/awaitWithSignal';
import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import type { AgentRunRequest } from './AgentRuntimeTypes';
import { formatRules } from './RulePrompt';
import { buildSystemPrompt, type SystemPromptInput } from './systemPrompt';

/** Reload before each logical turn while preserving the current Pi session and tool quotas. */
export function prepareRulesPrompt(request: AgentRunRequest, input: SystemPromptInput): { extension: InlineExtension; beforeTurn(): Promise<void> } | undefined {
  const loader = request.rulesLoader;
  if (!loader) return undefined;
  let prompt = buildSystemPrompt(input);
  return {
    async beforeTurn() {
      const loaded = await awaitWithSignal(loader.load({ projectRoot: request.projectRoot, sessionRules: request.sessionRules, signal: request.signal }), request.signal);
      const rules = formatRules(loaded);
      prompt = buildSystemPrompt({ ...input, rules: rules.text });
      request.onRulesLoaded?.({ rules: rules.rules, truncated: rules.truncated });
    },
    extension: {
      name: 'newai-rules', hidden: true, factory: (pi) => {
        pi.on('before_agent_start', (event) => { event.systemPromptOptions.customPrompt = prompt; });
      },
    },
  };
}
