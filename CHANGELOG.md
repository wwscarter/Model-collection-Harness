# Changelog

## 0.4.2 — 2026-11-12

### Workbench polish and automatic continuation

- Launch opens a fresh, project-unbound conversation instead of restoring the most recent session; history stays in the sidebar and new drafts are persisted on first send.
- Move the sidebar toggle into the top bar and keep only the three view destinations in the left rail; stabilize its position across Run History.
- Follow streamed output at the bottom until the user scrolls up; switching sessions or returning from Run History lands at the newest output.
- Automatically continue when a model stops at its single-response output cap, carrying the partial text forward instead of ending the task with a length notice.

## 0.4.1 — 2026-11-11

### Remove execution caps

- Remove the tool-loop limits (32 rounds, 80 calls, 320k result characters). A run now continues until tools and model calls finish or the user stops it.
- Remove per-tool deadlines, foreground command deadlines (30 s default / 120 s maximum), web fetch/search client timeouts, and the run-budget time limit. Cancellation, process kill escalation, output truncation and context-window handling remain.
- Image generation no longer participates in the run cost budget: no per-image estimate requirement, no reservation or abort. Text model calls keep the configurable USD budget; the "最长运行时间" setting is removed from the UI.

## 0.4.0 — 2026-11-11

### No default agent wall-clock limit

- Remove the hard five-minute cap on the whole agent run and on each model request. Tools and model calls now end by succeeding or failing; the user can stop a run explicitly. `runTimeoutMs` remains an opt-in option for tests and headless callers.
- Run-budget timing and cost limits, and short per-tool deadlines, are unchanged.

### Image generation timeout fix

- Remove every project-side time limit while `request_media` waits for the image endpoint: both the agent's five-minute loop deadline and the run budget clock (default 10 minutes) are paused, and the provider request carries no client timeout. Only an explicit user stop interrupts generation; cost budgets are still reserved and checked.

### Run checkpoints

- Persist per-run progress (`tool_calls`, `last_tool`, distinct `write`/`edit` files) in `checkpoints.db` after every completed tool call, and finish the row on success, failure or cancellation.
- On startup, unfinished rows become `interrupted`; the session shows an Ant Design notice with the step/file counts and an acknowledgement action. No tool is replayed automatically.

### Operation audit trail

- Record `file.write`, `command.execute` and user-triggered `process.stop` events in an append-only `operations.jsonl` (30-day retention, bounded fields, corrupt lines skipped).
- Expose `audit:operations` and add an Ant Design audit drawer on the monitoring page with type filtering, pagination and JSON copy.

### Background process management

- Record the session that started each managed process and expose `processes:list` / `processes:stop` with a bounded output preview; only processes owned by the manager can be addressed.
- Add an Ant Design process drawer (composer → 进程) with status, URL, log tail, manual stop and 3-second refresh while open.
- When a run is cancelled, ask whether to stop the background processes that session started (stop all / keep running) instead of leaking them silently or killing a dev server.

### File change rollback

- Snapshot the pre-write content of every `write` / `edit` target in `file-history.db` (1 MiB per file, 30 days) and store a post-write hash for every change.
- Add `files:changes` and `files:restore` IPC plus an Ant Design bar under the run: inspect the modified files and undo the run in one action. Restore skips files changed after the run, credential paths, missing snapshots and oversized originals, and is refused while the session is still running.

### Reliability and safety hardening (review follow-up)

- Refuse `write` when a file changed on disk after the agent last read it (editor, formatter or another session), returning an actionable tool error instead of overwriting the external edits. The agent's own reads/writes refresh the fingerprint, so new files, deliberate rewrites and re-reads keep working.
- Serialise runs per session in `session:execute`: a new request aborts the previous run and waits for it to settle (bounded to 10 seconds) before starting, so two runs can no longer interleave writes in the same project.
- Validate renderer payloads for `session:execute` and `session:save` (identity lengths, project id type, modes, history/context sizes, message list size, timestamps) and return a field-level error instead of an opaque sqlite/type failure.
- Limit model-spending `session:execute` calls to 20 per minute per renderer and report the retry delay.
- Cache a healthy sandbox probe for 5 minutes (failed probes retry after 15 seconds), removing a sandbox child-process spawn every minute.
- Bound the tool-result cache by total bytes (8 MiB) in addition to 100 entries; one oversized result is still retained rather than re-executed.
- Report the sandbox root-directory rejection with the settings location that resolves it.

## 0.3.2 — 2026-11-11

