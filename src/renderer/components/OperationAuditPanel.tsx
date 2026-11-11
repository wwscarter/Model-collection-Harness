import React, { useEffect, useState } from 'react';
import { Alert, Button, Drawer, Select, Space, Table, Tag, Typography } from 'antd';
import { RefreshCw, ScrollText } from 'lucide-react';
import type { OperationAuditEntry } from '../types';
import { errorMessage } from '../format';

const TYPE_LABEL: Record<OperationAuditEntry['type'], string> = {
  'file.write': '文件写入',
  'command.execute': '命令执行',
  'process.stop': '停止进程',
};
const RESULT_COLOR: Record<OperationAuditEntry['result'], string> = { success: 'green', failed: 'red', stopped: 'default' };
const RESULT_LABEL: Record<OperationAuditEntry['result'], string> = { success: '成功', failed: '失败', stopped: '已停止' };

/** Read-only trail of what the agent or the user changed in the project. */
export function OperationAuditPanel() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<OperationAuditEntry[]>([]);
  const [type, setType] = useState<'all' | OperationAuditEntry['type']>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const load = async () => {
    setLoading(true);
    try {
      setEntries(await window.amd?.operationAudit(200) ?? []);
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (open) void load(); }, [open]);

  const filtered = type === 'all' ? entries : entries.filter((entry) => entry.type === type);
  const columns = [
    { title: '时间', dataIndex: 'timestamp', width: 160, render: (value: string) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{new Date(value).toLocaleString()}</Typography.Text> },
    { title: '类型', dataIndex: 'type', width: 100, render: (value: OperationAuditEntry['type']) => <Tag>{TYPE_LABEL[value]}</Tag> },
    { title: '发起方', dataIndex: 'actor', width: 80, render: (value: string) => value === 'agent' ? '智能体' : '用户' },
    {
      title: '对象', key: 'target',
      render: (_: unknown, entry: OperationAuditEntry) => entry.path
        ? <Typography.Text code style={{ wordBreak: 'break-all' }}>{entry.path}</Typography.Text>
        : <Typography.Text code style={{ wordBreak: 'break-all' }}>{entry.command ?? entry.detail ?? '—'}</Typography.Text>,
    },
    { title: '结果', dataIndex: 'result', width: 90, render: (value: OperationAuditEntry['result']) => <Tag color={RESULT_COLOR[value]}>{RESULT_LABEL[value]}</Tag> },
  ];

  return <>
    <Button type="text" icon={<ScrollText size={15} />} onClick={() => setOpen(true)}>操作审计</Button>
    <Drawer
      title="操作审计"
      size={780}
      open={open}
      onClose={() => setOpen(false)}
      extra={<Space>
        <Button size="small" icon={<RefreshCw size={13} />} loading={loading} onClick={() => void load()}>刷新</Button>
        <Button size="small" disabled={!filtered.length} onClick={() => void navigator.clipboard?.writeText(JSON.stringify(filtered, null, 2))}>复制 JSON</Button>
      </Space>}
    >
      {error && <Alert style={{ marginBottom: 12 }} type="error" showIcon title={error} closable={{ onClose: () => setError(undefined) }} />}
      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          aria-label="筛选操作类型"
          value={type}
          onChange={setType}
          style={{ width: 160 }}
          options={[{ value: 'all', label: '全部类型' }, ...Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }))]}
        />
        <Typography.Text type="secondary">最近 {entries.length} 条记录；日志保留 30 天。</Typography.Text>
      </Space>
      <Table
        size="small"
        rowKey="sequence"
        loading={loading}
        dataSource={filtered}
        columns={columns}
        pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }}
        locale={{ emptyText: '还没有操作记录' }}
      />
    </Drawer>
  </>;
}
