# AMD Agent

AMD Agent 是一个以 Electron、React 和 TypeScript 实现的多模型智能体桌面应用。当前实现已经把模型配置、路由、流式执行、指标、项目上下文、受控命令执行和发布验证链路接通；审计核心与哈希链已保留，项目源码审计入口按显式操作接入。

## 当前能力

- 三栏桌面工作台（界面规范见 `DESIGN_SYSTEM.md`）：左侧「本地项目」与「最近会话」，中间任务对话，右侧项目文件树与运行详情；⌘N 新建会话，⌘K 搜索会话。
- 本地项目：在「新建项目」弹窗中选择文件夹，自动推断名称并读取 Git 分支和项目类型。最近打开的项目保存在 `projects.db`，只保存路径和名称；从列表移除不会删除文件。
- OpenAI、Anthropic、Google 统一调用接口；这些内置提供商没有 API Key 时自动使用本地演示响应，方便先验证界面和链路。自定义 OpenAI-compatible 服务可以按需不配置 Key。
- SQLite 持久化模型配置、会话历史与运行指标。
- API Key 使用 AES-256-GCM 加密；桌面端通过 Electron `safeStorage` 持久化加密密钥，避免重启后无法解密。
- 启发式路由：按任务类型、复杂度、能力评分、优先级和成本选择启用模型；高复杂度任务会将综合智能度纳入评分。
- 项目代码审计模块和哈希链仍保留在核心层；普通对话不会审计用户提示词或模型回答，也不会延迟回答。项目级审计入口尚未接入工作台。
- 高复杂度任务支持双模型协作：先由单独的推理模型生成计划，再由任务类型和能力评分选出的执行模型完成任务；低/中复杂度任务只调用一个执行模型。
- 模型设置、连接测试、输出复制和 Markdown 导出。
- 监测面板：任务数、成本、成功率、延迟、模型分布、成本趋势和 Markdown 报告。
- 自成长引擎：按任务类型记录模型成功率、成本、延迟、审计质量和用户评分，并动态调整路由权重。
- 本地终端会话：支持创建、输入、输出监听、调整尺寸和关闭；优先使用 node-pty，缺失时降级到子进程管道。
- 流式模型输出：OpenAI、Anthropic、Google 和演示模型支持 SSE/分块响应；网络流失败时自动回退到普通请求。
- 项目上下文：从只读选定工作区生成文件树和限额文本上下文，跳过二进制、凭据文件、依赖目录和 `.gitignore` 命中路径。
- 安全命令执行：必须选择项目并明确批准命令，执行范围固定在项目根目录，具备超时、取消、环境过滤和输出上限。

### 配置非官方或自托管模型

在“模型与连接”中点击“添加模型”，选择“自定义（OpenAI 兼容）”，填写服务地址、模型 ID 和 API Key（如果服务通过内网、网关或其他方式认证，可以留空）。地址可以填写 `/v1` 基础地址，例如 `https://gateway.example/v1`，应用会自动请求 `/chat/completions`；也可以直接填写完整的 `.../chat/completions` endpoint。API 地址与 API Key 分开保存，因此没有 Key 的本地服务重启后仍会保留地址。

同一个表单还可以设置上下文长度、最大输出 Token、综合智能度、代码/推理/创意/视觉/长上下文能力评分、输入和输出价格、路由优先级、每分钟请求数及每日 Token 限额。API Key 使用 AES-256-GCM 加密后保存；自定义服务按 OpenAI-compatible Chat Completions 协议发送请求。

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
npm run release:check
```

首次打开应用后，在“模型与设置”中添加或编辑模型。内置提供商没有 API Key 的模型仍可执行演示任务；自定义 OpenAI-compatible 服务会按其 API 地址发起请求，API Key 可留空。应用会把数据库保存到 Electron 的用户数据目录，密钥包装文件名为 `credentials.key`。

## 目录

- `src/main`：Electron 主进程、IPC 和应用生命周期。
- `src/preload`：安全的 context bridge。
- `src/core/models`：模型类型、注册表和预置配置。
- `src/core/storage`：SQLite 模型持久化和凭据加密。
- `src/core/routing`：本地轻量分类器和启发式路由；没有 GGUF 或本地推理运行时时自动使用确定性 fallback。
- `src/core/project`：项目目录扫描、忽略规则、文本提取和上下文预算。
- `src/core/providers`：统一模型调用适配层。
- `src/core/observability`：调用、Token、成本和延迟指标。
- `src/core/audit`：独立模型审计、本地静态 fallback 和只追加哈希链日志。
- `src/core/growth`：性能档案与滑动平均反馈学习。
- `src/core/tty`：终端会话生命周期管理。
- `src/renderer`：React 工作台和设置页面。
- `test/unit`：加密、重启持久化和注册表测试。

项目文档仍保存在 `outputs/`，其中 [Electron 安装诊断](outputs/08-ELECTRON-INSTALL-DIAGNOSTICS.md) 记录了二进制解压卡死、原生 ABI 和发布验证的处理方式。
