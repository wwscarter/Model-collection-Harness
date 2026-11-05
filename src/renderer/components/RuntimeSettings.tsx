import React, { useEffect, useState } from 'react';
import { Check, Palette, Route, ShieldCheck } from 'lucide-react';
import { errorMessage } from '../format';
import { ModelRoutingSettings } from './ModelRoutingSettings';
import type { RoutingClassifierStatus } from '@core/routing/LocalRoutingModel';

type ApprovalMode = 'ask' | 'auto' | 'full';
interface RuntimeSettingsProps { onOpenRouting: () => void; onRoutingStatusChange?: (status: RoutingClassifierStatus) => void; }

const modes: Array<{ id: ApprovalMode; title: string; detail: string }> = [
  { id: 'ask', title: '请求批准', detail: '每次写入、编辑或执行命令都会弹出系统确认。' },
  { id: 'auto', title: '帮我批准', detail: '自动批准常规项目操作；危险命令仍会确认。' },
  { id: 'full', title: '完全控制', detail: '不再弹出工具/命令确认；项目读写边界仍然保留。' },
];

export function RuntimeSettings({ onOpenRouting, onRoutingStatusChange }: RuntimeSettingsProps) {
  const [mode, setMode] = useState<ApprovalMode>('ask');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    void window.amd?.preferences?.get().then((value) => setMode(value.approvalMode)).catch(() => undefined);
  }, []);
  const choose = async (next: ApprovalMode) => {
    setBusy(true); setNotice(undefined);
    try {
      if (!window.amd?.preferences) throw new Error('运行设置接口尚未连接');
      const saved = await window.amd.preferences.set({ approvalMode: next });
      setMode(saved.approvalMode); setNotice('权限模式已保存。');
    }
    catch (cause) { setNotice(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  return <div className="runtime-settings">
    <section className="runtime-card">
      <div className="runtime-card-heading"><span className="runtime-card-icon"><ShieldCheck size={16} /></span><div><h3>执行权限</h3><p>控制智能体写入文件、编辑文件和执行命令前的确认方式。</p></div></div>
      <div className="permission-modes" role="radiogroup" aria-label="执行权限">
        {modes.map((item) => <button key={item.id} className={'permission-mode ' + (mode === item.id ? 'is-selected' : '')} role="radio" aria-checked={mode === item.id} disabled={busy} onClick={() => void choose(item.id)}>
          <span className="permission-mode-check">{mode === item.id && <Check size={12} />}</span>
          <span><strong>{item.title}</strong><small>{item.detail}</small></span>
        </button>)}
      </div>
      <p className="runtime-hint">完全控制只关闭确认弹窗，不会扩大项目目录之外的文件访问范围。</p>
      {notice && <div className="runtime-notice" role="status">{notice}</div>}
    </section>
    <ModelRoutingSettings onRoutingStatusChange={onRoutingStatusChange} />
    <section className="runtime-card">
      <div className="runtime-card-heading"><span className="runtime-card-icon"><Route size={16} /></span><div><h3>路由规则</h3><p>配置任务类型、复杂度、主模型、fallback、协作模型和升级策略。</p></div><button className="button outline" onClick={onOpenRouting}>打开路由规则</button></div>
    </section>
    <section className="runtime-card">
      <div className="runtime-card-heading"><span className="runtime-card-icon"><Palette size={16} /></span><div><h3>外观</h3><p>跟随系统切换明暗主题：白天白底黑字，夜间黑底白字；界面仅图标保留强调色。</p></div></div>
    </section>
    <section className="runtime-card muted-card">
      <div><h3>长期记忆</h3><p>长期记忆用于跨会话保存偏好和项目事实。当前版本暂时隐藏该入口，已有记忆仍保存在本机。</p></div>
    </section>
  </div>;
}
