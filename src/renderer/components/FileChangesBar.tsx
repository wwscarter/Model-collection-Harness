import React, { useEffect, useState } from 'react';
import { Alert, Button, Drawer, Empty, List, Popconfirm, Space, Tag, Typography } from 'antd';
import type { FileChangeRecord, FileRestoreResult } from '../types';
import { errorMessage } from '../format';

interface FileChangesBarProps {
  sessionId: string;
  runId?: string;
  /** Hidden while the run is still writing files. */
  running?: boolean;
  /** A failed project check makes the rollback affordance more prominent. */
  verificationFailed?: boolean;
}

/**
 * Summarises the files one run wrote and offers a guarded rollback. Only
 * `write`/`edit` are recorded; files changed by commands are not listed.
 */
export function FileChangesBar({ sessionId, runId, running, verificationFailed }: FileChangesBarProps) {
  const [changes, setChanges] = useState<FileChangeRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FileRestoreResult>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setResult(undefined);
    setError(undefined);
    setOpen(false);
    if (!runId || running || !window.amd?.files) { setChanges([]); return; }
    let active = true;
    void window.amd.files.changes(runId)
      .then((next) => { if (active) setChanges(next); })
      .catch(() => { if (active) setChanges([]); });
    return () => { active = false; };
  }, [runId, running]);

  const pending = changes.filter((change) => !change.restoredAt);
  const unavailable = pending.filter((change) => change.existed && !change.beforeAvailable).length;

  const restore = async () => {
    if (!runId) return;
    setBusy(true);
    setError(undefined);
    try {
      const outcome = await window.amd!.files.restore(runId, sessionId);
      setResult(outcome);
      setChanges(await window.amd!.files.changes(runId));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!pending.length && !result && !error) return null;

  return <>
    {pending.length > 0 && <Alert
      className="file-changes-bar"
      style={{ marginTop: 12 }}
      type={verificationFailed ? 'warning' : 'info'}
      showIcon
      title={<Space size={8} wrap>
        <span>本轮修改了 {pending.length} 个文件{unavailable ? `（${unavailable} 个无快照）` : ''}</span>
        <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={() => setOpen(true)}>查看文件</Button>
        <Popconfirm
          title="撤销本轮文件修改？"
          description="恢复本轮开始前的内容。本轮之后又被修改的文件会跳过。"
          okText="撤销"
          cancelText="取消"
          onConfirm={() => void restore()}
        >
          <Button size="small" danger loading={busy}>撤销本轮修改</Button>
        </Popconfirm>
      </Space>}
    />}
    {error && <Alert style={{ marginTop: 8 }} type="error" showIcon closable={{ onClose: () => setError(undefined) }} title={error} />}
    {result && <Alert
      style={{ marginTop: 8 }}
      type={result.skipped.length ? 'warning' : 'success'}
      showIcon
      closable={{ onClose: () => setResult(undefined) }}
      title={`已撤销 ${result.restored.length} 个文件${result.skipped.length ? `，跳过 ${result.skipped.length} 个` : ''}`}
      description={result.skipped.length ? <ul style={{ margin: 0, paddingInlineStart: 18 }}>
        {result.skipped.map((item) => <li key={item.path}><Typography.Text code>{item.path}</Typography.Text>：{item.reason}</li>)}
      </ul> : undefined}
    />}
    <Drawer title="本轮文件修改" size={520} open={open} onClose={() => setOpen(false)}>
      {changes.length ? <List
        dataSource={changes}
        renderItem={(change) => <List.Item actions={[change.restoredAt
          ? <Tag color="green" key="done">已撤销</Tag>
          : change.existed && !change.beforeAvailable
            ? <Tag color="orange" key="unavailable">无快照</Tag>
            : <Tag color="blue" key="ready">{change.existed ? '修改' : '新建'}</Tag>]}>
          <List.Item.Meta
            title={<Typography.Text code style={{ wordBreak: 'break-all' }}>{change.relativePath}</Typography.Text>}
            description={change.existed ? '恢复为本轮开始前的内容' : '撤销时删除此文件'}
          />
        </List.Item>} />
        : <Empty description="本轮没有记录到文件修改" />}
    </Drawer>
  </>;
}
