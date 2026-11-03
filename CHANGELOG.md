# Changelog

## Unreleased

- Redesigned the renderer from the Stitch design packs (workbench, new-project dialog, model and endpoint settings). Design tokens are documented in DESIGN_SYSTEM.md.
- Added a recent-projects list backed by `projects.db` (`ProjectStorage`) and read-only folder inspection (`ProjectInspector`: Git branch and project type).
- Added `projects:list/open/remove/pick-directory/create` IPC. `project:select(root)` now accepts only roots chosen through the folder dialog or already in the list.
- Fixed: a running task's spinner and errors no longer appear in other sessions; pressing Enter can no longer start a second run while one is in progress; the ⌘N/⌘K shortcuts shown in the sidebar now work; new models keep the rate limits entered in Settings; toggling a model on or off no longer discards unsaved form edits.

## 0.1.0

- Added multi-model routing with OpenAI, Anthropic and Google adapters.
- Added independent code auditing with a hash-chained append-only log.
- Added SQLite-backed sessions, metrics, model configuration and growth profiles.
- Added optional streaming output, project context, and opt-in command execution controls.
- Added Electron binary repair and Electron ABI rebuild checks for native dependencies.
- Added release verification and cross-platform electron-builder targets.
