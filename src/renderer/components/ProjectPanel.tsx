import React, { useEffect, useMemo, useState } from 'react';
import { ChevronRight, File, FileCode, FileText, Folder, FolderOpen, Search, X } from 'lucide-react';
import type { ProjectInfo } from '../types';
import { errorMessage } from '../format';
import '../styles/inspector.css';

type ProjectNode = { name: string; path: string; kind: 'file' | 'directory'; size?: number; children?: ProjectNode[] };

interface ProjectPanelProps {
  project?: ProjectInfo;
  reloadKey: number;
  activePath?: string;
  onPreview: (path: string) => void;
  onChangeDirectory: () => void;
}

const CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|rb|php|swift|c|cc|cpp|h|hpp|cs|vue|svelte|sh|sql|css|scss|html)$/i;
const TEXT_EXTENSIONS = /\.(md|txt|json|ya?ml|toml|ini|conf|lock|xml|csv|log|env\.example)$/i;

export function ProjectPanel({ project, reloadKey, activePath, onPreview, onChangeDirectory }: ProjectPanelProps) {
  const [tree, setTree] = useState<ProjectNode>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setTree(undefined); setError(undefined); setLoading(false);
    if (!project) return;
    if (!window.amd) { setError('请在桌面应用中读取项目文件。'); return; }
    setLoading(true);
    window.amd.project.tree({ maxDepth: 6 })
      .then((result) => { if (active) setTree(result as ProjectNode); })
      .catch((cause) => { if (active) setError(errorMessage(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [project?.root, reloadKey, retry]);
  const visibleTree = useMemo(() => {
    if (!tree) return undefined;
    const needle = query.trim().toLowerCase();
    if (!needle) return tree;
    return filterTree(tree, needle);
  }, [tree, query]);

  if (!project) return <div className="file-tree-empty"><FolderOpen size={20} strokeWidth={1.4} /><span>尚未打开工作区</span><button onClick={onChangeDirectory}>选择文件夹</button></div>;
  return <div className="file-tree-panel" aria-label="工作区文件">
    <div className="file-tree-filter"><Search size={12} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="过滤文件..." aria-label="过滤工作区文件" />{query && <button aria-label="清空过滤" onClick={() => setQuery('')}><X size={11} /></button>}</div>
    <div className="file-tree-scroll" role="tree" aria-busy={loading}>
      {loading ? <div className="file-tree-loading" role="status">读取目录…</div> : error ? <div className="file-tree-error" role="alert"><span>{error}</span><button onClick={() => setRetry((value) => value + 1)}>重试</button></div> : visibleTree?.children?.length ? visibleTree.children.map((child) => <TreeNode key={child.path} node={child} depth={0} activePath={activePath} onPreview={onPreview} forceExpanded={Boolean(query.trim())} />) : <div className="file-tree-empty-inline">没有匹配的文件</div>}
    </div>
  </div>;
}

function filterTree(node: ProjectNode, needle: string): ProjectNode | undefined {
  if (node.kind === 'file') return node.name.toLowerCase().includes(needle) ? node : undefined;
  const children = (node.children ?? []).map((child) => filterTree(child, needle)).filter((child): child is ProjectNode => Boolean(child));
  return children.length ? { ...node, children } : undefined;
}

function TreeNode({ node, depth, activePath, onPreview, forceExpanded }: { node: ProjectNode; depth: number; activePath?: string; onPreview: (path: string) => void; forceExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(depth < 1);
  useEffect(() => { if (forceExpanded) setExpanded(true); }, [forceExpanded]);
  const isDirectory = node.kind === 'directory';
  const isCode = CODE_EXTENSIONS.test(node.name);
  const Icon = isDirectory ? (expanded ? FolderOpen : Folder) : isCode ? FileCode : TEXT_EXTENSIONS.test(node.name) ? FileText : File;
  const active = !isDirectory && node.path === activePath;
  const rowContent = <>
    <span className="file-tree-caret">{isDirectory && <ChevronRight size={11} className={expanded ? 'is-open' : ''} />}</span>
    <Icon size={13} strokeWidth={1.6} className={'file-tree-icon ' + (isDirectory ? 'is-folder' : isCode ? 'is-code' : '')} />
    <span className="file-tree-name">{node.name}{isDirectory ? '/' : ''}</span>
    {!isDirectory && node.size !== undefined && <small>{formatBytes(node.size)}</small>}
  </>;
  return <div className="file-tree-node" role="treeitem" aria-expanded={isDirectory ? expanded : undefined}>
    {isDirectory ? <button type="button" className="file-tree-row is-directory" style={{ paddingLeft: 6 + depth * 13 }} title={node.path} onClick={() => setExpanded((value) => !value)} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); setExpanded(event.key === 'ArrowRight'); } }}>{rowContent}</button> : <button type="button" className={'file-tree-row ' + (active ? 'is-active' : '')} style={{ paddingLeft: 6 + depth * 13 }} title={node.path} onClick={() => onPreview(node.path)}>{rowContent}</button>}
    {expanded && node.children && <div role="group">{node.children.map((child) => <TreeNode key={child.path} node={child} depth={depth + 1} activePath={activePath} onPreview={onPreview} forceExpanded={forceExpanded} />)}</div>}
  </div>;
}

function formatBytes(size: number): string { return size < 1024 ? size + ' B' : (size / 1024).toFixed(1) + ' KB'; }
