import React, { useState } from 'react';
import { RulesSettings } from './RulesSettings';
import { HooksSettings } from './HooksSettings';
import { SkillsSettings } from './SkillsSettings';
import { McpSettings } from './McpSettings';
import { ToolTrustSettings } from './ToolTrustSettings';
import type { RulesApi } from '../rulesTypes';
import type { HooksApi } from '../hooksTypes';
import type { SkillsApi } from '../skillsTypes';
import type { McpApi } from '../mcpTypes';
import type { ToolTrustApi } from '../toolTrustTypes';

type ExtensionTab = 'rules' | 'hooks' | 'skills' | 'mcp' | 'toolTrust';
export function ExtensionsSettings({ rules, hooks, skills, mcp, toolTrust }: { rules?: RulesApi; hooks?: HooksApi; skills?: SkillsApi; mcp?: McpApi; toolTrust?: ToolTrustApi }) {
  const [tab, setTab] = useState<ExtensionTab>('rules');
  const tabs: Array<[ExtensionTab, string]> = [['rules', '规则'], ['hooks', 'Hooks'], ['skills', '技能'], ['mcp', 'MCP 服务器'], ['toolTrust', '工具信任']];
  const content = tab === 'rules' && rules ? <RulesSettings api={rules} /> : tab === 'hooks' && hooks ? <HooksSettings api={hooks} />
    : tab === 'skills' && skills ? <SkillsSettings api={skills} /> : tab === 'mcp' && mcp ? <McpSettings api={mcp} />
      : tab === 'toolTrust' && toolTrust ? <ToolTrustSettings api={toolTrust} /> : <section className="runtime-card" role="alert">{tabs.find(([id]) => id === tab)?.[1]}管理接口尚未连接。</section>;
  return <div className="runtime-settings">
    <div className="routing-config-footer" role="tablist" aria-label="扩展分类">
      {tabs.map(([id, label]) => <button key={id} type="button" className={'button small ' + (tab === id ? 'primary' : 'outline')} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}
    </div>
    {content}
  </div>;
}
