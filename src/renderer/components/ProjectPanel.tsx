import React, { useEffect, useState } from 'react';
import { ChevronRight, File, FileCode, FileText, Folder, FolderOpen, FolderX, GitBranch, RefreshCw } from 'lucide-react';
import type { ProjectInfo } from '../types';
import { errorMessage } from '../format';

type ProjectNode = { name: string; path: string; kind: 'file' | 'directory'; size?: number; children?: ProjectNode[] };

interface ProjectPanelProps {
  project?: ProjectInfo;
  /** Bump to reload the tree (e.g. after switching projects). */
  reloadKey: number;
  onChangeDirectory: () => void;
  onClear: () => void;
}

const CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|rb|php|swift|c|cc|cpp|h|hpp|cs|vue|svelte|sh|sql|css|scss|html)$/i;
const TEXT_EXTENSIONS = /\.(md|txt|json|ya?ml|toml|ini|conf|lock|xml|csv|log|env\.example)$/i;

export function ProjectPanel({ project, reloadKey, onChangeDirectory, onClear }: ProjectPanelProps) {
  const [tree, setTree] = useState<ProjectNode>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [refreshCount, setRefreshCount] = useState(0);

  useEffect(() => {
    let active = true;
    setTree(undefined); setError(undefined);
    if (!project || !window.amd) return;
    setLoading(true);
    window.amd.project.tree({ maxDepth: 5 })
      .then((result) => { if (active) setTree(result as ProjectNode); })
      .catch((cause) => { if (active) setError(errorMessage(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [project?.root, reloadKey, refreshCount]);

  if (!project) return <div className="project-panel">
    <div className="project-empty-state"><span className="project-tile"><FolderOpen size={16} /></span><strong>尚未打开项目</strong><span>绑定本地文件夹后，任务可以读取其中的文本文件作为只读上下文。</span><button className="button primary" onClick={onChangeDirectory}>选择文件夹</button></div>
  </div>;

  const markers = new Set(project.markers);
  return <div className="project-panel">
    <div className="project-summary">
      <span className="project-tile"><Folder size={14} /></span>
      <div className="project-summary-copy">
        <div className="project-summary-title"><strong>{project.name}</strong>{project.git?.branch && <span className="branch-chip"><GitBranch size={10} />{project.git.branch}</span>}{project.git?.detached && <span className="branch-chip muted">{project.git.head}</span>}</div>
        <div className="project-summary-path mono" title={project.root}>{project.displayRoot}</div>
      </div>
      <div className="project-summary-actions">
        <button className="icon-button small" title="刷新目录" aria-label="刷新目录" onClick={() => setRefreshCount((count) => count + 1)}><RefreshCw size={13} className={loading ? 'spinning' : ''} /></button>
        <button className="icon-button small" title="关闭当前项目" aria-label="关闭当前项目" onClick={onClear}><FolderX size={13} /></button>
        <button className="button outline small" onClick={onChangeDirectory}>更换目录</button>
      </div>
    </div>
    {error && <div className="error-banner">{error}</div>}
    <div className="file-tree" role="tree" aria-label="项目文件">
      {tree?.children?.length ? tree.children.map((child) => <TreeNode key={child.path} node={child} depth={0} markers={markers} />) : <div className="project-empty">{loading ? '正在读取目录…' : '目录为空，或文件都被忽略规则排除。'}</div>}
    </div>
  </div>;
}

function TreeNode({ node, depth, markers }: { node: ProjectNode; depth: number; markers: Set<string> }) {
  const [expanded, setExpanded] = useState(depth < 1);
  const isDirectory = node.kind === 'directory';
  const isMarker = depth === 0 && markers.has(node.name);
  const Icon = isDirectory ? (expanded ? FolderOpen : Folder) : CODE_EXTENSIONS.test(node.name) ? FileCode : TEXT_EXTENSIONS.test(node.name) ? FileText : File;
  return <div className="tree-node" role="treeitem" aria-expanded={isDirectory ? expanded : undefined}>
    <button className={`tree-row ${isDirectory ? 'directory' : ''} ${isMarker ? 'marker' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} title={node.path} onClick={() => isDirectory && setExpanded((value) => !value)}>
      <span className="tree-caret">{isDirectory && <ChevronRight size={11} className={expanded ? 'open' : ''} />}</span>
      <Icon size={13} className={`tree-icon ${isDirectory ? 'folder' : CODE_EXTENSIONS.test(node.name) ? 'code' : ''}`} />
      <span className="tree-name">{isDirectory ? `${node.name}/` : node.name}</span>
      {isMarker ? <small className="tree-tag">检测到</small> : node.kind === 'file' && node.size !== undefined && <small>{formatBytes(node.size)}</small>}
    </button>
    {expanded && node.children?.map((child) => <TreeNode key={child.path} node={child} depth={depth + 1} markers={markers} />)}
  </div>;
}

function formatBytes(size: number): string { return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`; }
