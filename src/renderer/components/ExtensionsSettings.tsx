import React, { useRef, useState } from 'react';
import { Button } from 'antd';
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
import '../styles/extensions.css';

type ExtensionTab = 'rules' | 'hooks' | 'skills' | 'mcp' | 'toolTrust';
export function ExtensionsSettings({ rules, hooks, skills, mcp, toolTrust }: { rules?: RulesApi; hooks?: HooksApi; skills?: SkillsApi; mcp?: McpApi; toolTrust?: ToolTrustApi }) {
  const [tab, setTab] = useState<ExtensionTab>('rules');
  const tabRefs = useRef<Array<HTMLElement | null>>([]);
  const tabs: Array<[ExtensionTab, string]> = [['rules', '规则'], ['hooks', 'Hooks'], ['skills', '技能'], ['mcp', 'MCP 服务器'], ['toolTrust', '工具信任']];
  const content = tab === 'rules' && rules ? <RulesSettings api={rules} /> : tab === 'hooks' && hooks ? <HooksSettings api={hooks} />
    : tab === 'skills' && skills ? <SkillsSettings api={skills} /> : tab === 'mcp' && mcp ? <McpSettings api={mcp} />
      : tab === 'toolTrust' && toolTrust ? <ToolTrustSettings api={toolTrust} /> : <section className="runtime-card" role="alert">{tabs.find(([id]) => id === tab)?.[1]}管理接口尚未连接。</section>;
  const navigate = (event: React.KeyboardEvent, index: number) => {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setTab(tabs[next][0]);
    tabRefs.current[next]?.focus();
  };
  return <div className="extensions-settings">
    <div className="extensions-nav" role="tablist" aria-label="扩展分类">
      {tabs.map(([id, label], index) => <Button key={id} ref={(element) => { tabRefs.current[index] = element; }} type="text" autoInsertSpace={false} className={tab === id ? 'is-active' : ''} id={'extension-tab-' + id} role="tab" aria-selected={tab === id} aria-controls={'extension-panel-' + id} tabIndex={tab === id ? 0 : -1} onKeyDown={(event) => navigate(event, index)} onClick={() => setTab(id)}>{label}</Button>)}
    </div>
    <div key={tab} className="extensions-content" id={'extension-panel-' + tab} role="tabpanel" aria-labelledby={'extension-tab-' + tab} tabIndex={0}>{content}</div>
  </div>;
}
