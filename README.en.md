<div align="center">

# dsh-liketavern

**A DeepSeek Harness (dsh) plugin — turns `dsh web` into a SillyTavern-style roleplay frontend**

**Built for dsh `0.1.2-rc.1`**

[中文](./README.md) | English

[Features](#features) • [Installation](#installation) • [Usage](#usage) • [Platform Limitations](#platform-limitations) • [Development](#development)

</div>

Character cards (V1/V2/V3, PNG/JSON), prompt presets, lorebooks (world info), personas, regex scripts, BM25 long-term memory, a world-state delta layer, and rollback-able floor operations — all built on the dsh agent runtime instead of a separate message channel.

The experience is close to native dsh: prompts flow through the host's system-prompt waterfall (with stable sections aligned to DeepSeek's prefix cache), floor branches are real dsh session forks, and every UI piece hangs on the host's native slots using the same UI primitives and design tokens, with the interface language following the host by default. Session lineage breadcrumbs, workspaces, schedules, and interruption recovery all keep working in Tavern sessions — it feels like a built-in dsh mode rather than a bolted-on frontend.

## Features

- **Built-in Tavern Helper card support**: bundled jQuery/Lodash/Zod/YAML, real chat snapshots, story-persistent variables, cross-frame story events, greeting selection, and script diagnostics. Chat and preview share the sandbox. Character background scripts run in individual sandboxed frames with buttons and story variables. Global, current preset and character script libraries support editing, folders, JSON import/export, saved enabled flags, drafts and revision conflict checks. Live card and background scripts can update script libraries and await confirmed persistence, and use modern and legacy worldbook APIs, including session binding changes, additional character books and story-private book switching that preserves edits. Legacy worldbook settings persist as session overrides and control the actual scan engine. Scripts can read, edit and write back full message objects (including complete swipe collections and branch-based page switching), use legacy message, /swipe and context-save APIs through the same persistence and conflict checks, atomically save message data/extra in the current story, or batch-edit or delete messages in a new branch that retains later messages and rolls back affected derived state. Message display APIs can rebuild mounted plugin bubbles after preparing new output and checking unsaved drafts. Actual bubble readiness emits CHARACTER_MESSAGE_RENDERED; a completed all-refresh emits CHAT_CHANGED with the story ID. Host-event listeners refresh their saved story snapshot before running. Live messages and generation lifecycle events follow the current session; received replies wait for successful template and WAL completion, with no replay on history load or reconnect. Local Mvu APIs support manual parsing and explicit persistence, with a schema editor in each frame. Optional native MVU mode initializes variables and processes normal stop replies after background scripts are ready, retaining failed tasks for retry. Next-turn EJS/macros read the same story data. Keep the session page open. Status placeholders declared by character display regexes are supported. Classic MVU schemas, message-update hooks, generation controls and further asset APIs remain under adaptation. See [compatibility and examples (Chinese)](docs/TAVERN_HELPER.md).

- **Character cards**: import/export SillyTavern V1/V2/V3 cards (PNG-embedded or JSON), multiple greetings with swipe, embedded character lorebooks, regex scripts (`regex_scripts`), and interactive cards (HTML covers) rendered in a sandboxed iframe.
- **Prompt presets**: import ST preset JSON, assembled with Prompt Manager semantics; prompts go through dsh's system-prompt waterfall (stable sections + per-turn runtime context) — never assembled and sent from the frontend.
- **Built-in EJS templates**: conditions, loops, async expressions, story and per-message variables, JSON/YAML initial values, JSON Patch, Zod validation and worldbook decorators. Includes active entries, regex across merged sources, sticky injections and closures across turns, avatar context, Lodash, Faker and history queries. Completed response scripts execute once; restart, branching and floor rollback preserve variables and counters. ST-Prompt-Template is not required. See the [compatibility guide](docs/PROMPT_TEMPLATES.md) for supported APIs and host differences.
- **Lorebooks**: global / character / session scopes, keyword triggering and constant entries; a "delta layer" lets the story add, update, and invalidate world-state facts.
- **Long-term memory**: BM25 retrieval with time decay; the model can read/write it via tools, with automatic asynchronous compression during idle time when over capacity.
- **Personas**: `{{user}}` default name and description injection.
- **Floor transactions**: writes (memory, world state) go through a WAL (floor number + sequence); regenerate / roll back / edit = fork prefix + reverse WAL replay + continue in a child session. Branches forked at the same floor get ‹ n/m › sibling navigation.
- **Impersonate / continue**: impersonation results are copied to the clipboard; continuing a floor doesn't touch history and just follows up.
- **Model tools (7)**: memory search / write / update, per-entry lorebook read, world-state update, asset list / read — available to the multi-step agent loop on demand.

