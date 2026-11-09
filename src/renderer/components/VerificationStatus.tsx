import React from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import type { SessionVerificationEvent } from '../verificationTypes';

export function VerificationStatus({ event }: { event?: SessionVerificationEvent }) {
  if (!event) return null;
  const active = event.phase !== 'completed';
  const label = event.phase === 'checking' ? '正在运行项目检查…'
    : event.phase === 'repair' ? '验证未通过，正在修复…'
    : ({ passed: '验证通过', failed: '验证未通过', unverified: '尚未完成验证', skipped: '本轮未执行验证', cancelled: '验证已取消', budget_limit: '验证因预算停止' })[event.status ?? 'unverified'];
  return <div className="runtime-notice" role="status" aria-label="项目验证状态">
    {active ? <LoaderCircle size={14} className="spinning" /> : event.status === 'passed' ? <Check size={14} /> : null}
    <span>{label}{event.summary && <small> · {event.summary}</small>}</span>
  </div>;
}
