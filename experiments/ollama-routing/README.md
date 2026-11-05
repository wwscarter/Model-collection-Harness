# Ollama 路由分类实验

此目录只研究任务分类，不改产品路由、模型设置或 Pi 执行循环。`cases.json` 的 24 条请求和标签全部是人工预设的 **synthetic（合成实验数据）**，没有真实用户记录或真实评价。小合成集的准确率不能代表生产准确率；标签也不是独立验证的事实标准。

## 运行

先在本机启动 Ollama 并安装准备评估的模型，再使用项目已有 Node 与 TypeScript 依赖运行：

```sh
node experiments/ollama-routing/benchmark.mjs --help
node experiments/ollama-routing/benchmark.mjs --models qwen3:1.7b --prompts v1,v2 --limit 24
node experiments/ollama-routing/benchmark.mjs --models qwen3:1.7b,qwen3.5:2b --prompts v2 --limit 6 --timeout-ms 120000 --output experiments/ollama-routing/results/smoke.json
node experiments/ollama-routing/benchmark.mjs --models qwen3:1.7b --prompts v3 --limit 24 --output experiments/ollama-routing/results/v3-exploration.json
```

`--output` 是 JSON 文件路径，相对路径以当前工作目录解析；省略时写入此目录下 `results/<UTC时间>.json`。已有文件不会被覆盖。模型必须出现在本机 `/api/tags`，脚本不下载模型；云端模型标签会被拒绝。服务地址固定为 `http://127.0.0.1:11434`，不读取代理端点配置，不跟随 HTTP 重定向。

默认一条一条请求，本地 CPU 推理：`num_gpu:0`、`num_thread:4`、`num_ctx:2048`、`num_predict:80`、`temperature:0`、`think:false`、`stream:false`、`keep_alive:5m`。CPU 与并发参数是本次实验的固定配置，不是硬件性能建议。后端不支持这些参数时，保留其错误，不静默改参数。

## 对照设计

- **heuristic baseline**：用已有 `typescript.transpileModule` 在内存中加载 `src/core/routing/LocalRoutingModel.ts` 并调用真实分类器，没有复制关键词规则。保存源文件 SHA-256 与 TypeScript 版本。输入沿用产品现状，仅当前请求，`type=general`，不预设复杂度。
- **v1**：调用该源类现有的 `buildPrompt`，沿用枚举型提示词；仅当前请求。该方法虽是 TypeScript private，在本次编译产物中可用；若未来改为不可访问的方法，脚本会明确失败。
- **v2**：明确六类任务边界、主要产出的判定和三档复杂度标准；输入当前请求和样本中必要的简短历史。预测时不会发送期望标签。
- **v3**：保持主产出判别和最小必要上下文，精简分类边界，强调跨环节联动和多约束全局规划的 high 判据；新增六个原创短示例，每类各一个，覆盖 low/medium/high。新增时未读取评测样本或预测来选择示例；示例只出现在提示词中，代码不按关键词覆盖或修正模型输出。v1、v2 提示词及默认版本选择保持原样。

v1 与 v2 同时改变了分类判据和多轮上下文，属于整套输入方案比较，不能把差异全部归因于某一句提示词。后续正式评测应拆分这两个因素并使用独立留出集。

v3 是在此研究流程中的探索性提示词优化，既有合成评测集不因此成为独立留出集。v2 与 v3 同时改变了边界措辞和少样本示例，比较结果只支持整套提示词方案的探索结论。示例中的 confidence 是格式演示，不是经过校准的概率，也不固定正式预测的值。

所有版本的 Ollama 请求均使用原生 `/api/chat` 和 JSON Schema；本地再次校验枚举、字段与 confidence 的范围。非法格式、无效枚举、请求错误和超时计入错误，不包装为规则预测。实际接入产品时的规则回退属于另一个需要验证的指标。模型自报 confidence 只保存，不当作已经校准的概率。

## 记录与汇总

先跑规则基线，再获取 `/api/version`、`/api/tags` 和 `/api/ps`。每个模型正式评测前单独预热一次；记录该次请求的壁钟、加载时间与推理时间，不混进正式样本延迟。模型已加载时不声称观测到了冷启动；脚本不会卸载其他程序共享的模型。`coldStartObserved` 只是“启动前未加载且本次报告加载耗时”的观测，不能证明清空过系统磁盘缓存。

每条正式记录保存期望标签、预测、提示词 SHA-256、后端版本、模型 digest、请求壁钟、Ollama 总耗时/加载耗时/输入评估耗时/输出推理耗时，以及输入输出 token 数。Ollama 原始纳秒转换成毫秒；未返回的指标保存为 `null`。每条完成后原子保存整个 JSON，保留已完成的 partial 结果。Ctrl-C/SIGTERM 会中止当前 fetch，并停止派发后续请求。

按模型及提示词版本汇总任务类型准确率、复杂度准确率、联合正确率、壁钟 p50/p95 和错误数。准确率取 `0..1`，分母为已尝试记录，失败记录算不正确；百分位用 nearest-rank。warmup 结果单独保存在 `warmups`；启动/模型缺失等错误在顶层 `errors`。取消后的结果只反映已尝试样本，不能与完整运行直接比较。状态为 `completed-with-errors`、`failed` 或 `cancelled` 时进程返回非零退出码。

提示词试验、规则反馈与上下文学习均不等于模型权重学习。本脚手架不执行训练、微调或自动更新模型；将来研究权重更新需要另建数据审查、训练与独立评测流程。
