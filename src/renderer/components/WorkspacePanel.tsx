import React, { useEffect, useState } from 'react';
import { GitBranch, LoaderCircle } from 'lucide-react';
import type { ProjectInfo } from '../types';
import { errorMessage } from '../format';
import { highlightCode, type CodeToken } from '../highlightCode';
import { ProjectPanel } from './ProjectPanel';

interface WorkspacePanelProps {
  project?: ProjectInfo;
  reloadKey: number;
  activePath?: string;
  onPreview: (path: string) => void;
  onChangeDirectory: () => void;
}

function languageOf(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return ({ ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', json: 'json', css: 'css', html: 'markup', md: 'markdown', py: 'python', sh: 'bash', yml: 'yaml', yaml: 'yaml' } as Record<string, string>)[extension] ?? 'text';
}

function renderTokens(tokens: CodeToken[]): React.ReactNode[] {
  return tokens.map((token, index) => token.type === 'text' ? token.value : <span key={index} className={token.className}>{renderTokens(token.children)}</span>);
}

export function WorkspacePanel({ project, reloadKey, activePath, onPreview, onChangeDirectory }: WorkspacePanelProps) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    setError(undefined); setContent('');
    if (!activePath || !window.amd?.project?.file) return;
    setLoading(true);
    void window.amd.project.file(activePath).then((file) => {
      if (active) setContent(file.content);
    }).catch((cause) => { if (active) setError(errorMessage(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [activePath, reloadKey]);
  const branch = project?.git?.branch ?? project?.git?.head;
  const previewOpen = Boolean(activePath);
  const language = activePath ? languageOf(activePath) : 'text';
  const lines = content ? content.split('\n') : [];
  const highlighted = lines.map((line) => highlightCode(line, language).tokens);
  return <aside className={'workspace-panel ' + (previewOpen ? 'is-preview' : 'is-tree-only')} aria-label="工作区文件与预览">
    <div className="workspace-panel-main">
      {previewOpen && <section className="workspace-preview" aria-label="文件内容预览">
        {error ? <div className="workspace-preview-empty"><span>无法读取文件</span><small>{error}</small></div>
          : loading ? <div className="workspace-preview-empty"><LoaderCircle size={18} className="spinning" /><span>读取中…</span></div>
            : <div className="workspace-code"><div className="workspace-code-lines" aria-hidden="true">{lines.map((_line, index) => <span key={index}>{index + 1}</span>)}</div><pre>{lines.map((line, index) => <span className="workspace-code-line" key={index}>{renderTokens(highlighted[index])}{line === '' ? ' ' : ''}</span>)}</pre></div>}
      </section>}
      <ProjectPanel project={project} reloadKey={reloadKey} activePath={activePath} onPreview={onPreview} onChangeDirectory={onChangeDirectory} />
    </div>
    <footer className="workspace-footer">
      <span className="workspace-footer-branch"><GitBranch size={11} />{branch || '本地项目'}</span>
      <span className="workspace-footer-sync"><i />本地工作区</span>
    </footer>
  </aside>;
}
