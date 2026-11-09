import type { SessionSummary } from '../components/Sidebar';
import type { ChatMessage } from '../sessionMessages';
import type { SessionMetrics } from '../types';

export interface Session extends SessionSummary { prompt: string; userMessage?: string; output: string; messages: ChatMessage[]; modelUsed?: string; runId?: string; routeConfidence?: number; metrics?: SessionMetrics; audit?: { passed: boolean; score: number; issueCount: number }; auditResult?: { passed: boolean; score: number; issueCount: number }; taskType?: string; rating?: number; multiModel?: boolean; modelId?: string; projectId?: string; projectRoot?: string; updatedAt?: Date; }

export const starterSession = (): Session => ({ id: `session-${crypto.randomUUID()}`, title: '新的工作会话', prompt: '', userMessage: '', output: '', messages: [], multiModel: true, createdAt: new Date() });
export const mostRecentSession = (sessions: Session[]) => [...sessions].sort((left, right) => (right.updatedAt ?? right.createdAt).getTime() - (left.updatedAt ?? left.createdAt).getTime())[0];
