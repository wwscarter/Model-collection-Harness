# 文档索引

日常使用以根 README 和 CLI 文档为准；本轮完成状态以优化实施记录为准。outputs 内早期设计与历史验收按原路径保留，其中的版本、能力和待办描述代表记录当时的状态。

- [项目说明](../README.md)
- [CLI 使用说明](CLI.md)
- [离线评测说明](../eval/README.md)
- [版本变化](../CHANGELOG.md)
- [界面规范](../DESIGN_SYSTEM.md)

## 当前使用与本轮优化

- [24-PLAN-HIGH-PRIORITY.md](../outputs/24-PLAN-HIGH-PRIORITY.md)：高优先级改进方案：代码检索 · 命令沙箱 · 验证闭环
- [25-PLAN-MEDIUM-PRIORITY.md](../outputs/25-PLAN-MEDIUM-PRIORITY.md)：中优先级改进方案：Rules · Hooks · 扩展管理 · 统一调用通道 · 离线评测
- [26-PLAN-LOW-PRIORITY.md](../outputs/26-PLAN-LOW-PRIORITY.md)：低优先级改进方案：模块拆分 · 规划可视化 · CLI · 仓库整理
- [27-OPTIMIZATION-PROGRESS.md](../outputs/27-OPTIMIZATION-PROGRESS.md)：优化实施记录
- [28-CLEANUP-INVENTORY.md](../outputs/28-CLEANUP-INVENTORY.md)：仓库清理清单

## 原始架构与实现方案

- [归档方案概览](../outputs/00-ARCHIVED-OVERVIEW.md)：原 outputs/README.md 的完整方案内容。
- [01-ARCHITECTURE.md](../outputs/01-ARCHITECTURE.md)：多模型智能体桌面应用 (Agent Multi-Model Desktop, AMD)
- [02-QUICK-START.md](../outputs/02-QUICK-START.md)：AMD Agent - 快速开始指南
- [03-IMPLEMENTATION-ROADMAP.md](../outputs/03-IMPLEMENTATION-ROADMAP.md)：AMD Agent - 详细迭代计划与技术选型
- [04-PROJECT-SCAFFOLD.md](../outputs/04-PROJECT-SCAFFOLD.md)：AMD Agent - 可运行的项目脚手架
- [05-UI-ARCHITECTURE.md](../outputs/05-UI-ARCHITECTURE.md)：AMD Agent - 完整 UI 架构与前端实现
- [06-MODEL-MANAGEMENT.md](../outputs/06-MODEL-MANAGEMENT.md)：AMD Agent - 模型管理与切换交互细节
- [07-OUTPUT-FORMATTING.md](../outputs/07-OUTPUT-FORMATTING.md)：AMD Agent - 输出格式化与 Markdown 渲染
- [08-ELECTRON-INSTALL-DIAGNOSTICS.md](../outputs/08-ELECTRON-INSTALL-DIAGNOSTICS.md)：Electron 安装与发布诊断

## 核心实现与历史验收

