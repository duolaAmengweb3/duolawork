# Changelog

All notable changes to **DuolaWork** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2026-11-28

### Added
- **Local-First BYOS Desktop Workbench (`duolawork2.0/`)**: Zero login wall on launch (`npm ci && npm run build && npm run desktop`) with 3-minute local CLI auto-discovery for `codex`, `claude`, and `gemini` / `agy` ACP runtimes without mutating existing CLI configurations or credentials.
- **Single-Thread Multi-Model Collaboration**: Switch active agent owners mid-thread with deterministic `<= 12 KiB` bounded delta handoffs, explicit deliverable pointers, and isolated Git worktree execution for code tasks.
- **Lead-Reviewed Task FSM & Isolated Scheduled Runs**: Deterministic lead decomposition → isolated worker execution → automated review/revision state machine, plus one-off and recurring cron schedules (`croner`) where each slot runs in an isolated fresh session so a failure in one slot never stalls the next.
- **Multi-Tab Editorial Reader**: Inspect and edit Markdown docs, CSV/data tables, code files, and media side-by-side with optimistic concurrency locking (`expectedVersion`) and automatic conflict-branch preservation.
- **Optional Self-Hosted Cloud & Execution Nodes (`node-runner`)**: Connect local or remote execution nodes outbound to a self-hosted control plane, with per-app opt-in companion keepalive (disabled by default), explicit device-ACK state tracking, automatic pause of offline node launches, and reconnect recovery.
- **Atomic Backup & Restore (`deploy/scripts/backup-sqlite.mjs` & `restore-backup.mjs`)**: Consistent SQLite snapshots bundled with space attachments and chat images, verified via SHA-256 `manifest.json` integrity manifests.
- **Safe Desktop Lifecycle & Bilingual UI**: Graceful Local/Cloud mode switching (`desktop/mode-switch.cjs`), transactional local macOS bundling/activation (`scripts/package-mac.mjs`, `scripts/activate-local.mjs`), and instant persistent `EN / 中` UI language toggle.

### Verification & Release Notes
- Verified on **Node.js 24+** and clean **macOS** checkouts (`npm ci && npm run build && npm run desktop`, plus optional `npm run package:mac`).
- **78 / 78** automated tests passing; frontend production bundle budgets verified (entry JS gzip `71.36 kB`, total JS gzip `210.77 kB`).
- Source-available release governed by the [DuolaWork Source-Available License 1.0](LICENSE). Local macOS `.app` packaging uses ad-hoc signing (notarized DMG distribution is planned for a future release).