- Correct the 0.3.1 image-generation policy: delegate supported dimensions, formats, quality and background behavior to the model and endpoint instead of rejecting requests against local capability declarations.
- Remove image capability declaration controls from settings while retaining protocol, routing scores, cost estimates, timing and default format. Existing capability metadata remains compatible but no longer blocks generation.
- Pass explicit generation parameters through, keep natural-language requirements in the prompt, and hand actual returned image metadata to the model for task assessment. Aspect-ratio and minimum-size preferences no longer select local size tiers.

## 0.3.1 — 2026-11-11

### Image dimension requirements

- Apply explicit prompt constraints to both direct image generation and agent media tools, preventing retries that remove structured fields from bypassing the requested dimensions.
- Keep exact `size` requirements unchanged; add `minSize` and explicit minimum-size wording to select the smallest declared output that meets both dimension bounds and the requested aspect ratio.
- Report missing model size configuration with its settings location and report actual dimensions when an image fails validation, preserving the existing protection against automatic resubmission.

## 0.3.0 — 2026-11-11

### Media generation and routing

- Register text, image and video operations in the same model/endpoint settings; dynamically select compatible image models for each request.
- Allow automatically scheduled executors and read-only collaborators to request images through shared media tools, with root-task budgets, deduplication and safe retry boundaries.
- Add an OpenAI Images adapter for Base64 PNG/JPEG/WebP, local asset storage, project export, conversation restoration and result cards.
- Keep media-only models out of text planning, summaries, review and fallback; mark tasks incomplete when required media fails. Video configuration is available, but a video provider adapter is not yet connected.

### Desktop and reliability

- Separate run history from the monitoring overview and add model-call trees and timelines with actual model snapshots.
- Preserve the expanded settings navigation, compact tool-trust table and focus handling improvements.
- Allow Ollama to choose its available accelerator instead of forcing CPU inference.
- Package macOS Intel x64 DMG and ZIP artifacts; signing and notarization require a configured Apple identity.

## 0.2.1 — 2026-11-11

### UI

- Added Ant Design 6.7.0 as the shared React component foundation.
- Unified the workbench palette, focus states, borders, shadows, and active states around a blue desktop product theme.
- Updated the navigation rail, monitoring controls, and Settings tabs with consistent component-library interactions and tooltips.

## 0.2.0 — 2026-11-10

### Agent workflow

- Added project-wide grep/find and a local code index, with optional semantic search backed by an existing local embedding model.
- Added command classification, platform sandbox integration, and project verification with bounded same-session repairs and independent review.
- Added trusted Rules and declarative Hooks, plus Skills, MCP server, and tool-trust management in Settings.
- Added persistent editable plans with approve/cancel controls and live step updates.
- Unified auxiliary model calls through Pi and added a shared Electron/CLI core, standalone CLI, and offline evaluation runner with 22 fixtures.

### Reliability

- Added explicit framework smoke evaluations, verification outcome reporting, and macOS release checks.
- Pinned direct dependencies to their lockfile versions and added dependency consistency and production audit checks.

## 0.1.2 — 2026-11-05

- Keep local projects in stable creation order when opened or renamed, including after a restart.
- Use compact 30px project and conversation rows with 2px gaps and preserve long-name truncation and remove controls.
- Open a fresh, empty conversation when creating or binding a project, preserving the previous conversation and its project association. Serialize project selection safely when older requests finish late or the user immediately starts another conversation.
- Remove decorative project, conversation and model configuration totals, the cost-chart point count and the settings header Esc hint. The close button and Escape key remain available.

## 0.1.1 — 2026-11-05

- Made per-run estimated cost and duration limits configurable in runtime settings, with legacy settings migration.
- Check configured budgets before each actual model request, cap output tokens, account reply usage incrementally, and reserve concurrent request estimates.
- Preserve partial answers and usage for budget stops and output truncation; interrupted revisions retain the original paid answer.
- Store and display requested model identity and configured pricing snapshots separately from stable configuration IDs; flag edited presets that still carry their original rates.
- Record bounded tool-failure reasons and correct fallback trace ownership and failed-request usage.

## 0.1.0 — 2026-11-05

### Routing and learning

- Added optional local Ollama classification with model detection, background warmup, cancellation, deadlines, circuit breaking, and deterministic fallback.
- Replaced DeepSeek-specific master selection with capability-based planning roles; the selected executor retains ownership of execution and synthesis.
- Added local, explicitly confirmed classification corrections and bounded example retrieval; prompt/model versions and fallback evidence are recorded in traces. This does not train model weights.
- Preserved recent conversation context for follow-up classification and reject empty final answers instead of recording them as successful.

