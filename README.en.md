# dsh-tavern

Chinese: [README.md](./README.md)

A dsh plugin that adds SillyTavern-style roleplay to `dsh web`: character cards, prompt presets, lorebooks, personas, regex, plus long-term memory, world state, and roll-backable floors (regenerate / rollback / edit).

Assembly is the main difference from ST. Cards and books land as workspace files. A live request is a stable `tavern:standing` section plus a per-turn `tavern:turn` context, not a full ST pack dumped into system every time. The model reads entries when it needs them.

Requires dsh `0.1.0-rc.6` and Node 24. Contributor notes: [AGENTS.md](./AGENTS.md). Runtime data (cards, memory, session bindings) lives in `$DSH_HOME/dsh-tavern/` (on Windows usually `%USERPROFILE%\.dsh\dsh-tavern`).

## Install

```bash
dsh plugin add dsh-tavern
```

From source:

```bash
# Junction this repo into the dsh profile under the package name (Windows, no admin)
cmd //c "mklink /J %USERPROFILE%\.dsh\profiles\node_modules\dsh-tavern <this-repo>"

npm install
npm run build
npm run dev          # dsh web --patch ./cordis.dev.yml
```

`cordis.dev.yml` mounts the plugin as `dsh-tavern`. After changing source, `npm run build` and refresh.

## Usage

1. Settings → Tavern → Characters, import PNG or JSON. Embedded lorebooks ask before import.
2. Switch the session to **Tavern** (preset is written to `$DSH_HOME/.agent-presets/tavern/`; upgrades overwrite it).
3. Bind a card from the header chip. Preset / persona / lorebook are optional.
4. New chats do not auto-select a card. Settings defaults apply only when you pick a character.
5. Then chat normally. Greetings can be inserted or swiped.

Character picking only shows when the agent preset is `tavern`. If it still behaves like a coding assistant, the session is not in Tavern mode.

## Features

- **Cards**: PNG (`tEXt` / `chara`, ccv3 first) or JSON, V1/V2/V3. Embedded lore and regex stored with the card. One workspace per card at `characters/<cardId>/`. UI shows `card.name`, not the folder name.
- **Presets**: Prompt Manager semantics. Character definition, enabled skeleton, and constant lore go into standing; keyword lore and memory go into turn. If a third-party preset lacks `agentMemory` / `worldState`, the runtime inserts that layer before `chatHistory`.
- **World Info**: plain/regex keys, selective, recursion, sticky/cooldown/delay, budget, seven insertion positions. Misses are read with `tavern_lore_read`, never dumped whole.
- **Regex**: input/output/prompt × assemble/send/render. Display-oriented card scripts on by default; preset scripts follow their own `disabled` flag.
- **Memory**: BM25 + time decay, write-time dedup, idle-time compression. View / edit / delete in settings.
- **World state**: add / update / invalidate as a lorebook delta. Undo one entry, or export a merge as new lorebook JSON. Original books are not rewritten.
- **Floors**: regenerate, edit user message, rollback. dsh cannot delete logs, so these fork a child session and roll memory/world-state through a WAL.

## How prompts reach the model

`assemblePrompt` still builds the full ST sequence for “Preview prompt”. The live call uses two channels:

| Channel | Lands in | Contents | Stability |
| --- | --- | --- | --- |
| standing | system section `tavern:standing` (order 210, after tool instructions) | discipline, character definition, preset skeleton, constant lore | pinned per session while the binding is unchanged |
| turn | runtime context `tavern:turn` | playbook, keyword lore, memory, world-state, author’s note, turn macros | changes every step |
| messages | preview only | full ST sequence, including @D insertion | live requests cannot splice the session log |

`{{setvar}}` / `{{getvar}}` expand before assemble. The clock is frozen in standing. Use the chip preview when debugging.

## Compatibility (SillyTavern → this plugin)

| ST field / feature | Status |
| --- | --- |
| V2 core fields (description / personality / scenario / first_mes / alternate_greetings / mes_example / system_prompt / post_history_instructions) | Fully assembled |
| creator_notes / tags / creator / character_version | Display only |
| character_book | Imported with the card |
| regex_scripts | Imported from the card (display on by default, prompt/input off); preset scripts follow `disabled` |
| World Info entries (including selectiveLogic / sticky / cooldown / delay / probability / group / automation_id) | Engine implemented; group / automation_id stored unused |
| Vector matching | Not implemented; semantic recall is BM25 memory |
| Preset prompt_order / entry fields | Supported |
| `{{char}}` / `{{user}}` / `{{outlet}}` / `{{trim}}` / `{{time}}` | Expanded at assemble time |
| `{{setvar}}` / `{{getvar}}` / `{{//}}` | Preprocessed. Not persisted. No if / dice / STscript |
| temperature / maxTokens / stop | Passed through |
| top_p / presence_penalty / frequency_penalty | Not delivered by the platform; settings keep them as notes |

## Platform limits

Host constraints. The plugin cannot work around them.

1. The model receives `temperature`, `maxTokens`, `stop`, and advertised `reasoningEffort`. Deep thinking off writes `off`. If the deployment locks `llm-deepseek.thinking` to `disabled`, the plugin cannot enable it. Temperature may be ignored in thinking mode.
2. Plugins cannot insert into the middle of the session log. @D and author’s notes join the end of system in the live request. ST-accurate insertion exists only in the preview.
3. Regenerate / rollback / edit fork a child: prefix fork + WAL rollback + continue there. A failed fork does not mutate the source workspace first.
4. Action bars exist only on assistant messages. “Edit user message” is on the assistant floor.
5. Several sessions writing the same card can interleave. Workspace and WAL are per card. Don’t do that.
6. The host→client event allow-list is static. Custom events do not push to the UI; it refreshes after an action.

## Interactive cards

Some cards embed HTML/JS. They render in a `sandbox="allow-scripts"` iframe with no `allow-same-origin`. CSP: `default-src 'none'`, inline script/style, https/http images and fonts allowed by default. Scripted fetch and external scripts are denied unless the domain whitelist widens `connect-src` / `script-src` (`*` allows all).

Injected ST / JS-Slash-Runner stubs may `postMessage` `swipeGreeting` to the host. There is no general parent-window bridge. Settings has a global toggle; off renders as plain text.

Card scripts are third-party code. Only import cards you trust.

## Debugging

The header chip has a trigger log and a prompt preview. Workspace `state/wal/` keeps pre-write snapshots per floor. Rolled-back directories are renamed `.rolled-back-<timestamp>`.

## Development

```bash
npm run build
npm test
```

`src/core/` pure functions, `src/state/` storage, `src/node/` host, `src/agent.ts` agent side, `src/client/` UI, `src/remote.ts` contract. `lib/` is a deliverable and is committed. Rebuild after changing `src/`.