- [09-PROJECT-REVIEW-2026-11-03.md](../outputs/09-PROJECT-REVIEW-2026-11-03.md)：项目整体审查（2026-11-03）
- [10-TOOL-CALLING-FIX-PLAN.md](../outputs/10-TOOL-CALLING-FIX-PLAN.md)：模型提示"没有联网 / 缺少工具"：排查结论与修复方案（2026-11-03）
- [11-PROJECT-AUDIT-2026-11-04.md](../outputs/11-PROJECT-AUDIT-2026-11-04.md)：newAi（AMD Agent）项目审计报告
- [12-PROJECT-AUDIT-VERIFICATION-2026-11-04.md](../outputs/12-PROJECT-AUDIT-VERIFICATION-2026-11-04.md)：newAi 审计复核与修复记录
- [13-NEXT-ITERATION-AGENT-DESIGN.md](../outputs/13-NEXT-ITERATION-AGENT-DESIGN.md)：下一阶段研究：多模型编排、上下文记忆/压缩、工具优化、路由规则与调用链
- [14-PHASE-0-5-IMPLEMENTATION.md](../outputs/14-PHASE-0-5-IMPLEMENTATION.md)：Phase 0–5 实施记录
- [15-PRODUCTION-POLISH.md](../outputs/15-PRODUCTION-POLISH.md)：生产化收尾记录：实时 Trace、记忆检索/自动提取、路由 UI 与编排抽取
- [16-FINAL-COMPLETION.md](../outputs/16-FINAL-COMPLETION.md)：最终收尾记录：RunCoordinator、Trace 设置、记忆审核、路由历史与打包冒烟
- [17-ROUTING-FORM-MEMORY-BATCH.md](../outputs/17-ROUTING-FORM-MEMORY-BATCH.md)：路由字段表单与记忆批量审核
- [18-DEEPSEEK-ORCHESTRATOR.md](../outputs/18-DEEPSEEK-ORCHESTRATOR.md)：DeepSeek 主调度与动态子智能体
- [19-DEEPSEEK-ORCHESTRATOR-TEST.md](../outputs/19-DEEPSEEK-ORCHESTRATOR-TEST.md)：DeepSeek 主调度 + 子智能体验证提示词

## 桌面界面与项目交互

- [20-UI-OVERHAUL.md](../outputs/20-UI-OVERHAUL.md)：UI 重构：导航、监测、过程态与权限
- [21-IMMERSIVE-WORKSPACE.md](../outputs/21-IMMERSIVE-WORKSPACE.md)：沉浸式工作台重构
- [22-PROGRESSIVE-PREVIEW.md](../outputs/22-PROGRESSIVE-PREVIEW.md)：渐进式文件预览
- [23-PROJECT-ASSOCIATION-FIXES.md](../outputs/23-PROJECT-ASSOCIATION-FIXES.md)：项目关联、配色、Git 检测与紧凑会话修复

## 路由、发布与其他验收记录

- [OLLAMA-ROUTING-DEPLOYMENT-AND-LEARNING-2026-11-05.md](../outputs/OLLAMA-ROUTING-DEPLOYMENT-AND-LEARNING-2026-11-05.md)：Ollama 路由、持续学习与发布方案
- [OLLAMA-ROUTING-FEASIBILITY-2026-11-05.md](../outputs/OLLAMA-ROUTING-FEASIBILITY-2026-11-05.md)：Ollama 路由集成可行性调研
- [OLLAMA-ROUTING-INTEGRATION-2026-11-05.md](../outputs/OLLAMA-ROUTING-INTEGRATION-2026-11-05.md)：Ollama 分类与模型分工首版接入
- [OLLAMA-ROUTING-LOCAL-BENCHMARK-2026-11-05.md](../outputs/OLLAMA-ROUTING-LOCAL-BENCHMARK-2026-11-05.md)：Ollama 本机路由实验记录
- [RELEASE-0.1.0-2026-11-05.md](../outputs/RELEASE-0.1.0-2026-11-05.md)：0.1.0 发布与系统主题验收
- [TRACE-BUDGET-FIX-2026-11-05.md](../outputs/TRACE-BUDGET-FIX-2026-11-05.md)：调用链 44421fc6：预算、实际模型与修复
- [full-review-2026-11-04.md](../outputs/full-review-2026-11-04.md)：全项目审查与功能优化记录
- [project-execution/QA.md](../outputs/project-execution/QA.md)：项目自动执行验收（0.0.2）
- [release-0.0.1/QA.md](../outputs/release-0.0.1/QA.md)：0.0.1 发布验收
- [settings-preview/QA.md](../outputs/settings-preview/QA.md)：设置与模型端点配置验收

## 本机材料

outputs 下的源代码备份 ZIP、dev-logs 开发会话日志和未纳入版本控制的验收图片保留在本机。日志位置与待确认清理范围见 [仓库清理清单](../outputs/28-CLEANUP-INVENTORY.md)。
