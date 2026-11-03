import React, { useEffect, useState } from 'react';
import { ChevronRight, File, FileCode, FileText, Folder, FolderOpen, GitBranch, RefreshCw, X } from 'lucide-react';
import type { ProjectInfo } from '../types';
import { errorMessage } from '../format';
import '../styles/inspector.css';

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
    setTree(undefined);
    setError(undefined);
    setLoading(false);
    if (!project) return;
    if (!window.amd) { setError('请在桌面应用中读取项目文件。'); return; }
    setLoading(true);
    window.amd.project.tree({ maxDepth: 5 })
      .then((result) => { if (active) setTree(result as ProjectNode); })
      .catch((cause) => { if (active) setError(errorMessage(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [project?.root, reloadKey, refreshCount]);

  if (!project) return <div className="inspector-project inspector-project-unbound">
    <div className="inspector-project-empty">
      <span className="inspector-empty-icon"><FolderOpen size={24} strokeWidth={1.35} /></span>
      <strong>打开你的工作项目</strong>
      <p>关联本地文件夹，查看文件结构，<br />为任务提供项目上下文。</p>
      <button type="button" className="inspector-open-project" onClick={onChangeDirectory}><FolderOpen size={13} />选择文件夹</button>
    </div>
    <div className="inspector-project-hint"><span />项目文件保留在本机</div>
  </div>;

  const markers = new Set(project.markers);
  const fileCount = tree ? countFiles(tree) : undefined;
  const branch = project.git?.branch || (project.git?.detached ? project.git.head : undefined);

  return <div className="inspector-project">
    <div className="inspector-project-card">
      <div className="inspector-project-card-top">
        <span className="inspector-project-icon"><Folder size={15} strokeWidth={1.7} /></span>
        <strong title={project.name}>{project.name}</strong>
        <button type="button" className="inspector-icon-button" title="刷新目录" aria-label="刷新目录" disabled={loading} onClick={() => setRefreshCount((count) => count + 1)}><RefreshCw size={13} className={loading ? 'spinning' : ''} /></button>
      </div>
      <div className="inspector-project-path" title={project.root}>{project.displayRoot}</div>
      <div className="inspector-project-card-bottom">
        {branch ? <span className={`inspector-branch ${project.git?.detached ? 'is-detached' : ''}`} title={project.git?.detached ? '分离的 HEAD' : '当前 Git 分支'}><GitBranch size={11} />{branch}</span> : <span className="inspector-local-label">本地项目</span>}
        <button type="button" className="inspector-change-project" onClick={onChangeDirectory}>更换目录</button>
        <button type="button" className="inspector-icon-button" title="关闭当前项目" aria-label="关闭当前项目" onClick={onClear}><X size={12} /></button>
      </div>
    </div>

    <div className="inspector-tree-heading"><span>工作区文件</span><small>{loading ? '读取中' : fileCount === undefined ? '—' : `${fileCount} 个可见文件`}</small></div>
    {error ? <div className="inspector-tree-error" role="alert"><strong>暂时无法读取目录</strong><span>{error}</span><button type="button" onClick={() => setRefreshCount((count) => count + 1)}><RefreshCw size={12} />重新读取</button></div> : <div className="inspector-file-tree" role="tree" aria-label="项目文件" aria-busy={loading}>
      {loading ? <div className="inspector-tree-loading" role="status" aria-label="正在读取目录">{[74, 90, 58, 80, 64, 86].map((width, index) => <div key={index}><span /><i style={{ width: `${width}%` }} /></div>)}</div> : tree?.children?.length ? tree.children.map((child) => <TreeNode key={child.path} node={child} depth={0} markers={markers} />) : <div className="inspector-tree-empty"><FolderOpen size={20} strokeWidth={1.4} /><strong>这里还没有可见文件</strong><span>目录为空，或文件已被忽略规则排除。</span></div>}
    </div>}
  </div>;
}

function TreeNode({ node, depth, markers }: { node: ProjectNode; depth: number; markers: Set<string> }) {
  const [expanded, setExpanded] = useState(depth < 1);
  const isDirectory = node.kind === 'directory';
  const isMarker = depth === 0 && markers.has(node.name);
  const isCode = CODE_EXTENSIONS.test(node.name);
  const Icon = isDirectory ? (expanded ? FolderOpen : Folder) : isCode ? FileCode : TEXT_EXTENSIONS.test(node.name) ? FileText : File;
  const rowContent = <>
    <span className="inspector-tree-caret">{isDirectory && <ChevronRight size={11} className={expanded ? 'is-open' : ''} />}</span>
    <Icon size={13} strokeWidth={1.6} className={`inspector-tree-icon ${isDirectory ? 'is-folder' : isCode ? 'is-code' : ''}`} />
    <span className="inspector-tree-name">{node.name}{isDirectory && '/'}</span>
    {isMarker ? <small className="inspector-tree-tag">检测到</small> : !isDirectory && node.size !== undefined && <small>{formatBytes(node.size)}</small>}
  </>;

  return <div className="inspector-tree-node" role="treeitem" aria-expanded={isDirectory ? expanded : undefined}>
    {isDirectory ? <button type="button" className={`inspector-tree-row is-directory ${isMarker ? 'is-marker' : ''}`} style={{ paddingLeft: 4 + depth * 13 }} title={node.path} onClick={() => setExpanded((value) => !value)} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); setExpanded(event.key === 'ArrowRight'); } }}>{rowContent}</button> : <div className={`inspector-tree-row ${isMarker ? 'is-marker' : ''}`} style={{ paddingLeft: 4 + depth * 13 }} title={node.path}>{rowContent}</div>}
    {expanded && node.children && <div role="group">{node.children.map((child) => <TreeNode key={child.path} node={child} depth={depth + 1} markers={markers} />)}</div>}
  </div>;
}

function countFiles(node: ProjectNode): number { return node.kind === 'file' ? 1 : (node.children ?? []).reduce((count, child) => count + countFiles(child), 0); }
function formatBytes(size: number): string { return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`; }
