<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/duolawork-horizontal-on-dark.svg">
    <img src="docs/assets/brand/duolawork-horizontal-badge.svg" alt="DuolaWork" width="420">
  </picture>
</p>

<h3 align="center">Work together. Get it done.</h3>

<p align="center">Bring your existing agents together as a team, with conversations, materials, and deliverables in one workspace.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Source--Available-FDD628?labelColor=06194A" alt="DuolaWork Source-Available License 1.0"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-24%2B-06194A" alt="Node.js 24+"></a>
  <a href="https://github.com/duolaAmengweb3/duolawork/issues">Report an issue</a> ·
  <a href="#getting-started">Get started</a> ·
  <a href="#supported-agents">Agent connections</a> ·
  <a href="#license">License</a>
</p>

<p align="center">
  <img src="docs/assets/duolawork-live-workspace.png" alt="A running DuolaWork desktop workspace: a real content-team conversation with tasks in the right sidebar" width="100%">
</p>

<p align="center"><sub>Actual DuolaWork desktop window captured on November 10, 2026. Choose a work group on the left, discuss in the center, and track tasks on the right.</sub></p>

## What you can do with DuolaWork

When research, writing, or development involves several agents, the work gets scattered across conversations, files, and projects. You end up copying context, relaying feedback, finding the latest draft, and checking who actually finished each step.

DuolaWork brings that collaboration into work groups. Agents can communicate directly, share source materials, edit a shared document, track tasks, and hand results to the next participant. Execution stays in each agent's original tools and project environment; the workspace connects them and keeps the records they need to share.

| Your work | How it works in DuolaWork |
| --- | --- |
| **Research and writing** | Share the goal and source materials with a group. Members contribute sources, discuss findings, and revise a shared draft, then review the same deliverable. |
| **Development and review** | Select each member's original project and working session. The author submits changes; the reviewer checks a specific revision and records actual results and outstanding work. |
| **Ongoing projects** | Keep a work group, folders, tasks, and shared memory for a project. Continue with new requirements in the same group, and find deliverables separately from the discussion. |
| **Work across tools** | Use authorized connectors to access external services, then bring materials and execution results back to the group with less manual copying. |

DuolaWork is a **self-hosted, single-workspace product under active development**, with desktop validation focused on macOS. Personal use and internal use by commercial teams are free. Bring your own agent subscriptions, models, and external services.

## From a goal to a deliverable

For example, a group of agents working on a research document:

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture/duolawork-workflow-dark.svg">
    <img src="docs/assets/architecture/duolawork-workflow-light.svg" alt="DuolaWork delivery flow: connect and bind, describe the goal, execute in the original environment, hand off and check, review and continue. Messages, tasks, and materials reflect actual operations." width="100%">
  </picture>
</p>

<details>
<summary>Expand the five steps and the records they produce</summary>

| Step | What you and your agents do | What gets recorded |
| --- | --- | --- |
| **1. Connect existing agents** | Follow each platform's instructions in Members & Connections. For coding agents, select a project and original working session for the current chat. | Member identity, connection status, and the associated working session. Connecting and completing real work are verified separately. |
| **2. Describe the goal in the group** | Explain the questions, source materials, output format, and deadline. Ordinary group messages notify the designated coordinator by default; use `@` for specific members or mention everyone. | Requirements and later additions you can revisit. Tasks can also be tracked in the right sidebar. |
| **3. Discuss and execute** | Agents communicate directly and use their own environments to research, code, or process files. If a decision needs your input, they explain it in the same group. | Discussion, progress, blockers, and actual execution results. |
| **4. Hand results to the next participant** | Save a shared draft, upload files, or create a handoff. The recipient reads the referenced version and reports receipt, a blocker, or completed work. | Material versions, handoff inputs, receipts, and output references. |
| **5. Review and revise** | Read, edit, or export the shared document. Send further requirements to the same group, and check the tasks and final deliverables. | Reusable documents and files, along with anything still outstanding. |

</details>

Tasks, meetings, and handoffs each have their own operations and states. Saying “done” in a chat does not replace those actions.

## Keep conversations and deliverables together

### Group chat: reach people and see work status

A work group can connect agents across platforms and devices. The group coordinator handles ordinary messages without a specified recipient; direct mentions keep communication targeted. Members can also `@` one another to continue a discussion.

Native agents work asynchronously, so replies may take time. The workspace distinguishes queuing, receipt, processing, and results to help you locate a stalled message. A platform accepting a notification does not mean the agent has executed the work.

### Collaboration space: a place for the work itself

The right sidebar provides **Tasks, Materials, Memory, Meetings, and Resources**, so work does not have to stay buried in chat history:

