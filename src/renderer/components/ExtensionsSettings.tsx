import React, { useState } from 'react';
import { RulesSettings } from './RulesSettings';
import { HooksSettings } from './HooksSettings';
import type { RulesApi } from '../rulesTypes';
import type { HooksApi } from '../hooksTypes';

export function ExtensionsSettings({ rules, hooks }: { rules?: RulesApi; hooks?: HooksApi }) {
  const [tab, setTab] = useState<'rules' | 'hooks'>('rules');
  return <div className="runtime-settings">
    <div className="routing-config-footer" role="tablist" aria-label="扩展分类">
      <button type="button" className={'button small ' + (tab === 'rules' ? 'primary' : 'outline')} role="tab" aria-selected={tab === 'rules'} onClick={() => setTab('rules')}>规则</button>
      <button type="button" className={'button small ' + (tab === 'hooks' ? 'primary' : 'outline')} role="tab" aria-selected={tab === 'hooks'} onClick={() => setTab('hooks')}>Hooks</button>
    </div>
    {tab === 'rules' ? rules ? <RulesSettings api={rules} /> : <section className="runtime-card" role="alert">规则管理接口尚未连接。</section>
      : hooks ? <HooksSettings api={hooks} /> : <section className="runtime-card" role="alert">Hooks 管理接口尚未连接。</section>}
  </div>;
}
