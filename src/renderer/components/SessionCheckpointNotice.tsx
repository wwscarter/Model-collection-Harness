import React, { useEffect, useState } from 'react';
import { Alert, Button, Typography } from 'antd';
import type { RunCheckpoint } from '../types';

/** Tells the user that the last run stopped mid-way instead of silently looking finished. */
export function SessionCheckpointNotice({ sessionId }: { sessionId?: string }) {
  const [checkpoint, setCheckpoint] = useState<RunCheckpoint>();
  useEffect(() => {
    setCheckpoint(undefined);
    if (!sessionId || !window.amd?.checkpoints) return;
    let active = true;
    void window.amd.checkpoints.latest(sessionId)
      .then((value) => { if (active && value?.status === 'interrupted') setCheckpoint(value); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [sessionId]);
  if (!checkpoint) return null;
  const dismiss = () => {
    setCheckpoint(undefined);
    void window.amd?.checkpoints?.acknowledge(checkpoint.runId).catch(() => undefined);
  };
  const files = checkpoint.modifiedFiles.slice(0, 5);
  return <Alert
    style={{ marginTop: 12 }}
    type="warning"
    showIcon
    closable={{ onClose: dismiss }}
    title={`上次任务在 ${checkpoint.toolCalls} 次工具操作后中断`}
    description={<>
      <Typography.Text type="secondary">
        {checkpoint.modifiedFiles.length ? `已修改 ${checkpoint.modifiedFiles.length} 个文件：${files.join('、')}${checkpoint.modifiedFiles.length > files.length ? '…' : ''}` : '中断前没有写入文件。'}
        {checkpoint.lastTool ? ` 最后执行：${checkpoint.lastTool}。` : ''}
        本轮结果未完成，可根据需要重新发起任务；系统不会自动重放。
      </Typography.Text>
    </>}
    action={<Button size="small" onClick={dismiss}>知道了</Button>}
  />;
}
