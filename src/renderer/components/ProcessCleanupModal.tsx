import React, { useState } from 'react';
import { Alert, Modal, Typography } from 'antd';
import type { ProcessSummary } from '../types';
import { errorMessage } from '../format';

interface ProcessCleanupModalProps {
  /** Running processes started by the session that was just cancelled. */
  processes: ProcessSummary[];
  onClose: () => void;
}

/**
 * Cancelling a run stops the agent loop but, by design, leaves background
 * services running. Ask once instead of either leaking them silently or
 * killing a dev server the user wanted to keep.
 */
export function ProcessCleanupModal({ processes, onClose }: ProcessCleanupModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const stopAll = async () => {
    setBusy(true);
    setError(undefined);
    const results = await Promise.allSettled(processes.map((process) => window.amd?.processes.stop(process.processId, process.cwd)));
    setBusy(false);
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length) {
      setError(`有 ${failed.length} 个进程未能停止：` + errorMessage((failed[0] as PromiseRejectedResult).reason));
      return;
    }
    onClose();
  };

  return <Modal
    open={processes.length > 0}
    title={`本会话还有 ${processes.length} 个后台进程`}
    okText="停止全部"
    cancelText="保留运行"
    okButtonProps={{ danger: true }}
    confirmLoading={busy}
    onOk={() => void stopAll()}
    onCancel={onClose}
    destroyOnHidden
  >
    <Typography.Paragraph type="secondary">本次任务已停止，但它启动的服务仍在后台运行。停止会结束这些命令及其子进程；保留后可在输入栏的「进程」中随时管理。</Typography.Paragraph>
    {processes.map((process) => <Typography.Paragraph key={process.processId} style={{ marginBottom: 4 }} ellipsis={{ tooltip: process.command }}>
      <Typography.Text code>{process.command}</Typography.Text>
    </Typography.Paragraph>)}
    {error && <Alert style={{ marginTop: 12 }} type="error" showIcon title={error} />}
  </Modal>;
}