### UI

- Unified model/endpoint settings, runtime settings, monitoring, dialogs, file previews, terminal and code output with shared neutral colors: light backgrounds and dark text in system light mode, dark backgrounds and light text in system dark mode. Native controls, focus, hover, selection and status surfaces follow the same appearance.

- Added progressive file preview: the right workspace is hidden by default, opens as a 270px file tree from the top-bar panel switch, expands to a code-preview + tree dual pane only after a file is clicked, and returns to the tree-only state when the preview is closed.
- Swapped the sidebar brand toolbar sides and show concrete model ids (instead of display names) in the chat attribution, model menu and composer.
- Opening a project now reveals its file tree immediately, the new-project dialog no longer polls Git status and uses transparent neutral surfaces, session rows omit timestamps for a compact list, and project folder paths are shown only as a hover tooltip.
- New sessions close the right workspace by default; the composer now has an existing-project selector plus Git header row, a quick-command menu on `+`, and a permission-mode indicator. The selected project is persisted per session and restored on switch; project creation no longer shows the detection card.

## 0.0.4 — 2026-11-04

### UI

- Moved to an immersive workspace: global top bar with centered session title and multi-file tabs, borderless sidebar with brand/bell/search toolbar, simplified composer, and a horizontal code-preview + file-tree right panel with filtering, line numbers and monochrome syntax highlighting.
- Removed project info cards, uppercase labels, shortcuts, terminal entry points and redundant preview controls from the main workspace.

## 0.0.3 — 2026-11-04

### Security

- Unified the credential-file policy used by project context and file tools. `.env*`, `.npmrc`, `.netrc`, `credentials`, `.aws/credentials`, `.docker/config.json`, `.kube/config`, service-account JSON and key stores are never included in a snapshot; `.git/` and these files are also refused by read/write/edit.
- Project snapshots are wrapped in `<project_context untrusted="true">` and routed independently from the user prompt. The composer has an explicit “上下文 开/关” toggle.
- Fixed the `web_fetch` SSRF bypass for hexadecimal IPv4-mapped IPv6 (`::ffff:7f00:1`), NAT64 and 6to4 forms.
- Enabled Electron sandbox, a production CSP, navigation/window/permission blocking and IPC sender validation. The preload is emitted as CommonJS `preload.cjs` so it works with `sandbox: true`.
- Terminal sessions no longer accept renderer-supplied shell, cwd or env; only an allow-listed environment is inherited. Command execution now requires a main-process native confirmation and runs in a killable process group.
- Saved API keys are bound to the endpoint origin; changing the host requires a new key.

### Agent runtime

- Added per-turn `runId`s, `runs`/`spans` trace storage and a call-chain timeline in the inspector, with a persistent `last_run_id` per session.
- Added a budgeted context assembler: tool digests, deterministic incremental summaries, hash-validated summary reuse and a hidden Pi checkpoint message.
- Added scoped long-term memory (`memory.db`), `remember`/`recall`/`forget` tools, a memory panel and memory retrieval injection.
- Added per-tool policies: call/result budgets, tool deadlines, result truncation, TTL caching for safe read-only tools and `process_list`.
- Added routing rules (`routing-rules.json`), RPM/daily-token quota guards, execution fallback chains and a default `plan+verify` strategy for high-complexity code.
- Added an independent verifier with one revision attempt, plus a per-run cost/duration budget of $0.25/10 minutes.
- Added live trace events, 30-day/1,000-run trace retention and JSON export.
- Added FTS5 memory search, memory export/clear and an opt-in automatic memory extractor.
- Added a routing rules editor, automatic parallel collaborators and an escalate revision strategy.
- Extracted the session execution pipeline into RunCoordinator with integration tests; main now only handles IPC, cancellation and event forwarding.
- Added trace retention settings/clear controls, pending review for auto-extracted memories, routing rule history/restore, and a packaged renderer smoke test.
- Replaced the JSON-only routing editor with a field-based rule form (JSON remains an advanced mode) and added batch approve/delete for pending memories.
- Added DeepSeek master orchestration: DeepSeek plans a JSON task allocation, invokes up to four read-only subagent models, and synthesizes the final answer; normal routing remains the fallback when DeepSeek is unavailable or the plan is invalid.
- Reworked the desktop UI: navigation rail with a dedicated monitoring page, cross-session trace observability, transient-only process cards, hover-revealed copy/edit controls, per-session multi-model/pinned-model selection, request/auto/full permission modes, project file preview, settings-hosted routing rules and system light/dark monochrome theming.

