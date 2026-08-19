# dsh-liketavern

Chinese: [README.md](./README.md)

A dsh plugin that turns `dsh web` into a SillyTavern-style roleplay frontend: character cards, prompt presets, lorebooks, personas, regex, plus BM25 long-term memory, a world-state delta layer, and roll-backable floors (regenerate / rollback / edit). Everything sits on dsh’s agent runtime. There is no separate send path.

Requires dsh `0.1.0-rc.6` (same version as `@deepseek-ai/*`) and Node 24. Runtime data lives in `$DSH_HOME/dsh-tavern/`.

## Differences from SillyTavern

1. **Assets are files.** Imported cards, books, and presets land in a workspace. The agent reads entries on demand instead of stuffing the whole bible into system every turn.
2. **Multi-step loop.** A reply may retrieve, write memory, or update world state, and only then produce the spoken text. The default is still to roleplay directly.
3. **Floors roll back.** Memory / world-state / timer writes for a floor go through a WAL and replay in reverse. dsh cannot delete session logs, so floor actions fork a child session.
4. **Prompts use the dsh waterfall.** Stable section `tavern:standing` plus per-turn runtime context `tavern:turn`. No `complete` section over the tool prefix, and no frontend-assembled live payload.

## Layout

TypeScript ESM, a cordis plugin, three sides:

| Side | Entry | Role |
| --- | --- | --- |
| host | `src/index.ts` | settings namespace, data dirs, agent preset, `TavernService`, typert remote, floor WAL |
| agent | `src/agent.ts` | standing / turn assembly, sampling and `reasoningEffort`, seven model tools, idle memory compression |
| client | `src/client/` | settings panel, session chip, new-session hero, assistant actions and layout |

host ↔ client contract is `src/remote.ts`. Runtime dependency is `zod` only; `@deepseek-ai/*` comes from the dsh host.

```
src/
├── core/     pure functions: assemble, World Info, regex, macros, BM25, standing pin
├── state/    file storage (cards / books / presets / memory / WAL / workspace)
├── node/     host orchestration
├── client/   React UI
├── agent.ts  agent side
└── remote.ts typert contract
```

## What it does

- **Cards**: PNG (`tEXt` / `chara`, ccv3 first) or JSON, V1/V2/V3. Embedded lore and regex stored with the card. One workspace per card; the UI uses `card.name`.
- **Presets**: Prompt Manager semantics. Character definition, enabled skeleton, and constant lore go into standing; keyword lore and memory go into turn. Missing `agentMemory` / `worldState` markers are inserted at runtime.
- **World Info**: plain/regex keys, selective, recursion, sticky/cooldown/delay, probability, budget, seven insertion positions. Misses are read with `tavern_lore_read`.
- **Regex**: input/output/prompt × assemble/send/render. Display-oriented card scripts on by default; preset scripts follow `disabled`.
- **Memory**: BM25 + time decay, write-time dedup, idle compression of the oldest batch when over capacity.
- **World state**: add / update / invalidate as a lorebook delta. Undo one entry, or export a new book; originals are not rewritten.
- **Floors**: regenerate, edit user message, rollback. Prefix fork + WAL rollback + continue in the child.
- **Covers**: HTML extracted by output/render regex draws in a `sandbox="allow-scripts"` iframe. CSP denies external scripts and fetch by default.

## Prompt channels

`assemblePrompt` still builds the full ST sequence for preview. The live call uses two dsh channels:

| Channel | Lands in | Contents | Stability |
| --- | --- | --- | --- |
| standing | system section `tavern:standing` (order 210, after tool instructions) | discipline, character definition, preset skeleton, constant lore | pinned per session while the binding is unchanged |
| turn | runtime context `tavern:turn` | playbook, keyword lore, memory, world-state, author’s note, turn macros | changes every step |
| messages | preview only | full ST sequence, including @D insertion | live requests cannot splice the session log |

`{{setvar}}` / `{{getvar}}` expand before assemble. The clock is frozen in standing. World Info and memory are evaluated once per turn; later steps still replay that snapshot.

Model tools (off by default): `tavern_memory_search` / `write` / `update`, `tavern_lore_read`, `tavern_worldstate_update`, `tavern_asset_list` / `read`.

## Compatibility

| ST | This plugin |
| --- | --- |
| V2 core fields (description / personality / scenario / first_mes / alternate_greetings / mes_example / system_prompt / post_history_instructions) | Assembled |
| creator_notes / tags / creator / character_version | Display only |
| character_book, regex_scripts, World Info entries | Imported; engine implemented; group / automation_id stored unused |
| Vector matching | Not implemented; semantic recall is BM25 memory |
| `{{char}}` / `{{user}}` / `{{outlet}}` / `{{trim}}` / `{{time}}` | Expanded at assemble time |
| `{{setvar}}` / `{{getvar}}` / `{{//}}` | Preprocessed, not persisted. No if / dice / STscript |
| temperature / maxTokens / stop / reasoningEffort | Passed through (thinking off → `off`) |
| top_p / presence_penalty / frequency_penalty | Not delivered by the platform |

Host constraints: the session log cannot be spliced, so @D and author’s notes join the end of system in the live request; floor actions can only fork, not rewrite the source log; concurrent writes to the same card interleave.

## Install

```bash
dsh plugin --profile web add github:Amakurai/dsh-liketavern
```

Update:

```bash
dsh plugin --profile web update dsh-liketavern
```

Uninstall (does not delete `$DSH_HOME/dsh-tavern/`):

```bash
dsh plugin --profile web remove dsh-liketavern
```

Restart `dsh web` afterwards.

From source:

```bash
cmd //c "mklink /J %USERPROFILE%\.dsh\profiles\node_modules\dsh-liketavern <this-repo>"
npm install
npm run build
npm run dev          # dsh web --patch ./cordis.dev.yml
```

`npm test` imports `src/` directly. Rebuild after changing `src/`.