Interactive-card variables in real sessions are saved through the story lock and WAL, with runtime pending/saved/error status and `await flushHelperVariables()` for confirmation. All scopes are isolated per story; branches inherit then diverge. Character previews remain temporary. Refresh, backup and restore are available under Tavern settings → Cards & Data, selecting the character and story. Management controls are no longer inserted into card layouts. Backups have a 1 MiB limit, excluding form inputs that have not been written to variables.

Editors confirm navigation with unsaved changes and guard browser refresh/close. Unsaved edits for characters, presets, lorebooks, personas, regex, memory and settings are backed up to `editor-drafts/` in the data directory. Once the backup status appears, refreshing the same browser tab or reopening the editor restores its content, tab and character/story selection. Save applies changes; explicitly discarding clears the draft. Browser storage holds only a random tab identifier, never editor content. Recovery is not guaranteed after closing the tab or disabling browser storage. Each draft has a 2 MiB limit; failed backups preserve the current editor and offer retry.

On phones, Tavern settings use horizontal top navigation with wider content, responsive forms and reachable dialog actions on short screens. Chat content uses the available width; third-party interactive cards control their own internal layout.

## Requirements

- Node.js ≥ 24
- dsh CLI `0.1.2-rc.1` installed, with `dsh web` run at least once (the first run initializes the `web` profile)
- `pnpm` on PATH (`dsh plugin` manages profile plugin dependencies through pnpm internally)

## Installation

The plugin is installed into a profile as a **bundle**. The package declares `dsh.bundle.patch` in `package.json`, so `dsh` automatically appends its patch layer to the profile's bundle list.

```bash
dsh plugin --profile web add github:Amakurai/dsh-liketavern
dsh web   # restart to take effect
```

Verify the installation:

```bash
dsh plugin --profile web list --depth 0
```

Two notes (per the official docs, [Packaging and installing plugins](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)):

- **Git installs pull source, not build artifacts** — pnpm won't run your `build` for you. This repository deliberately commits the built `lib/` output, so installing straight from GitHub works. Pinning a commit (`github:Amakurai/dsh-liketavern#<sha>`) is recommended so later pushes can't silently change what runs.
- **Runtime dependencies**: `zod`, `quickjs-emscripten`, `yaml`, `lodash`, `jsonrepair`, `@faker-js/faker`, `ejs`, `showdown` and `jquery` provide template sandboxing, initial-variable parsing, compilation, formatting and card compatibility without native builds. All `@deepseek-ai/*` packages remain peers supplied by the profile's dsh host. If pnpm blocks host dependency build scripts, follow the dsh error to review the profile's `allowBuilds` configuration.
- A tarball also works: the author runs `npm pack` (its `prepack` builds first), and the user runs `dsh plugin --profile web add ./dsh-liketavern-0.2.1.tgz`.

Version compatibility: this package pins dsh `0.1.2-rc.1` via peerDependencies. dsh is in pre-release — after upgrading dsh, install the plugin version built for it. See [CHANGELOG.md](./CHANGELOG.md) for the version mapping.

Runtime data (cards, memories, session bindings) lives in `$DSH_HOME/dsh-tavern/`, outside this repository.

## Usage

