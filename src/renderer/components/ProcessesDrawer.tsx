import React, { useEffect, useState } from 'react';
import { Alert, Badge, Button, Drawer, Empty, List, Popconfirm, Space, Tag, Typography } from 'antd';
import { RefreshCw, Square } from 'lucide-react';
import type { ProcessSummary } from '../types';
import { errorMessage } from '../format';

interface ProcessesDrawerProps {
  open: boolean;
  onClose: () => void;
  projectRoot?: string;
  /** Marks processes started by the current session. */
  sessionId?: string;
}

const STATUS: Record<ProcessSummary['status'], { label: string; color: string }> = {
  running: { label: '运行中', color: 'green' },
  completed: { label: '已完成', color: 'blue' },
  failed: { label: '失败', color: 'red' },
  stopped: { label: '已停止', color: 'default' },
};

const seconds = (value: number) => value < 1000 ? Math.round(value) + ' ms' : (value / 1000).toFixed(1) + ' s';

const trigger = (process: ProcessSummary) => {
  if (process.timedOut) return '超时停止';
  if (process.cancelled) return '已取消';
  if (process.error) return process.error;
  if (process.exitCode !== null) return '退出码 ' + process.exitCode;
  return undefined;
};

/** Lists processes started by the agent and stops them through the existing manager. */
export function ProcessesDrawer({ open, onClose, projectRoot, sessionId }: ProcessesDrawerProps) {
  const [processes, setProcesses] = useState<ProcessSummary[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const load = async () => {
      try {
        const next = await window.amd?.processes.list(projectRoot) ?? [];
        if (active) { setProcesses(next); setError(undefined); }
      } catch (cause) {
        if (active) setError(errorMessage(cause));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3_000);
    return () => { active = false; clearInterval(timer); };
  }, [open, projectRoot, tick]);

  const stop = async (process: ProcessSummary) => {
    setBusy(process.processId);
    try {
      await window.amd?.processes.stop(process.processId, projectRoot);
      setTick((value) => value + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const running = processes.filter((process) => process.running).length;
  return <Drawer
    title={<Space size={8}>后台进程<Badge count={running} size="small" color="green" /></Space>}
    size={560}
    open={open}
    onClose={onClose}
    extra={<Button size="small" icon={<RefreshCw size={13} />} onClick={() => setTick((value) => value + 1)}>刷新</Button>}
  >
    {error && <Alert style={{ marginBottom: 12 }} type="error" showIcon title={error} closable={{ onClose: () => setError(undefined) }} />}
    {processes.length ? <List
      dataSource={processes}
      renderItem={(process) => <List.Item actions={[process.running
        ? <Popconfirm key="stop" title="停止该进程？" description="会结束该命令及其子进程。" okText="停止" cancelText="取消" onConfirm={() => void stop(process)}>
            <Button size="small" danger loading={busy === process.processId} icon={<Square size={11} />}>停止</Button>
          </Popconfirm>
        : <Typography.Text key="idle" type="secondary">{seconds(process.durationMs)}</Typography.Text>]}>
        <List.Item.Meta
          title={<Space size={6} wrap>
            <Tag color={STATUS[process.status].color}>{STATUS[process.status].label}</Tag>
            {process.sessionId && process.sessionId === sessionId && <Tag color="blue">本会话</Tag>}
            <Typography.Text strong style={{ maxWidth: 320 }} ellipsis={{ tooltip: process.command }}>{process.command}</Typography.Text>
          </Space>}
          description={<Space orientation="vertical" size={2} style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>{process.cwd}</Typography.Text>
            <Space size={6} wrap>
              <Typography.Text code>{process.processId.slice(0, 8)}</Typography.Text>
              {!process.sandboxEnabled && <Tag>沙箱不可用</Tag>}
              {trigger(process) && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{trigger(process)}</Typography.Text>}
              {process.urls.map((url) => <Typography.Text key={url} code copyable={{ text: url }}>{url}</Typography.Text>)}
            </Space>
            {process.outputPreview.trim() && <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0, whiteSpace: 'pre-wrap' }} ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}>{process.outputPreview.trim()}</Typography.Paragraph>}
          </Space>}
        />
      </List.Item>}
    /> : <Empty description="当前没有由智能体启动的后台进程" />}
  </Drawer>;
}