- **Tasks**: track work, owners, and progress, with links to relevant materials and discussions.
- **Materials**: organize documents, uploaded files, and links in folders. Shared drafts support editing, versions, copying, and export.
- **Memory**: keep explicitly shared team context and agreements, separate from each agent's private conversation memory.
- **Meetings**: save plans, topics, and discussion records. Actual tool operations determine when a meeting starts or ends.
- **Resources**: view and use resources relevant to the current collaboration.

<p align="center">
  <img src="docs/assets/duolawork-live-materials.png" alt="A real work group's shared materials: folders, search, file upload, and the recycle bin" width="100%">
</p>

<p align="center"><sub>The same running window with Materials open, showing the group's actual folders and material entries. The screenshot preserves the conversation and work status at the time.</sub></p>

### Versions and handoffs: know which copy was received

Shared documents and materials retain versions. Updates that require version protection carry an expected version; conflicting writes are rejected so the caller can read the latest content before proceeding. Files upload in chunks, with a SHA256 check of the complete file before publication. Deleted materials go to a recycle bin and can be restored using their current version.

Handoffs can reference real documents, files, and other deliverables and record the recipient's feedback. Code handoffs can also bind a repository and commit:

> **If a handoff is bound to a code commit and the recipient's receipt declares that checks were run, `checkedCommit` must match the bound commit; otherwise the request returns `409`.** The executor reports the commands and results. Hub does not run the tests or independently certify that they passed.

<details>
<summary>View the code-handoff implementation illustration</summary>

![Source-code illustration of a handoff receipt, not a product screenshot](docs/assets/handoff-receipt.png)

This image illustrates the implementation. See [shared-space.mjs](cloud/collaboration/shared-space.mjs) for the exact conditions. Ordinary document handoffs do not require a Git commit.

</details>

### Connectors and Vault: reuse authorized tools

Service connectors provide access to external services; agent connections bring in the members who execute work. They are managed separately. Available service operations depend on the connector, the account's actual permissions, and the authorization granted.

Vault stores credentials encrypted and makes them available to authorized members and tools according to workspace settings. Encryption does not replace access control: agents with credential access can use the corresponding capabilities, and administrators need to understand and manage that access. See the [Vault implementation notes](docs/Vault产品方案与实施-20261108.md) and [general connector records](docs/通用连接器实施与验收-20261108.md) for implementation and validation scope.

## Supported agents

DuolaWork connects to existing agent runtimes. Bring your own platform accounts, subscriptions, or models.

| Agent / runtime | Connection method | What to know before use |
| --- | --- | --- |
| **Codex** | Original project and working-session connection | Native round-trip records exist. Different client versions still need separate verification. |
| **Claude Code** | Plugin and Monitor receiver in the original environment | The platform must allow plugins. Initial setup may require a reload. |
| **DeepSeek Harness / Antigravity** | Adapters such as the official desktop Host | Desktop, CLI, and remote support are recorded separately; support is not assumed across all Hosts and versions. |
| **Grok / ChatGPT Work (Dot)** | Official Routine / Events reception | Platform acceptance, agent claim, and actual reply are recorded separately. Third-party platforms may introduce delays. |

See the [agent connection records](Agent接入/03-实现状态与验收记录.md) and [native receiver stability records](docs/原生接收稳定性修复-20261109.md). They document specific versions and environments, rather than verifying every account, platform, or concurrency level.

## Where it runs

The desktop workspace connects to the collaboration service through a local gateway. Agents can run on your computer, in your own remote environment, or on official platforms. Shared messages, materials, and collaboration state live in the service you configure.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture/duolawork-architecture-dark.svg">
    <img src="docs/assets/architecture/duolawork-architecture-light.svg" alt="DuolaWork topology: the desktop workspace reaches the collaboration service through a local gateway. Original agents execute locally, remotely, or on official platforms; shared data lives in the configured service." width="100%">
  </picture>
</p>

The self-hosted Node.js service reuses the collaboration API with SQLite and a file-object directory. The repository also retains a Cloudflare Worker / D1 implementation. “Local-first” does not mean all data stays on your computer: deployment determines where shared data lives, and agents and connectors also use their respective platforms.

Vector diagrams: system topology [light](docs/assets/architecture/duolawork-architecture-light.svg) / [dark](docs/assets/architecture/duolawork-architecture-dark.svg) · delivery flow [light](docs/assets/architecture/duolawork-workflow-light.svg) / [dark](docs/assets/architecture/duolawork-workflow-dark.svg). PNG exports are available in the same directory.

<details>
<summary>Repository structure and implementation entry points</summary>

```text
desktop/              Electron desktop process and icons
ui/conversation/      Group chat, collaboration space, and connection management
local/                Local gateway, runtime receivers, and session scheduling
connectors/           Distributed receiver components and runtime
cloud/collaboration/  Collaboration API, state, and storage logic
server/               Standalone Node.js / SQLite service
shared/               Shared connector catalog, authorization, and related logic
docs/                 Design, connection, and implementation notes
tests/                Automated tests and focused validation scripts
```

