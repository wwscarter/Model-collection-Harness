import React from 'react';
import { FileText, FolderTree, Globe, Search, Wrench } from 'lucide-react';
import type { ChatToolCall } from '../sessionMessages';

const TOOL_META: Record<string, { label: string; icon: typeof Search }> = {
  web_search: { label: '联网搜索', icon: Search },
  web_fetch: { label: '读取网页', icon: Globe },
  read: { label: '读取文件', icon: FileText },
  ls: { label: '列出目录', icon: FolderTree },
};

const STATUS_LABEL: Record<ChatToolCall['status'], string> = { running: '进行中', completed: '完成', failed: '失败' };

function formatDuration(ms?: number): string | undefined {
  if (ms === undefined) return undefined;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Compact list of the tool calls the model made for one answer. */
export function ToolCallList({ tools }: { tools: ChatToolCall[] }) {
  if (!tools.length) return null;
  return <section className="tool-calls" aria-label="工具调用">
    {tools.map((tool) => {
      const meta = TOOL_META[tool.toolName] ?? { label: tool.toolName, icon: Wrench };
      const Icon = meta.icon;
      const duration = formatDuration(tool.durationMs);
      return <div className={`tool-call ${tool.status}`} key={tool.id} title={tool.status === 'failed' ? tool.summary : undefined}>
        <Icon size={13} strokeWidth={1.8} />
        <strong>{meta.label}</strong>
        {tool.label && <span className="tool-call-label">{tool.label}</span>}
        <span className={`agent-status ${tool.status}`}>{STATUS_LABEL[tool.status]}{duration && tool.status !== 'running' ? ` · ${duration}` : ''}</span>
      </div>;
    })}
  </section>;
}