1. In dsh web, create a new session, pick "Tavern mode" in the hero area, and select a character card to bind.
2. Manage cards, presets, lorebooks, personas, regex rules, and sampling parameters in the `dsh-tavern` settings section.
3. In conversation, any assistant floor can be regenerated, edited, rolled back, continued, or answered by AI impersonation.

The plugin UI is in English by default. To switch to Chinese, open the Tavern settings tab → "Interface" subgroup → "Language"; the change applies immediately and is saved automatically (it only affects this plugin's UI, not the host interface).

## Story state upgrade

Each session and branch now has its own storyId. New sessions copy the character’s initial state. Regeneration rolls back a child snapshot and preserves the original session state. The memory panel selects a character and then a story; “Initial state” applies to future sessions.

Legacy bindings copy the old shared state once on first access, preserving the original directory. Previously mixed branch facts cannot be reliably separated automatically; review each migrated story. Editing an AI reply revokes facts derived from that turn and later turns without inferring replacement facts or starting a model call.

Automatic summaries may omit information. Original sources remain archived and searchable through active summaries. Failed, truncated or timed out model streams cannot archive originals. Snapshots and archives consume disk space; old stories are not automatically deleted.

## Platform limitations

Due to current dsh host capabilities, the following differs from vanilla SillyTavern. These are known boundaries, not bugs:

- **Sampling parameters**: only `temperature`, `maxTokens`, `stop`, and the "deep thinking" levels published by the current model actually reach the model; `top_p` and penalty coefficients are recorded in the panel but have no effect.
- **Prompt placement and regex**: static depth injection goes into standing; dynamic @D and author notes go into runtime context. Host history is unchanged. input/send, prompt/assemble and prompt/send apply to ST simulation and impersonation; live display uses output/render. “Last host request” shows the actual request before adapter conversion; other preview tabs are simulations.
- **The session log cannot be deleted**: regenerating / rolling back / editing a floor forks a branch session and continues there, while the original session stays intact in the session list; sibling branches forked at the same floor are navigable via ‹ n/m › on the action bar.
- **AI impersonation**: the current action copies results to the clipboard for manual pasting; it does not yet fill the host draft.
- **Multiple sessions and branches**: memories, world changes, notes, chat lore, timers and WAL are isolated per story. Character assets remain shared. Multiple host processes writing the same data directory are unsupported.

## Development

```bash
npm install        # install dev dependencies (public npm, exact versions)
npm run build      # tsc compiles src/ → lib/, then esbuild bundles the client
npm test           # vitest run (case count drifts with changes; not pinned here)
npm run dev        # dsh web --patch ./cordis.patch.yml (requires linking the repo into the profile, below)
```

Local debugging: link this repo into the profile's `node_modules` (run `dsh web` once first to initialize the profile), then `npm run dev`. Use a junction on Windows, a symlink on macOS / Linux:

```powershell
# Windows (PowerShell)
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-liketavern" -Target "C:\path\to\dsh-liketavern"
```

```bash
# macOS / Linux (run from the repo root)
mkdir -p ~/.dsh/profiles/node_modules
ln -s "$(pwd)" ~/.dsh/profiles/node_modules/dsh-liketavern
```

Notes:

- `lib/` is a deliverable and is committed on purpose; rerun `npm run build` after changing code.
- Never commit real character cards, runtime JSON, images, sessions, or memories to Git; tests use hand-written factory data.

## Code layout

```
src/
├── core/     pure-function layer (no I/O, fully unit-testable): assembly, lorebook
│             triggering, regex, macros, BM25, tokenization, etc.
├── state/    storage layer (file I/O into $DSH_HOME/dsh-tavern/): cards / presets /
│             lorebooks / memory / WAL / workspace
├── node/     host runtime: config, service, pipeline, floors, tools, memory maintenance
├── client/   browser React UI (settings panels, action bar, chips, hero area, card rendering)
├── index.ts  host entry
├── agent.ts  agent-side entry (system-prompt assembly, sampling merge, tool registration)
└── remote.ts typert RPC contract
```

In-repo development conventions are documented in [AGENTS.md](./AGENTS.md).

## License

MIT