### Reliability

- Removed the no-key demo path: presets are not auto-enabled, keyless models are excluded from routing/planning/collaboration, and direct execution fails loudly.
- A corrupt credential or unavailable safeStorage no longer aborts startup. Models are marked with a credential error, startup failures show a dialog and write `startup-error.log`, and `AMD_ENCRYPTION_KEY` is supported as a recovery key.
- Project context is built with asynchronous I/O, and routing uses the user prompt instead of the snapshot.
- Planning requests time out after 45 seconds and fall back to execution without a plan.
- Command cancellation and timeouts terminate the whole process group (SIGTERM, then SIGKILL) and always settle the promise.
- Added a single-instance lock, a renderer error boundary, tolerant session JSON loading and terminal-session cleanup.

### Quality

- `npm test` is green (193 tests); Vitest now has 20s timeouts, whole-project coverage and CI on Node 22/24.
- Growth feedback records failures and the router’s actual `taskType`; static audits now write to the hash-chained log and metrics, so the dashboard KPI is real.
- Removed the fake “5.5 高” model label; the composer reports “自动路由”.

## 0.0.2 — 2026-11-03

- Added project `write` / `edit` tools and managed `run_command` / `process_status` / `stop_process` tools. The execution model can create a page, start a persistent local server and verify it with an HTTP request.
- Mutations and commands use native per-call confirmation. Requests keep their selected project across model stages, while analysis subagents retain read-only tools.
- Updated project access labels, refreshed the file tree after changes, and removed instructions claiming that project files cannot be modified. The system prompt now directs the model to perform requested actions and to describe only available capabilities.
- Background processes survive completed agent turns, expose bounded logs and are cleaned up when stopped or when the application exits. macOS command lookup includes common Homebrew locations.

## 0.0.1 — 2026-11-03

- First stable release tag; aligned the desktop package version with `0.0.1`.
- Verified OpenAI-compatible, DeepSeek, Anthropic and Google tool loops, including conversation history and streamed tool results.
- Added a stop button and preserved partial replies and tool status after cancellation or failure. Planning and parallel models now receive conversation history and cancellation signals.
- Preserved temperature settings across providers. Limited agent runs to five minutes and eight tool rounds; Bing search times out after fifteen seconds per host before falling back.

- Fixed: models answered that they had no internet access or tools. Requests were sent as a single user message with no tools, no conversation history and a prompt that said "do not claim to use tools". Execution now runs through the Pi SDK agent loop with `web_search`, `web_fetch`, read-only `read`/`ls`, the current date and the session history.
- Added `src/core/agent` (Pi model mapping, system prompt, `AgentRuntime`) and `src/core/tools` (pluggable `SearchProvider`, default Bing without a key; SSRF-guarded page fetch; project-confined file tools).
- Added the `session:tool-call` event, `session:cancel`, and `agent:describe` / `agent:search-providers` / `agent:set-search-provider` IPC. Tool calls are shown above each answer and saved with the session.
- Skills load from `<userData>/agent/skills`, and MCP servers from `<userData>/agent/mcp.json`. Tools other than the read-only built-ins need per-call approval.

- Redesigned the renderer from the Stitch design packs (workbench, new-project dialog, model and endpoint settings). Design tokens are documented in DESIGN_SYSTEM.md.
- Added a recent-projects list backed by `projects.db` (`ProjectStorage`) and read-only folder inspection (`ProjectInspector`: Git branch and project type).
- Added `projects:list/open/remove/pick-directory/create` IPC. `project:select(root)` now accepts only roots chosen through the folder dialog or already in the list.
- Fixed: a running task's spinner and errors no longer appear in other sessions; pressing Enter can no longer start a second run while one is in progress; the ⌘N/⌘K shortcuts shown in the sidebar now work; new models keep the rate limits entered in Settings; toggling a model on or off no longer discards unsaved form edits.

## Initial development baseline (previous package version: 0.1.0)

- Added multi-model routing with OpenAI, Anthropic and Google adapters.
- Added independent code auditing with a hash-chained append-only log.
- Added SQLite-backed sessions, metrics, model configuration and growth profiles.
- Added optional streaming output, project context, and opt-in command execution controls.
- Added Electron binary repair and Electron ABI rebuild checks for native dependencies.
- Added release verification and cross-platform electron-builder targets.
