# Changelog

## Unreleased — 2026-11-04

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
