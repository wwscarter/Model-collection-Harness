import React, { useEffect, useRef, useState } from 'react';

interface TerminalPanelProps { onClose: () => void; }

export function TerminalPanel({ onClose }: TerminalPanelProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [command, setCommand] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [safeCommand, setSafeCommand] = useState('');
  const [safeResult, setSafeResult] = useState<string | null>(null);
  const [safeRunning, setSafeRunning] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const sessionRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        if (!window.amd?.tty) throw new Error('终端接口尚未连接');
        const session = await window.amd.tty.create({ cols: 110, rows: 32 }) as { id: string };
        if (!active) { await window.amd.tty.close(session.id); return; }
        setSessionId(session.id);
        sessionRef.current = session.id;
        unsubscribe = window.amd.on('tty:data', (payload) => {
          const event = payload as { sessionId?: string; data?: string };
          if (event.sessionId === session.id && event.data) setOutput((current) => `${current}${event.data}`.slice(-30000));
        });
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
    })();
    void window.amd?.project.current().then((project) => setProjectRoot(project?.root ?? null)).catch(() => setProjectRoot(null));
    return () => { active = false; unsubscribe?.(); if (sessionRef.current && window.amd?.tty) void window.amd.tty.close(sessionRef.current).catch(() => undefined); };
  }, []);

  useEffect(() => { outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight }); }, [output]);
  const send = async () => { if (!command || !sessionId || !window.amd?.tty) return; await window.amd.tty.write(sessionId, `${command}\n`); setCommand(''); };
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
  const close = async () => { if (sessionId && window.amd?.tty) await window.amd.tty.close(sessionId); onClose(); };

  return <div className="terminal-overlay"><section className="terminal-window"><header><div><div className="eyebrow">LOCAL TERMINAL</div><h2>终端会话</h2></div><button className="close-button" onClick={() => void close()}>×</button></header><pre ref={outputRef} className="terminal-output">{error ? `终端启动失败：${error}` : output || '正在启动终端…'}</pre><footer className="terminal-input"><span>›</span><input autoFocus value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void send(); }} placeholder="交互终端（手动输入）" disabled={!sessionId} /><button onClick={() => void send()} disabled={!sessionId || !command}>发送</button></footer><section className="sandbox-command"><div><strong>安全执行</strong><span>命令会在原生确认框中显示完整内容，并且只允许在当前项目内运行</span></div><div className="sandbox-project-root" title={projectRoot ?? undefined}>{projectRoot ? `项目：${projectRoot}` : '尚未选择项目'}</div><div className="sandbox-command-row"><input value={safeCommand} onChange={(event) => setSafeCommand(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runSafeCommand(); }} placeholder="待审核命令，例如 npm test" /><button onClick={() => void runSafeCommand()} disabled={safeRunning || !projectRoot || !safeCommand.trim()}>{safeRunning ? '执行中…' : '审核并执行'}</button></div>{safeResult && <pre>{safeResult}</pre>}</section></section></div>;
}
