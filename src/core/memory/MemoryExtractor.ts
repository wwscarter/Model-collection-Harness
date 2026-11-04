import type { ModelConfig } from '@core/models/ModelConfig';
import { createProvider, type ModelProvider } from '@core/providers/ModelProvider';
import type { MemoryKind } from './MemoryStore';

export interface MemoryExtractionInput {
  prompt: string;
  answer: string;
  model: ModelConfig;
  signal?: AbortSignal;
  provider?: Pick<ModelProvider, 'invoke'>;
}

export interface ExtractedMemory { content: string; kind: MemoryKind; tags: string[]; }
export interface MemoryExtractionResult { memories: ExtractedMemory[]; inputTokens: number; outputTokens: number; }

const KINDS: MemoryKind[] = ['preference', 'fact', 'decision', 'todo', 'artifact'];

function parse(raw: string): unknown {
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(stripped); } catch {
    const start = stripped.indexOf('[');
    const end = stripped.lastIndexOf(']');
    if (start < 0 || end <= start) return undefined;
    try { return JSON.parse(stripped.slice(start, end + 1)); } catch { return undefined; }
  }
}

/** Extract at most a few durable facts; the caller still applies the secret filter. */
export async function extractMemories(input: MemoryExtractionInput): Promise<MemoryExtractionResult> {
  const provider = input.provider ?? createProvider(input.model);
  let inputTokens = 0;
  let outputTokens = 0;
  const prompt = [
    'From the conversation below, extract at most 3 durable memories worth keeping for future sessions.',
    'Only include explicit preferences, project decisions, stable facts or TODOs. Do not include transient task details, secrets, credentials or file contents.',
    'Return a JSON array only: [{"content":"...","kind":"preference|fact|decision|todo|artifact","tags":["..."]}]',
    'If nothing is worth remembering, return [].',
    '',
    `User request:\n${input.prompt.slice(0, 6_000)}`,
    '',
    `Assistant answer:\n${input.answer.slice(0, 8_000)}`,
  ].join('\n');
  const response = await provider.invoke(prompt, { maxTokens: 500, temperature: 0.1, signal: input.signal });
  inputTokens += response.inputTokens;
  outputTokens += response.outputTokens;
  const parsed = parse(response.content);
  if (!Array.isArray(parsed)) return { memories: [], inputTokens, outputTokens };
  const memories = parsed.slice(0, 3).flatMap((value): ExtractedMemory[] => {
    if (!value || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content.trim() : '';
    if (!content || content.length > 1_000) return [];
    const kind = typeof record.kind === 'string' && KINDS.includes(record.kind as MemoryKind) ? record.kind as MemoryKind : 'fact';
    const tags = Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.slice(0, 40)).slice(0, 8) : [];
    return [{ content, kind, tags }];
  });
  return { memories, inputTokens, outputTokens };
}
