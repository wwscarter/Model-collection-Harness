# NewAi 命令行

CLI 使用与桌面端相同的运行协调器、项目工具、规则、Hooks、验证、计划、模型路由和 trace；运行它不需要启动 Electron。需要 Node.js 22–24。

## 构建与启动

在仓库根目录执行：

    npm install
    npm run build:cli
    node dist/cli/newai.mjs --help

构建还会生成相邻的 index-worker.js 和 symbol-extractor.js，供代码索引使用。安装或链接 npm 包后可直接使用 newai 命令。

    newai models list
    newai run "说明项目入口" --project . --model stored-model-id
    newai trace show run-id --json

--model 指 NewAi 配置记录的 id，可从 models list 获取；上游 API 的模型名是记录中的 modelId，两者可以不同。

## 独立模型和数据

默认数据目录为 ~/.newai，与桌面端隔离。--data-dir 可指定其他目录。独立运行可通过环境变量提供一个临时模型，不写入模型凭据存储：

    export NEWAI_MODEL_ID='上游模型名'
    export NEWAI_BASE_URL='https://你的兼容端点/v1'
    export NEWAI_API_KEY='你的API密钥'
    newai run "说明项目入口" --project .

临时模型的配置 id 固定为 environment-model；可显式传 --model environment-model。NEWAI_PROVIDER 可选 openai、anthropic、google、deepseek 或 custom；提供 BASE_URL 时默认 custom，否则默认 openai。官方提供方需要 API Key；custom 允许无密钥的本地服务。

可设置 NEWAI_INPUT_COST_PER_1K、NEWAI_OUTPUT_COST_PER_1K，填入每千输入/输出 token 的费用估算。未配置价格时普通运行记账值为零，不代表服务免费；评测报告将缺少价格的临时模型费用标为未知。估算不会取代提供方账单。

要共享桌面端已有数据，用 --data-dir 指向其用户数据目录，并在两端使用相同的 AMD_ENCRYPTION_KEY。该变量必须是 32 字节密钥的 64 位 hex 或 base64 编码。桌面端原先由 safeStorage 包装的 credentials.key 不能直接由 Node CLI 解开；切换到环境密钥后，需要在桌面端重新输入原凭据。CLI 不会生成随机恢复密钥或读取 ~/.pi。

## 审批、规划与取消

--approval ask|auto|full 与桌面端的三档权限一致，默认 ask。确认通过终端的 y/N 提示完成；没有交互终端时默认拒绝。--yes 显式允许本次调用中需要确认的请求。命令继续使用平台命令沙箱和工具信任设置。

    newai run "完成任务" --project . --planning confirm
    newai run "只生成实施计划" --project . --planning only

--planning auto|confirm|only 控制计划展示和确认。CLI 的确认模式提供执行或取消；计划编辑可在桌面端完成。计划历史保存到所选数据目录的 sessions.db。

Ctrl+C 取消模型、工具和检查；CLI 等待运行收尾并关闭托管后台进程。正常结束返回 0，执行失败或预算/工具额度耗尽返回 1，收到中断返回 130。CLI 会保存完成的对话和运行 trace；取消或失败的运行仍保留 trace。

## JSON 事件和评测

    newai run "说明项目入口" --project . --json > events.ndjson
    newai models list --json
    newai eval --smoke --json
    newai eval --model stored-model-id --tags code --repeat 3 --baseline eval/results/baseline.json

--json 的标准输出每行都是一个 JSON 事件，结构为 {"channel":"session:chunk","payload":{...}}；可用 jq 逐行解析。工具摘要、终端提示和诊断使用标准错误输出。

eval 使用 eval/tasks 下的任务；--tasks-dir 指定任务目录，--output 指定结果目录。--smoke 只检查框架回放，不代表真实模型质量；省略 --smoke 才调用配置模型。评测可用 NEWAI_EVAL_MODEL_ID、NEWAI_EVAL_BASE_URL、NEWAI_EVAL_API_KEY、NEWAI_EVAL_PROVIDER 和对应的费用变量覆盖普通 NEWAI_* 配置。报告同时输出 JSON 和 Markdown，失败返回非零退出码。