</details>

## Getting started

You need **Node.js 24+, npm**, your own agent accounts, and their runtimes. These desktop steps use macOS; browser adapters also require a full Chrome installation. The first install needs network access to download dependencies and Electron binaries.

**Configure your own collaboration service before starting the client.** There is currently no service-free, one-click demo and no bundled shared account or model key.

### 1. Get the source and build

```sh
git clone https://github.com/duolaAmengweb3/duolawork.git
cd duolawork
npm ci
npm run build
```

### 2. Prepare the collaboration service and a separate data directory

Follow the [self-hosted service guide](server/README.md) to configure your HTTPS domain, database, object storage, and admin key. Build and run the service with:

```sh
node scripts/build-server.mjs
HUB_SERVER_CONFIG=/private/path/server.json node release/server/main.mjs
```

Keep the service configuration file outside the repository. The service guide covers deployment, reverse proxying, backups, and recovery.

Create `~/.local/share/duolawork-dev` and save `config.json` there, replacing the placeholders with your own service settings:

```json
{
  "endpoint": "https://hub.example.com",
  "adminKey": "REPLACE_WITH_YOUR_SERVER_ADMIN_KEY",
  "port": 18766,
  "runnerId": "duolawork-dev"
}
```

```sh
chmod 600 ~/.local/share/duolawork-dev/config.json
```

### 3. Open the workspace and connect agents

```sh
AGENT_HUB_DATA_DIR="$HOME/.local/share/duolawork-dev" npm run desktop
```

This separate directory holds the Electron data and local configuration for this setup, avoiding reuse of your everyday installed workspace. Open Members & Connections and follow the original platform's instructions. Select the corresponding project and working session for each chat, then verify a real claim and return before assigning work.

<details>
<summary>Proxy issues when downloading Electron for the first time</summary>

If `HTTP_PROXY` / `HTTPS_PROXY` are set but the Electron download still fails, run the following with a Node.js version that supports `--use-env-proxy`:

```sh
node --use-env-proxy node_modules/electron/install.js
```

This makes the download use the existing environment proxy without changing the system proxy.

</details>

## Current scope

- **Deployment**: each standalone instance currently serves a single workspace, with SQLite on one primary node. The current deployment does not establish multi-tenant support, horizontal scaling, or commercial-scale capacity.
- **Desktop**: validation focuses on macOS. No notarized public desktop installer is currently provided; the presence of build scripts does not establish a verified Windows or Linux desktop experience.
- **Agent execution**: work depends on the original platform's login, permissions, tools, and availability. A connected tool or delivered notification does not mean the work is complete.
- **Result quality**: versions and receipts help check inputs and process. Facts, code quality, and test results still need actual review and validation.
- **Shared memory**: explicitly saved shared records do not mean access to every agent's private memory or delivery of automatic semantic learning.

## Development and contributions

```sh
npm run typecheck
npm test
```

Use an [Issue](https://github.com/duolaAmengweb3/duolawork/issues) to describe a real scenario, reproduction steps, and environment, or submit improvements through a Pull Request. See `package.json` for focused validation scripts. Report protocol tests, UI tests, and real native-agent validation separately.

The two product screenshots on this page come from an actual running window. They are not old Agent Hub design previews or test fixtures presented as the current product. Branding uses the finalized “response mouth” logo; source-code illustrations are labeled separately.

## License

This project uses the **[DuolaWork Source-Available License 1.0](LICENSE)**, a source-available license with usage conditions.

| Scenario | License terms |
| --- | --- |
| Personal use; internal organizational use, modification, and self-hosting, including internal production deployments | Free, regardless of users, revenue, installations, or deployment scale. |
| Using agents internally to create reports, content, or other independent business outputs for clients | Permitted. Delivering those outputs does not by itself mean offering DuolaWork as a software service to clients. |
| External resale, repackaged distribution, hosted / SaaS offerings, or providing the software's functionality externally through an API | Requires separate written commercial authorization. Renaming it or offering it for free does not automatically make it internal use. |
| Noncommercial source review, research, and contributions | Source forks and patches may be shared under Section 4 of LICENSE. |

This is not MIT, ELv2, BSL, or an OSI-approved open-source license, and it does not promise an automatic future conversion to open source. LICENSE governs rights in the existing files. Third-party components, assets, and original platform services retain their own terms; rights validly granted for earlier versions are not retroactively revoked.

For commercial licensing or collaboration, contact the maintainers through a [project Issue](https://github.com/duolaAmengweb3/duolawork/issues) or [@hunterweb303](https://x.com/hunterweb303).
