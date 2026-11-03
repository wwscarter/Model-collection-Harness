# Changelog

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
