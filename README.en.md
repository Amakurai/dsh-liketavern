# dsh-liketavern

[中文](./README.md) | English

A DeepSeek Harness (dsh) plugin that turns `dsh web` into a SillyTavern-style roleplay frontend.

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
- dsh CLI `0.1.0-rc.6` installed, with `dsh web` run at least once (the first run initializes the `web` profile)
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

- **Git installs pull source, not build artifacts** — pnpm won't run your `build` for you. This repository deliberately commits the built `lib/` output, so installing straight from GitHub works and needs no pnpm `allowBuilds` authorization. Pinning a commit (`github:Amakurai/dsh-liketavern#<sha>`) is recommended so later pushes can't silently change what runs.
- A tarball also works: the author runs `npm pack` (its `prepack` builds first), and the user runs `dsh plugin --profile web add ./dsh-liketavern-0.1.0.tgz`.

Version compatibility: this package pins dsh `0.1.0-rc.6` via peerDependencies. dsh is in pre-release — after upgrading dsh, install the plugin version built for it.

Runtime data (cards, memories, session bindings) lives in `$DSH_HOME/dsh-tavern/`, outside this repository.

## Usage

1. In dsh web, create a new session, pick "Tavern mode" in the hero area, and select a character card to bind.
2. Manage cards, presets, lorebooks, personas, regex rules, and sampling parameters in the `dsh-tavern` settings section.
3. In conversation, any assistant floor can be regenerated, edited, rolled back, continued, or answered by AI impersonation.

## Development

```bash
npm install        # install dev dependencies (public npm, exact versions)
npm run build      # tsc compiles src/ → lib/, then esbuild bundles the client
npm test           # vitest run: 32 files, ~360 cases
npm run dev        # dsh web --patch ./cordis.dev.yml (requires the junction below)
```

Local debugging: on Windows, junction this repo into `~/.dsh/profiles/node_modules/dsh-liketavern`, then run `npm run dev`.

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
