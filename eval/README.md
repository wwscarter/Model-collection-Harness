# 离线评测

每个任务在独立临时目录中运行，通过同一套 `createCore`、Pi Agent、工具、命令沙箱和 trace 执行。评测完成后清理临时项目与数据目录，不写入桌面路由学习数据。

```sh
npm run eval -- --smoke
npm run eval -- --model <配置ID或模型ID> --data-dir <已配置的数据目录> --tags code --repeat 3
npm run eval -- --model <配置ID> --baseline eval/results/<报告>.json
```

`--smoke` 使用本机 SSE 回放服务和真实文件/命令工具执行 5 个框架用例。报告显式标记为 synthetic smoke，模型 token 与费用为 `null`，不能用于证明真实模型能力。普通模式不会读取 `smoke.json`。

普通模式可读取 CLI 数据目录中的模型，也可通过 `NEWAI_EVAL_MODEL_ID`、`NEWAI_EVAL_PROVIDER`、`NEWAI_EVAL_BASE_URL`、`NEWAI_EVAL_API_KEY` 注入临时模型；未设置的字段回退到对应 `NEWAI_*` 变量。凭据不进入报告，也不复制到评测数据库。读取已有加密配置需要同一 `AMD_ENCRYPTION_KEY`。

环境模型的价格需通过 `NEWAI_EVAL_INPUT_COST_PER_1K` 和 `NEWAI_EVAL_OUTPUT_COST_PER_1K` 配置。未配置时成本显示未知，`max-cost` 检查无法判定而失败；配置后的数字是按用量和配置价格计算的估算。真实模型运行要求 OS 沙箱可用，未配置模型时直接报错。

20 个初始任务覆盖检索、配置编辑、算术、集合、文本、版本排序、日期、异步顺序与重试、HTTP 服务。任务目录包括 `task.json`、`fixture/`，5 个框架任务另有 `smoke.json`。评测只把 `fixture/` 复制给运行中的 Agent，清单与回放答案留在外部。

检查器支持 `command`、`file-unchanged`、`file-contains`、`answer-contains`、`max-tool-calls`、`max-cost`。可选 `llm-judge` 指定 `modelId`、`rubric` 和 0–1 的 `minScore`；它会调用已配置的评审模型并产生额外费用，框架冒烟禁用此检查器。

报告写入 `eval/results/<时间>-<模式>.json` 和 `.md`，包含逐次结果、通过率、平均耗时、工具数、费用、按标签/模型的分组，以及相同模式 baseline 中新出现的失败。真实模型记录协议、实际上游型号、配置 ID 和已配置费率，不把环境模型的固定配置 ID 当作实际型号。`--output`、`--tasks-dir` 可改变输出与任务目录；`--json` 输出 NDJSON 进度。取消会保存已完成样本，JSON 和 Markdown 都标记取消状态及已完成/计划样本数，整批评测不会记为通过，进程返回非零状态。

CI 中的模拟冒烟不调用付费模型；真实评测仅由 `Model evaluation (manual)` workflow 手动触发，密钥来自 `NEWAI_EVAL_API_KEY` secret。任务清单中的检查命令属于项目维护者配置，请与 fixture 一起进行代码审查。
