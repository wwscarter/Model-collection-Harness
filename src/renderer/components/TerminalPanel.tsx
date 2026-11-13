import React, { useEffect, useState } from 'react';

interface TerminalPanelProps { onClose: () => void; }

export function TerminalPanel({ onClose }: TerminalPanelProps) {
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [safeCommand, setSafeCommand] = useState('');
  const [safeResult, setSafeResult] = useState<string | null>(null);
  const [safeRunning, setSafeRunning] = useState(false);
  useEffect(() => {
    let active = true;
    void window.amd?.project.current().then((project) => { if (active) setProjectRoot(project?.root ?? null); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  const runSafeCommand = async () => {
    if (safeRunning || !safeCommand.trim() || !window.amd?.execution) return;
    if (!projectRoot) { setSafeResult('请先在左侧选择项目；安全执行只允许在项目目录内运行。'); return; }
    setSafeRunning(true); setSafeResult(null);
    try {
      // The main process shows a native confirmation dialog and ignores any
      // approval flag from the renderer.
      const result = await window.amd.execution.run({ command: safeCommand, timeoutMs: 30_000, maxOutputBytes: 200_000 });
      setSafeResult(`${result.output}${result.truncated ? '\n[输出已截断]' : ''}${result.timedOut ? '\n[命令超时]' : ''}${result.cancelled ? '\n[命令已取消]' : ''}\n退出码：${result.exitCode ?? '未知'}`);
    } catch (cause) { setSafeResult(`执行失败：${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setSafeRunning(false); }
  };
  return <div className="terminal-overlay"><section className="terminal-window"><header><h2>项目命令</h2><button className="close-button" onClick={onClose}>×</button></header><section className="sandbox-command"><div><strong>安全执行</strong><span>命令会在原生确认框中显示完整内容，并且只允许在当前项目内运行</span></div><div className="sandbox-project-root" title={projectRoot ?? undefined}>{projectRoot ? `项目：${projectRoot}` : '尚未选择项目'}</div><div className="sandbox-command-row"><input value={safeCommand} onChange={(event) => setSafeCommand(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runSafeCommand(); }} placeholder="待审核命令，例如 npm test" /><button onClick={() => void runSafeCommand()} disabled={safeRunning || !projectRoot || !safeCommand.trim()}>{safeRunning ? '执行中…' : '审核并执行'}</button></div>{safeResult && <pre>{safeResult}</pre>}</section></section></div>;
}
