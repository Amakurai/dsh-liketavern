<div align="center">

# dsh-liketavern

**A DeepSeek Harness (dsh) plugin — turns `dsh web` into a SillyTavern-style roleplay frontend**

[中文](./README.md) | English

[Features](#features) • [Installation](#installation) • [Usage](#usage) • [Platform Limitations](#platform-limitations) • [Development](#development)

</div>

Character cards (V1/V2/V3, PNG/JSON), prompt presets, lorebooks (world info), personas, regex scripts, BM25 long-term memory, a world-state delta layer, and rollback-able floor operations — all built on the dsh agent runtime instead of a separate message channel.

## Features

- **Character cards**: import/export SillyTavern V1/V2/V3 cards (PNG-embedded or JSON), multiple greetings with swipe, embedded character lorebooks, regex scripts (`regex_scripts`), and interactive cards (HTML covers) rendered in a sandboxed iframe.
- **Prompt presets**: import ST preset JSON, assembled with Prompt Manager semantics; prompts go through dsh's system-prompt waterfall (stable sections + per-turn runtime context) — never assembled and sent from the frontend.
- **Lorebooks**: global / character / session scopes, keyword triggering and constant entries; a "delta layer" lets the story add, update, and invalidate world-state facts.
- **Long-term memory**: BM25 retrieval with time decay; the model can read/write it via tools, with automatic asynchronous compression during idle time when over capacity.
- **Personas**: `{{user}}` default name and description injection.
- **Floor transactions**: writes (memory, world state) go through a WAL (floor number + sequence); regenerate / roll back / edit = fork prefix + reverse WAL replay + continue in a child session. Branches forked at the same floor get ‹ n/m › sibling navigation.
- **Impersonate / continue**: impersonation results are copied to the clipboard; continuing a floor doesn't touch history and just follows up.
- **Model tools (7)**: memory search / write / update, per-entry lorebook read, world-state update, asset list / read — available to the multi-step agent loop on demand.

## Requirements

- Node.js ≥ 24
- dsh CLI `0.1.1-rc.2` installed, with `dsh web` run at least once (the first run initializes the `web` profile)
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
- **The install surface is deliberately tiny**: the only runtime dependency is `zod`; all `@deepseek-ai/*` packages are peer dependencies satisfied by the dsh host already in the profile. Installing this plugin does not pull the dsh host tree or its native dependencies (`node-pty` and friends), so it should not trip pnpm's build-script blocking (`ERR_PNPM_IGNORED_BUILDS`). If you still hit it, that's a one-time authorization for dsh's own dependencies in the profile: add the printed package names under `allowBuilds` in `~/.dsh/profiles/web/pnpm-workspace.yaml` as the dsh error suggests, then re-run the install.
- A tarball also works: the author runs `npm pack` (its `prepack` builds first), and the user runs `dsh plugin --profile web add ./dsh-liketavern-0.1.1.tgz`.

Version compatibility: this package pins dsh `0.1.1-rc.2` via peerDependencies. dsh is in pre-release — after upgrading dsh, install the plugin version built for it. See [CHANGELOG.md](./CHANGELOG.md) for the version mapping.

Runtime data (cards, memories, session bindings) lives in `$DSH_HOME/dsh-tavern/`, outside this repository.

## Usage

1. In dsh web, create a new session, pick "Tavern mode" in the hero area, and select a character card to bind.
2. Manage cards, presets, lorebooks, personas, regex rules, and sampling parameters in the `dsh-tavern` settings section.
3. In conversation, any assistant floor can be regenerated, edited, rolled back, continued, or answered by AI impersonation.

The plugin UI is in English by default. To switch to Chinese, open the Tavern settings tab → "Interface" subgroup → "Language"; the change applies immediately and is saved automatically (it only affects this plugin's UI, not the host interface).

## Platform limitations

Due to current dsh host capabilities, the following differs from vanilla SillyTavern. These are known boundaries, not bugs:

- **Sampling parameters**: only `temperature`, `maxTokens`, `stop`, and the "deep thinking" levels published by the current model actually reach the model; `top_p` and penalty coefficients are recorded in the panel but have no effect.
- **Prompt placement**: @D (depth injection) and author's notes are merged into the tail of the system prompt in real requests, not inserted into the middle of chat history; only "preview prompt" shows the full ST sequence.
- **The session log cannot be deleted**: regenerating / rolling back / editing a floor forks a branch session and continues there, while the original session stays intact in the session list; sibling branches forked at the same floor are navigable via ‹ n/m › on the action bar.
- **AI impersonation**: the host input area has no plugin-writable API, so impersonation results can only be copied to the clipboard and pasted manually.
- **Multiple sessions on the same card**: the workspace and WAL are shared per card, so concurrent writes across sessions may interleave.

## Development

```bash
npm install        # install dev dependencies (public npm, exact versions)
npm run build      # tsc compiles src/ → lib/, then esbuild bundles the client
npm test           # vitest run (case count drifts with changes; not pinned here)
npm run dev        # dsh web --patch ./cordis.dev.yml (requires linking the repo into the profile, below)
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
