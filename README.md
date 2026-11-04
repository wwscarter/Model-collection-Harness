# AMD Agent

AMD Agent 是一个以 Electron、React 和 TypeScript 实现的多模型智能体桌面应用。当前实现已经把模型配置、路由、流式执行、指标、项目上下文、受控命令执行和发布验证链路接通；含代码的回答会执行静态审计并写入哈希链与指标库。

当前修复构建版本为 `0.0.2`，已保留上一稳定基线标签 `0.0.1`。项目自动执行验收见 [创建并启动网页](outputs/project-execution/QA.md)，上一版本验收见 [0.0.1 发布记录](outputs/release-0.0.1/QA.md)。

## 当前能力

- 三栏桌面工作台（界面规范见 `DESIGN_SYSTEM.md`）：左侧「本地项目」与「最近会话」，中间任务对话，右侧项目文件树与运行详情；⌘N 新建会话，⌘K 搜索会话。
- 本地项目：在「新建项目」弹窗中选择文件夹，自动推断名称并读取 Git 分支和项目类型。最近打开的项目保存在 `projects.db`，只保存路径和名称；从列表移除不会删除文件。
- OpenAI、Anthropic、Google 统一调用接口；没有 API Key 的内置模型不会参与路由，也不会返回演示答案。自定义 OpenAI-compatible 本地服务可以按需不配置 Key。
- SQLite 持久化模型配置、会话历史与运行指标。
- API Key 使用 AES-256-GCM 加密；桌面端通过 Electron `safeStorage` 持久化加密密钥，避免重启后无法解密。
- 启发式路由：按任务类型、复杂度、能力评分、优先级和成本选择启用模型；高复杂度任务会将综合智能度纳入评分。
- 含代码的模型回答会执行确定性的静态代码审计，结果写入 `audit.jsonl` 哈希链和 `metrics.db`，监测面板显示“代码审计通过率”；纯文本回答不审计，也不增加额外模型调用或延迟。
- DeepSeek 主调度：当存在可用 DeepSeek 模型时，自动由 DeepSeek 生成 JSON 调度计划，按任务选择其它模型作为只读子智能体（最多 4 个），子任务完成后由 DeepSeek 汇总成最终回答；计划失败或没有 DeepSeek 时回退现有路由。调度模式支持 direct（DeepSeek 直接完成）、delegate（子智能体分工 + DeepSeek 汇总）和 verify（汇总后独立验证）。
- 高复杂度任务支持双模型协作：先由单独的推理模型生成计划，再由任务类型和能力评分选出的执行模型完成任务；低/中复杂度任务只调用一个执行模型。
- 调用链轨迹：每个用户 turn 有独立 `runId`，记录路由、上下文压缩、记忆检索、规划、模型尝试、工具、合成、审计和验证的父子 span；右侧“运行详情”实时展开时间线，支持 JSON 导出；启动时自动清理 30 天/1,000 条之外的 trace。
- 上下文压缩与长期记忆：按模型上下文预算装配历史，旧轮次生成增量摘要（可回退到确定性摘要），工具结果以 digest 进入后续上下文；长期记忆支持全局/项目范围、FTS5 检索、`remember`/`recall`/`forget` 工具、记忆面板、JSON 导出/清空，以及默认关闭的自动提取开关。自动提取的记忆进入待审核队列，可按条或批量通过/删除。
- 工具调用策略：每轮工具调用次数、总输出字符、单工具超时和结果截断；只读工具支持 TTL 缓存；新增 `process_list` 找回后台进程。
- 路由规则与配额：支持 `<userData>/routing-rules.json` 规则、右上角逐字段规则表单（任务类型/复杂度/关键词/主模型/策略/协作/fallback，可切回 JSON）、历史归档/恢复、模型 RPM/每日 Token 配额、凭据/上下文窗口过滤、`parallel` 自动协作、`escalate` 升级策略，以及执行阶段的 fallback 链。
- 独立验证：高复杂度代码任务默认使用第二个模型审计；发现 high/critical 问题时由执行模型修订一次，再记录静态审计结果。
- 模型设置、连接测试、输出复制和 Markdown 导出。
- 监测面板：运行轮次、成本、成功率、延迟、模型分布、成本趋势和 Markdown 报告。
- 自成长引擎：按实际路由出的任务类型记录成功与失败、成本、延迟、审计质量和用户评分，并动态调整路由权重。
- 本地终端会话：支持创建、输入、输出监听、调整尺寸和关闭；优先使用 node-pty，缺失时降级到子进程管道。
- 智能体内核：任务执行通过 [Pi SDK](https://pi.dev/)（`@earendil-works/pi-coding-agent`）完成工具调用循环、流式输出和多轮上下文。模型与密钥仍由 newAi 加密保存，每轮在内存中新建 Pi 会话，不读写 `~/.pi`。
- 内置工具：`web_search`（可插拔搜索后端，默认 Bing，免 Key）、`web_fetch`（公开网页）、`read` / `ls`（读取项目），以及选定项目后可用的 `write` / `edit`（创建与修改文件）、`run_command` / `process_status` / `process_list` / `stop_process`（执行命令、启动/查询/列出/停止后台服务）；长期记忆工具 `remember` / `recall` / `forget`。回答上方显示工具调用卡片并随会话保存，写入后自动刷新项目文件列表。
- 创建网页时，模型可以直接写入代码、启动服务、验证 HTTP 返回并报告访问地址。写入、编辑、执行命令及停止服务会展示确认框；命令的最终授权由主进程弹出原生确认框完成，渲染进程无法自行声明已批准。允许后由应用执行，无需手工复制代码或命令。命令以当前系统用户权限运行，以选定项目作为工作目录；工作目录限制不构成操作系统沙箱。
- 后台服务在单轮回复完成后继续运行，可在后续对话中要求查询或停止；退出应用会清理它启动的进程。普通命令支持取消、超时和有限日志。并行分析子模型保留只读工具，最终执行模型负责修改及执行。
- 执行期间可点击输入框右下角的停止按钮；取消或连接失败时保留已生成的回复及工具状态。每次智能体执行默认最多五分钟、八轮工具调用、20 次工具调用和 80k 字符模型可见工具输出；搜索每个后端主机最多等待十五秒。Bing 页面解析可能受网络或页面变化影响，失败会作为工具结果反馈给模型。
- 扩展点：skills 放在 `<userData>/agent/skills/`；`<userData>/agent/mcp.json` 存在时加载 MCP 服务器。内置读取工具和进程状态查询可直接调用，其他工具每次调用需要用户确认。项目内的 `AGENTS.md` 和 `.pi/` 不会被加载。
- 流式模型输出：执行模型由 Pi 流式返回；规划模型仍走原有适配层，网络流失败时回退到普通请求。
- 项目上下文：从只读选定工作区生成文件树和限额文本上下文，默认发送但可在输入框显式关闭；统一跳过二进制、`.env*`、`.npmrc`、`.netrc`、`credentials`、`.aws/`、`.git/` 等凭据与版本库元数据，并用 `<project_context untrusted="true">` 标注为不可信数据。
- 安全命令执行：必须选择项目并明确批准命令，执行范围固定在项目根目录，具备超时、取消、环境过滤和输出上限。

### 配置非官方或自托管模型

在设置弹窗中点击左侧“添加模型”，选择“兼容网关”“自建反代”或“本地 Ollama / vLLM 实例”，填写服务地址和 API Key（本地或免密服务可留空），再点击“获取模型”同步模型列表，或手动添加服务端提供的模型 ID。地址可以填写 `/v1` 基础地址，例如 `https://gateway.example/v1`，应用会自动请求 `/chat/completions`；也可以直接填写完整的 `.../chat/completions` endpoint。API 地址与 API Key 分开保存，因此没有 Key 的本地服务重启后仍会保留地址。

设置弹窗支持端点搜索、模型卡片与下拉选择、采样温度和 32k / 64k / 128k 上下文预设。温度范围为 0–1.5，Anthropic 为 0–1；DeepSeek 深度思考模式会发送 thinking 参数，开启时服务端忽略温度。高级配置保留自定义上下文长度、最大输出 Token、综合智能度、代码/推理/创意/视觉/长上下文能力评分、输入和输出价格、路由优先级及请求限额。API Key 使用 AES-256-GCM 加密后保存；自定义服务按 OpenAI-compatible Chat Completions 协议发送请求。

“连通测试”和“获取模型”使用当前表单中的地址、模型与新密钥；留空的密钥只在 scheme+host+port 未变化时复用已加密保存的凭据，修改端点域名后必须重新输入 Key。没有密钥的内置模型不会被标记为远程连接成功，也不会进入路由。点击“设为主力路由”并保存后，任务执行优先使用该模型；再次点击主力按钮并保存可恢复自动路由。主力选择与端点参数一起事务保存，失败时保留旧配置。取消或按 Esc 关闭会丢弃未保存的修改。

### 调用链、记忆与路由规则

- 调用链保存在 `metrics.db` 的 `runs`/`spans` 表；会话只保存最近一次 `runId`，重新打开会话会按该 ID 读取时间线。
- 上下文摘要保存在 `sessions.db` 的 summary 列；长期记忆保存在 `<userData>/memory.db`。记忆是用户数据，可从右上角“长期记忆”面板查看和删除；不会保存疑似 API Key/私钥的内容。
- 路由规则文件为 `<userData>/routing-rules.json`，示例：

```json
{
  "version": 1,
  "defaults": { "strategy": "single" },
  "rules": [
    {
      "id": "code-high",
      "enabled": true,
      "priority": 10,
      "when": { "taskTypes": ["code"], "complexity": ["high"] },
      "then": {
        "primaryModelId": "deepseek-chat",
        "strategy": "plan+verify",
        "fallbackModelIds": ["backup-model"]
      }
    }
  ]
}
```

规则只从已启用、有可用凭据、未超配额且满足上下文窗口的模型中选择；高复杂度代码在无规则时也默认进入 `plan+verify`。`parallel` 规则未指定协作者时会自动选择 2 个低成本可用模型；`escalate` 规则在验证发现问题时优先用 fallback 链中的更强模型修订。每次 run 的成本上限暂为 $0.25、时长上限 10 分钟，超出会中止并保留已有输出。

长期记忆的自动提取默认关闭，开启后会额外调用一个低成本模型；提取内容仍会经过密钥过滤，可在记忆面板中逐条删除或整体清空。

## 开发

需要 Node.js 22–24。Node.js 22 LTS 是推荐版本；Node.js 24 也受支持，项目安装脚本会绕过 Electron `extract-zip` 在部分 Node 24 环境中的解压卡死。

```bash
npm install
npm run dev
```

如果 Electron 启动时提示二进制安装不完整，先运行：

```bash
npm run doctor:electron
```

`doctor:electron` 会从 `@electron/get` 的校验缓存取得对应版本，并使用系统 `unzip` 恢复 Electron 可执行文件，安装后的 `postinstall` 会自动执行这一步。SQLite 使用 `better-sqlite3` 13 自带的 Node-API 原生模块，可供宿主 Node 与 Electron 共用，无需切换 ABI 或本机 C++ 编译。

生产构建：

```bash
npm run build
npm start
```

本机目录打包（不签名）使用：

```bash
npm run pack:dir
```

打包会先检查 Electron 二进制并编译应用代码；发布检查会在 Electron 中实际打开内存数据库，确认 SQLite 原生模块可用后才生成应用包。打包只包含 `dist/main`、`dist/preload` 和 `dist/renderer`，因此 `dist` 中已有的其他平台安装包不会被再次收入新包。

安装器目标已配置为 macOS `dmg`/`zip`、Linux `AppImage`/`deb` 和 Windows `nsis`/`zip`；跨平台构建需要在对应系统或 CI runner 上执行。

质量检查：

```bash
npm run lint
npm test
npm run test:coverage
npm run build
npm run smoke:renderer
npm run release:check
```

`smoke:renderer` 以隐藏窗口加载构建产物，验证 sandbox preload、CSP、window.amd/trace/memory 与根节点渲染；没有图形环境时需要 Xvfb 或本地桌面会话。

CI 见 `.github/workflows/ci.yml`：Node 22/24 上执行 `lint`、带阈值的全项目覆盖率测试和构建。覆盖率从 `src/**` 全量统计，不再只统计被测试加载过的模块。

首次打开应用后，在“模型与设置”中添加或编辑模型。内置提供商必须配置 API Key 才会参与路由；自定义 OpenAI-compatible 服务会按其 API 地址发起请求，API Key 可留空。应用会把数据库保存到 Electron 的用户数据目录，密钥包装文件名为 `credentials.key`。如果系统密钥库不可用，应用仍会启动并提示受影响的模型；可设置 `AMD_ENCRYPTION_KEY`（64 位 hex 或 base64 的 32 字节密钥）作为恢复路径。

## 目录

- `src/main`：Electron 主进程、IPC 和应用生命周期。
- `src/preload`：安全的 context bridge。
- `src/core/models`：模型类型、注册表和预置配置。
- `src/core/storage`：SQLite 模型持久化和凭据加密。
- `src/core/routing`：本地轻量分类器和启发式路由；没有 GGUF 或本地推理运行时时自动使用确定性 fallback。
- `src/core/project`：项目目录扫描、忽略规则、文本提取和上下文预算。
- `src/core/context`：上下文装配、token 预算、确定性摘要和 LLM checkpoint。
- `src/core/memory`：长期记忆 SQLite 存储与检索。
- `src/core/trace`：run/span 调用链类型与记录器。
- `src/core/providers`：统一模型调用适配层。
- `src/core/agent`：Pi SDK 接入（模型映射、系统提示词、`AgentRuntime`）。
- `src/core/tools`：内置工具与可插拔搜索后端（`search/`）。
- `src/core/observability`：调用、Token、成本和延迟指标。
- `src/core/audit`：独立模型审计、本地静态 fallback 和只追加哈希链日志。
- `src/core/growth`：性能档案与滑动平均反馈学习。
- `src/core/tty`：终端会话生命周期管理。
- `src/renderer`：React 工作台和设置页面。
- `test/unit`：加密、重启持久化和注册表测试。

项目文档仍保存在 `outputs/`，其中 [Electron 安装诊断](outputs/08-ELECTRON-INSTALL-DIAGNOSTICS.md) 记录了二进制解压卡死、原生 ABI 和发布验证的处理方式。
