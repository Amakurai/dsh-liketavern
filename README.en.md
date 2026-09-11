<div align="center">

# dsh-liketavern

**Tavern-style roleplay in DeepSeek Harness's `dsh web`, with character cards, lorebooks, and long-term memory.**

**[v0.2.2](https://github.com/Amakurai/dsh-liketavern/releases/tag/v0.2.2) · Built for dsh `0.1.2-rc.1` · Node.js ≥ 24**

[中文](./README.md) | English

[Installation](#installation) · [Getting started](#getting-started) · [Features](#features) · [Compatibility](#compatibility) · [Data and backups](#data-and-backups) · [FAQ](#faq) · [Development](#development)

</div>

Import SillyTavern character cards and prompt presets, manage your setting, continue the story, regenerate replies, and switch branches within dsh. Regular conversations use dsh's model configuration and agent runtime. The interface follows the host's controls and language by default.

EJS prompt templates, a subset of Tavern Helper APIs, and optional native MVU are built in. Whether a third-party card works directly depends on the APIs it uses; see [compatibility](#compatibility) below.

## Installation

### Requirements

| Component | Requirement |
| --- | --- |
| Node.js | 24 or newer; development and CI currently use Node 24 |
| dsh CLI / host | **`0.1.2-rc.1`**; the plugin pins its host dependencies to this version |
| pnpm | Installed and available in your terminal, for `dsh plugin` to manage dependencies |
| Model | Configured in dsh and able to complete a conversation |

If you are new to dsh, start with the [official documentation](https://deepseek-harness.github.io/deepseek-harness/) and run `dsh web` to configure it. The `web` profile initializes automatically on first launch or plugin installation.

### Install a release

Run these commands to install a fixed release tag:

```bash
dsh plugin --profile web add github:Amakurai/dsh-liketavern#v0.2.2
dsh plugin --profile web list --depth 0
```

Once `dsh-liketavern` appears in the list, stop any running dsh instance and start it again:

```bash
dsh web
```

The repository includes compiled `lib/` files; a normal installation needs no manual build. The plugin automatically joins the `web` profile as a bundle. See the official [plugin packaging and installation guide](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish) for how this works.

### Install a tarball

Download `dsh-liketavern-0.2.2.tgz` from the [v0.2.2 Release](https://github.com/Amakurai/dsh-liketavern/releases/tag/v0.2.2), then run this command in the download directory:

```bash
dsh plugin --profile web add ./dsh-liketavern-0.2.2.tgz
```

Restart `dsh web` afterward. The release includes `SHA256SUMS.txt` to verify the download.

### Upgrade

Check the host version in the [changelog](./CHANGELOG.md), stop dsh, and back up your data before running the target version's installation command. Plugin upgrades reuse the existing data directory; see [data and backups](#data-and-backups) for a complete backup.

A GitHub address without a `#version-tag` follows the repository's default branch. Use a release tag or specific commit to keep the installed code fixed. Before upgrading the dsh host, also check that a matching plugin version is available.

## Getting started

1. **Prepare a character.** In dsh settings, open Tavern → Characters to import PNG / JSON or create a character. During import, choose whether to include the card's embedded lorebook.
2. **Start a story.** Create a session, select the `Tavern 模式` preset, and choose a character. New sessions do not automatically bind a default character. The empty picker also offers “Import / create character.”
3. **Choose a greeting.** Use the arrows for cards with multiple greetings, then select “Start chat.” If there is no greeting, type directly into the input.
4. **Adjust the setup.** Open the character control at the top of the conversation to choose the session's prompt preset, persona, and lorebooks. Shared assets are managed in Tavern settings; personas are on the User page.
5. **Continue or revise the story.** Use the actions next to an AI reply to regenerate, edit, roll back, continue, or request AI impersonation. Switch branches at the same turn with `‹ n/m ›`.

**Scripts and MVU:** Manage global, preset, and character scripts under Tavern → Settings → Scripts, including editing, enabled flags, and runtime errors. For automatic MVU, also enable “Enable native MVU updates” in the conversation's character configuration and save. Keep that session page open while it runs.

**Interface language:** The default follows the host: Chinese for a Chinese host locale, English otherwise. Choose a fixed language under Tavern → Settings → Interface → Language. It saves immediately and affects only the plugin interface.

## Features

| Feature | Current support |
| --- | --- |
| Character cards | Import V1 / V2 / V3 PNG and JSON cards; export PNG / JSON; multiple greetings, embedded lorebooks, card regex, and interactive HTML cards |
| Presets and personas | Import, edit, and export ST prompt presets; personas supply the `{{user}}` name and description; preset and persona data is validated on read and write |
| Lorebooks and world state | Global, character, and session lorebooks, keyword triggers, and constant entries; a story delta layer records new, changed, and invalidated facts |
| Long-term memory | BM25 retrieval with time decay and model-driven reads/writes; automatic summaries during idle time when over capacity, retaining searchable archived sources |
| Story branches | Regeneration, editing, and rollback create child sessions and revoke affected memories, variables, and other story state while preserving the original session |
| EJS templates | Conditions, loops, async expressions, story and message variables, JSON / YAML initial values, JSON Patch, Zod, Lodash, Faker, and worldbook decorators |
| Interactive cards and scripts | Sandboxed cards, three script library scopes, persistent story variables, same-page story events, worldbook reads/writes, message editing / deletion / swipes, and display refresh |
| Native MVU | Optional initialization and variable updates after normally completed replies, failed tasks retained for retry, and limited support for status placeholders declared by character display regex |
| Impersonation and continuation | AI impersonation generates user dialogue and copies it to the clipboard; continuation generates more in the current session |

The model has 7 tools: memory search / write / update, per-entry lorebook reads, world-state updates, and asset list / read. It normally replies directly, using tools when setting details are missing or established facts need to be recorded.

Editors provide unsaved-change prompts and draft recovery. Settings, forms, and dialogs adapt to narrow screens; a third-party card's internal mobile layout depends on the card itself.

## Compatibility

### Third-party cards, templates, and scripts

- **Tavern Helper support is a subset.** Variables, script libraries, worldbooks, and several message operations are supported. `generate` / `generateRaw`, message insertion and rotation, history pagination, and cross-page events remain unsupported. See [Tavern Helper compatibility](docs/TAVERN_HELPER.md) for APIs and examples.
- **EJS templates are built in.** Cards using supported APIs do not require a separate ST-Prompt-Template installation. See [prompt templates](docs/PROMPT_TEMPLATES.md) for host differences in prompt placement and history handling.
- **MVU has limits.** A pure official MVU import entry can use the native runner; custom framework code is retained. Classic schemas and the `BEFORE_MESSAGE_UPDATE` body-update hook remain unsupported. The current UI has no separate variable schema editor entry point.
- **Interactive cards run in isolated iframes.** They cannot access the main page DOM, `parent.TavernHelper`, `parent.$`, or Node. Network requests and external scripts are restricted by default; trusted domains can be configured under Settings → Cards & Data. Images and fonts follow the existing loading policy.
- **Script choices do not send messages.** Clicking a script's text option fills the current input draft. AI impersonation still uses the clipboard and requires manual pasting.

### Prompts, sampling, and message operations

| Area | Actual behavior |
| --- | --- |
| Sampling | `temperature`, `maxTokens`, `stop`, and model-published reasoning levels can take effect; `top_p` and penalties are recorded only. The plugin cannot override a host setting that locks reasoning off |
| Prompt preview | “Last host request” shows a captured request before adapter conversion. Other tabs recompute an ST simulation and do not represent the actual model input |
| Regex and placement | Live display uses `output/render`; history rewriting in `input/send`, `prompt/assemble`, and `prompt/send` applies only to simulation and impersonation. Static depth content enters the standing prompt; dynamic `@D` and author notes enter per-turn context |
| Editing and deletion | Message edits, rollback, regeneration, and script-driven deletion use branches and preserve the original session. Editing an AI reply revokes derived facts from that turn onward, without automatically extracting replacements or generating a reply |
| Rollback scope | Rollback covers plugin story state. Tool side effects outside the story workspace are not undone |

## Data and backups

Plugin data lives in `$DSH_HOME/dsh-tavern/`. With no `DSH_HOME` override, this defaults to `~/.dsh/dsh-tavern/` (`%USERPROFILE%\.dsh\dsh-tavern\` on Windows). Host chat logs and configuration also live elsewhere within dsh's data directory; for a complete migration or upgrade backup, stop dsh and copy the entire `DSH_HOME`.

**Character assets are shared; story state is isolated.** Cards, presets, and script assets can be reused. Each story and branch independently stores memories, world changes, notes, chat lorebooks, variables, and rollback logs. New stories copy the character's initial state; changing “Initial state” affects future stories. Multiple host processes must not write to the same data directory concurrently.

| Save mechanism | What it includes | Recovery and limits |
| --- | --- | --- |
| Interactive-card variable backup | Saved variables from the selected story, up to 1 MiB of variable data | Select a character and story under Settings → Cards & Data, then export or paste a backup to restore. Excludes message text, cards, script assets, and form inputs not yet stored as variables |
| Editor draft backup | Unsaved character, preset, lorebook, persona, regex, memory, and settings edits | After the saved-draft status appears, refresh the same browser tab or reopen the editor to recover it. Save is still required to apply changes. Each draft is limited to 2 MiB |
| Complete directory backup | Plugin data plus host sessions, configuration, and other data | Stop dsh and back up the entire `DSH_HOME`. Variable exports cannot replace this backup |

Editor drafts are stored in `editor-drafts/` inside the plugin data directory; browser storage holds only a random tab ID. Recovery is not guaranteed after closing the tab or disabling browser storage. Failed backups preserve the page content and offer retry; explicitly discarding an edit removes its draft. Interactive data in character previews is temporary and does not update a real story.

Legacy shared state is copied into isolated stories on first access to an old binding, preserving the original directory. Previously mixed branch facts cannot be separated reliably and need review after migration. Automatic summaries may omit information, but their original sources remain available; failed, truncated, or timed-out replies do not trigger archiving. Branches and archives consume disk space, and old stories are not automatically cleaned up.

## FAQ

**No Tavern mode or settings after installation?** Run `dsh --version` to confirm host version `0.1.2-rc.1`, then `dsh plugin --profile web list --depth 0` to check the installation target. Restart `dsh web` and create a new session. If Tavern is still missing, check the terminal for plugin loading errors.

**The card displays, but buttons, scripts, or MVU do not work?** Under Settings → Scripts, check that the script and its folder are enabled and saved, then inspect the current session's runtime diagnostics. MVU also requires the session's automatic update option and an open page. Check [compatibility](docs/TAVERN_HELPER.md) for cards relying on parent-window objects or unsupported APIs.

**pnpm reports a blocked build script?** The plugin ships compiled output; first identify the dependency named in the error. A release tarball may resolve a plugin source-build problem. Host dependency build requirements still need to be addressed by following dsh's message and checking `allowBuilds` in that profile's `pnpm-workspace.yaml`.

When reporting a problem, include plugin and dsh versions, reproduction steps, relevant errors, and a minimal example with private content removed. Reports are welcome in [GitHub Issues](https://github.com/Amakurai/dsh-liketavern/issues).

## Documentation

The detailed guides below are currently in Chinese.

| Document | Contents |
| --- | --- |
| [Changelog](./CHANGELOG.md) | Version changes and corresponding host versions |
| [Tavern Helper compatibility](docs/TAVERN_HELPER.md) | Card, script, variable, worldbook, message, and MVU APIs |
| [Prompt templates](docs/PROMPT_TEMPLATES.md) | EJS, macros, decorators, and examples |
| [Architecture](docs/ARCHITECTURE.md) | Story isolation, branch rollback, memory, and prompt channels |
| [Host compatibility](docs/HOST_COMPATIBILITY.md) | Verified host behavior and upgrade checks |
| [Dependency security](docs/DEPENDENCY_SECURITY.md) | Security updates, remaining Showdown advisories, and sandbox boundaries |
| [Development conventions](./AGENTS.md) | Code boundaries, testing, and delivery requirements |

## Development

From the repository root, using Node 24:

```bash
npm ci
npm run build
npm test
npm pack --dry-run
```

`lib/` is a committed deliverable. After changing `src/`, rebuild and commit the matching output. `npm pack` builds first; packages contain only compiled output, plugin configuration, presets, and release documentation. Tests use hand-written factory data; do not commit real cards, sessions, or memories.

<details>
<summary>Local linking and debugging</summary>

Run `dsh web` once to initialize the profile, then link the repository at `$DSH_HOME/profiles/node_modules/dsh-liketavern`. These examples use the default `~/.dsh`; replace the path if you use a custom `DSH_HOME`. Use a dedicated development data directory so an installed release does not shadow the local link.

```powershell
# Windows (PowerShell, from the repository root)
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.dsh\profiles\node_modules" | Out-Null
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-liketavern" -Target (Get-Location).Path
```

```bash
# macOS / Linux (from the repository root)
mkdir -p ~/.dsh/profiles/node_modules
ln -s "$(pwd)" ~/.dsh/profiles/node_modules/dsh-liketavern
```

Once linked, run `npm run dev`, which starts `dsh web --patch ./cordis.patch.yml`. After code changes, run `npm run build` and restart the development instance to verify them.

</details>

```text
src/
├── core/     Pure functions: prompts, lorebooks, regex, macros, BM25, compatibility data
├── state/    File storage: character assets, story workspaces, memory, rollback logs
├── node/     Host coordination: config, service, pipeline, turns, tools, maintenance
├── client/   React UI: management pages, conversation actions, cards, script runners
├── index.ts  Host entry
├── agent.ts  Agent entry
└── remote.ts Frontend/backend business contract
```

## License

[MIT](./LICENSE)
