<div align="center">

# dsh-liketavern

**Tavern-style roleplay in DeepSeek Harness's `dsh web`, with character cards, lorebooks, and long-term memory.**

**[v0.3.1](https://github.com/Amakurai/dsh-liketavern/releases/tag/v0.3.1) · Targets dsh `0.1.5-rc.2` · Node.js ≥ 24**

[中文](./README.md) | English

[Features](#features) · [Installation](#installation) · [Getting started](#getting-started) · [Everyday use](#everyday-use) · [Compatibility](#compatibility)

[Data and backups](#data-and-backups) · [FAQ](#faq) · [Documentation](#documentation) · [Development](#development) · [Contributing](#contributing)

</div>

dsh-liketavern is a roleplay plugin for DeepSeek Harness. Import SillyTavern (ST) character cards and prompt presets, manage your setting, continue the story, regenerate replies, and switch branches within dsh. The host provides model connections, chat history, and the agent runtime; the plugin manages character assets, prompt assembly, and story state. Its interface follows the host language by default.

EJS prompt templates, a subset of Tavern Helper APIs, and optional native MVU are built in. Whether a third-party card works directly depends on the APIs it uses; see [compatibility](#compatibility) below.

For your first conversation, start with [installation](#installation) and [getting started](#getting-started). When bringing existing ST assets, check [key concepts](#key-concepts) and [compatibility](#compatibility). Developers and card authors can use the [documentation guide](#documentation).

## Features

| Feature | Current support |
| --- | --- |
| Character cards | Import V1 / V2 / V3 PNG and JSON cards; export PNG / JSON; recoverable archiving and reference-protected permanent deletion; multiple greetings, embedded lorebooks, card regex, and interactive HTML cards |
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

Character management, the archive, and the new-session character picker support searching by character name, tags, creator, or embedded lorebook name.

### Key concepts

| Term | Purpose and distinction |
| --- | --- |
| Tavern mode | The dsh session preset that enables the plugin's roleplay runtime; select it when creating a session |
| Prompt preset | An ST prompt configuration managed on Tavern's Presets page and selected for a character session; the built-in default is enough to get started |
| Character card / persona | A card describes the character played by the AI; a persona describes your identity in the story and supplies the `{{user}}` name |
| Lorebook / memory / world state | Lorebooks provide background settings; memories record story facts; world state records additions, changes, and invalidations during the story |
| Session / story / branch | A session holds chat history, and its bound story holds plugin state; actions such as regeneration create a child session with its own story |
| MVU | A variable-update framework used by some cards; the plugin provides an optional native runner for cards that need it |

## Installation

### Requirements

| Component | Requirement |
| --- | --- |
| Node.js | 24 or newer; development and Windows / Ubuntu CI currently use Node 24 |
| dsh CLI / host | **`0.1.5-rc.2`**; the plugin pins its host dependencies to this version |
| pnpm | Installed and available in your terminal, for `dsh plugin` to manage dependencies |
| Model | Configured in dsh and able to complete a conversation |

If you are new to dsh, start with the [official documentation](https://deepseek-harness.github.io/deepseek-harness/) and run `dsh web` to configure it. The `web` profile initializes automatically on first launch or plugin installation.

### Install a release

Run these commands to install a fixed release tag:

```bash
dsh plugin --profile web add github:Amakurai/dsh-liketavern#v0.3.1
dsh plugin --profile web list --depth 0
```

Once `dsh-liketavern` appears in the list, stop any running dsh instance and start it again:

```bash
dsh web
```

The repository includes compiled `lib/` files; a normal installation needs no manual build. The plugin automatically joins the `web` profile as a bundle. See the official [plugin packaging and installation guide](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish) for how this works.

### Install a tarball

Download `dsh-liketavern-0.3.1.tgz` from the [v0.3.1 Release](https://github.com/Amakurai/dsh-liketavern/releases/tag/v0.3.1), then run this command in the download directory:

```bash
dsh plugin --profile web add ./dsh-liketavern-0.3.1.tgz
```

Restart `dsh web` afterward. The release includes `SHA256SUMS.txt` to verify the download.

### Upgrade

Open **Settings → Tavern → About** to see plugin and host versions, visit the GitHub project, and check the latest stable release. A compatible newer release includes a command pinned to its release tag. This host installs updates through the terminal; checking does not install anything. Source checkouts show instructions to update and rebuild their source. Replace `web` in the command if you use a custom profile.

Check the host version in the [changelog](./CHANGELOG.md), stop dsh, and back up your data before running the target version's installation command. Plugin upgrades reuse the existing data directory; see [data and backups](#data-and-backups) for a complete backup.

A GitHub address without a `#version-tag` follows the repository's default branch. Use a release tag or specific commit to keep the installed code fixed. Before upgrading the dsh host, also check that a matching plugin version is available.

## Getting started

Configure a model in dsh first, then try an ordinary conversation with one character card. You can use the built-in prompt preset and add personas, extra lorebooks, scripts, or MVU as your card requires.

1. **Prepare a character.** In dsh settings, open Tavern → Characters to import PNG / JSON or create a character. Review the compatibility report before choosing whether to include the embedded lorebook. Cancelling saves no character. The report statically checks known APIs, scripts, templates, and external resources; it executes no code and cannot guarantee third-party compatibility.
2. **Start a story.** Create a session, select the `Tavern 模式` preset, and choose a character. New sessions do not automatically bind a default character. The empty picker also offers “Import / create character.”
3. **Check the setup.** Open the character control at the top of the conversation to select and save the session's prompt preset, persona, and lorebooks. Keep the defaults if you have no additional assets yet.
4. **Begin the conversation.** Use the arrows for cards with multiple greetings, select “Start chat,” and send your first line. If there is no greeting, type directly into the input.
5. **Continue or revise the story.** Use the actions next to an AI reply to regenerate, edit, roll back, continue, or request AI impersonation. Switch branches at the same turn with `‹ n/m ›`.

After the first normally completed reply, open Prompt preview → Last request from the conversation's character control to inspect the captured request. For cards that use scripts, continue with [scripts and native MVU](#scripts-and-native-mvu).

## Everyday use

### Where to configure things

In this table, “Tavern” refers to the Tavern management page in dsh settings.

| Task | Location | Scope |
| --- | --- | --- |
| Manage character cards, prompt presets, lorebooks, and personas | Tavern → Characters / Presets / Lorebooks / User | Shared assets, used in subsequent prompt assembly for sessions using those assets |
| Set defaults for future character selections | Tavern → Settings → Defaults | Applied when choosing a character in a new session; existing bindings are adjusted separately |
| Change the current session's preset, persona, lorebooks, and author note | Character control at the top of the conversation | Current session, used for later turns after saving |
| Write a lorebook specific to this story | Conversation character control → Edit session lorebook | Current story, inherited and rolled back with branches |
| Inspect or edit memories, world state, and character notes | Conversation character control → Memory, or Tavern → Memory | Current / selected story; choosing “Initial state” affects only future stories |
| Manage regex, scripts, and variable backups | Tavern → Regex; Tavern → Settings → Scripts / Cards & Data | Regex and scripts follow the selected source; variable backups target the selected character and story |
| Inspect prompts and lorebook triggers | Conversation character control → Prompt preview | Current session, read-only |

The prompt plan is fixed after each turn's first successful assembly. Asset or setting changes made during generation apply on the next turn. The interface language follows the host by default: Chinese for a Chinese host locale, English otherwise. To choose a fixed language, use Tavern → Settings → Interface → Language; it saves immediately and affects only the plugin interface.

### Scripts and native MVU

1. Under Tavern → Settings → Scripts, select the global, preset, or character script library. Check that the script and its folder are enabled, then save changes.
2. For cards needing automatic MVU, enable “Enable native MVU updates” in the conversation's character configuration and save. Ordinary conversations can leave it off.
3. Keep that session page open and inspect runtime status and errors on the Scripts page. Failed or disconnected updates remain pending; see [Tavern Helper compatibility](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/TAVERN_HELPER.md) for supported APIs.

### What happens when you revise a story

Suppose the original session has recorded “the character obtained the key,” and you regenerate from before that event. The plugin creates a child session and revokes memories, variables, and other state from turns that the child does not inherit. The original session keeps its existing story. Both stories then evolve independently while continuing to share reusable cards and presets.

Editing an AI reply also creates a branch and revokes derived facts from that turn onward. After saving, continue the conversation or revise the state manually. Continuation generates more in the current session. See [prompts, sampling, and message operations](#prompts-sampling-and-message-operations) for the detailed boundaries.

## Compatibility

### Third-party cards, templates, and scripts

- **Tavern Helper support is a subset.** Variables, script libraries, worldbooks, and several message operations are supported. `generate` / `generateRaw`, message insertion and rotation, history pagination, and cross-page events remain unsupported. See [Tavern Helper compatibility](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/TAVERN_HELPER.md) for APIs and examples.
- **EJS templates are built in.** Cards using supported APIs do not require a separate ST-Prompt-Template installation. See [prompt templates](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/PROMPT_TEMPLATES.md) for host differences in prompt placement and history handling.
- **Message formatting now uses markdown-it.** Vulnerable Showdown has been removed, with common display syntax retained. Saved replies are not reformatted. Before upgrading, back up, finish pending template generation, and let cross-turn callbacks expire. Old active replay logs are explicitly refused and preserved for completion or rollback; see the template guide above for format differences and recovery steps.
- **MVU has limits.** A pure official MVU import entry can use the native runner; custom framework code is retained. Classic schemas and the `BEFORE_MESSAGE_UPDATE` body-update hook remain unsupported. The current UI has no separate variable schema editor entry point.
- **Interactive cards run in isolated iframes.** They cannot access the main page DOM, `parent.TavernHelper`, `parent.$`, or Node. Network requests and external scripts are restricted by default; trusted domains can be configured under Settings → Cards & Data. Images and fonts follow the existing loading policy.
- **Script choices do not send messages.** Clicking a script's text option fills the current input draft. AI impersonation still uses the clipboard and requires manual pasting.

### Prompts, sampling, and message operations

| Area | Actual behavior |
| --- | --- |
| Sampling | Imported presets retain supported sampling fields and override plugin settings field by field; omitted fields use plugin settings. Reimport older presets to recover parameters that were previously discarded. `temperature`, `maxTokens`, `stop`, and model-published reasoning levels selected in plugin settings can take effect; `top_p` and penalties are stored with a notice. The plugin cannot override a host setting that locks reasoning off |
| Prompt preview | “Last request” shows messages after layout and system-capability processing, with compatibility notes, for the official DeepSeek route; other routes show the host request. Other tabs recompute an ST simulation and do not represent actual model input |
| Preset semantics | Character main and post-history instructions replace the original slots, respecting toggles, generation triggers and override restrictions. Settings → Prompts can disable these two character overrides independently. Only `{{original}}` retains the original text. Reads of dynamic macro variables enter per-turn context; static variables can still use the stable prefix |
| Preset formats and macros | Retains `wi_format`, `scenario_format`, and `personality_format`; empty formats send the original fields. Reimport older presets to recover discarded formats. `lastmessage` reads the last real user or character message; `charPrompt` / `charInstruction` read character prompt fields. The exported `system_prompt` built-in marker is independent of role, preserving custom system entries on round trips |
| Preset message placement | The official DeepSeek route automatically uses the Tavern adapter to insert preset roles at their ordered history positions. Models supporting system updates receive complete system snapshots; models reading only a leading system message receive combined system entries there, while user/assistant positions remain intact. The host conversation, tools, credentials and streaming flow remain in use. Layouts are frozen each turn without replacing history. Other providers retain the standing/turn mapping |
| Regex and assistant prefill | Live display uses `output/render`; history regex edits apply to simulation and impersonation. Trailing assistant entries are sent as ordinary assistant messages. Provider-specific prefill/prefix protocols are not implemented, so continuation from that text is not guaranteed |
| Editing and deletion | Message edits, rollback, regeneration, and script-driven deletion use branches and preserve the original session. Editing an AI reply revokes derived facts from that turn onward, without automatically extracting replacements or generating a reply |
| Rollback scope | Rollback covers plugin story state. Tool side effects outside the story workspace are not undone |

<details>
<summary>Tool calls and custom hosts: PTC requirements</summary>

Tavern uses dsh's native PTC (programmatic tool calling). When it needs to look up or record information, the model can combine operations in one `run_code`, run independent reads in parallel, and return only relevant results. Writes retain the current story's floor transactions. Restart dsh after updating to reload the managed Tavern preset. Custom hosts must provide `codeRuntime`, as required by the built-in PTC mode.

</details>

## Data and backups

### Storage and isolation

Plugin data lives in `$DSH_HOME/dsh-tavern/`. With no `DSH_HOME` override, this defaults to `~/.dsh/dsh-tavern/` (`%USERPROFILE%\.dsh\dsh-tavern\` on Windows). Host chat logs and configuration also live elsewhere within dsh's data directory; for a complete migration or upgrade backup, stop dsh and copy the entire `DSH_HOME`.

**Character assets are shared; story state is isolated.** Cards, presets, and script assets can be reused. Each story and branch independently stores memories, world changes, notes, chat lorebooks, variables, and rollback logs. New stories copy the character's initial state; changing “Initial state” affects future stories. Multiple host processes must not write to the same data directory concurrently.

### Choosing a backup method

| Save mechanism | What it includes | Recovery and limits |
| --- | --- | --- |
| Interactive-card variable backup | Saved variables from the selected story, up to 1 MiB of variable data | Select a character and story under Settings → Cards & Data, then export or paste a backup to restore. Excludes message text, cards, script assets, and form inputs not yet stored as variables |
| Editor draft backup | Unsaved character, preset, lorebook, persona, regex, memory, and settings edits | After the saved-draft status appears, refresh the same browser tab or reopen the editor to recover it. Save is still required to apply changes. Each draft is limited to 2 MiB |
| Verified directory backup | Plugin data, host sessions, and configuration inside `DSH_HOME`, with versions, sizes, and SHA-256 hashes | Create, verify, and restore into a new directory using the commands below. Reinstallable profile dependencies are excluded; variable exports cannot replace this backup |

Editor drafts are stored in `editor-drafts/` inside the plugin data directory; browser storage holds only a random tab ID. Recovery is not guaranteed after closing the tab or disabling browser storage. Failed backups preserve the page content and offer retry; explicitly discarding an edit removes its draft. Interactive data in character previews is temporary and does not update a real story.

### Migration and recovery

Run these commands from the plugin source or installation directory, replacing the example paths. Backup and restore destinations must not exist; their parent directories must already exist.

```sh
node lib/backup.js create --home "C:/data/dsh-home" --backup "D:/backups/dsh-2026-09-19" --offline
node lib/backup.js verify --backup "D:/backups/dsh-2026-09-19"
node lib/backup.js restore --backup "D:/backups/dsh-2026-09-19" --target "C:/data/dsh-restored" --offline
```

If installed on your command path, replace `node lib/backup.js` with `dsh-tavern-backup`. Add `--json` for structured output. Verification rejects missing, altered, or extra files and checks plugin structure, binding references, and WAL. Restore validates and copies into staging before publishing a new directory; it never overwrites existing data. Compressed host history is verified as bytes, without full semantic parsing; open restored sessions to confirm they work.

1. Stop all dsh processes using the data directory before creating a backup. `--offline` declares that you have done so; active PID locks can be rejected, but the tool cannot prove that every writer has stopped.
2. Restore into a separate directory, check the preserved profile configuration and lockfiles, install the corresponding dsh and plugin versions, and point `DSH_HOME` at the restored directory. Keep the original backup. Manifest versions describe the backup tool's environment, not proof of the versions that last wrote the data.
3. Check characters, sessions, branches, memories, and saved variables before following the target version's upgrade instructions.

Profile configuration and lockfiles are preserved. Only `profiles/node_modules`, `profiles/<name>/node_modules`, and `profiles/<name>/.dsh-module-fallback/node_modules` are excluded; reinstall dependencies for the original profiles after restoring. Symlinks, junctions, hardlinks, and special files elsewhere are rejected instead of followed. Back up any custom plugin data, workspaces, or credentials outside `DSH_HOME` separately. Directory backups are unencrypted and may contain local credentials and private conversations; protect them like the original data.

Legacy shared state is copied into isolated stories on first access to an old binding, preserving the original directory. Previously mixed branch facts cannot be separated reliably and need review after migration. Automatic summaries may omit information, but their original sources remain available; failed, truncated, or timed-out replies do not trigger archiving. Branches and archives consume disk space, and old stories are not automatically cleaned up.

## FAQ

| Problem | What to check |
| --- | --- |
| No Tavern mode or settings after installation | Confirm host version `0.1.5-rc.2` with `dsh --version`, then check the installation target with `dsh plugin --profile web list --depth 0`. Restart `dsh web` and create a new session; if Tavern is still missing, check the terminal for plugin loading errors |
| Changing the default preset did not change the current conversation | Defaults apply when selecting a character in a new session. Change and save the current session's configuration through its character control |
| The card displays, but buttons, scripts, or MVU do not work | Check that interactive cards are enabled, then confirm that the script and its folder are enabled and saved under Settings → Scripts. Inspect runtime diagnostics; automatic MVU also needs its session option enabled and the page open. Check the required APIs against [compatibility](#compatibility) |
| The memory page is empty, or an edit did not affect the current story | Check the selected character and story, including whether “Initial state” is selected. Long-term memories are written by model tools or manually; chat messages are not automatically copied into memory one by one |
| Prompt preview does not match model behavior | Inspect “Last request” and its compatibility notes first; other tabs are ST simulations. A new session without a request, a host restart, or cache eviction can leave the last-request view empty |
| pnpm reports a blocked build script | Identify the dependency named in the error. Try a release tarball for a plugin source-build problem; for host dependencies, follow dsh's message and check `allowBuilds` in that profile's `pnpm-workspace.yaml` |

### Read-only diagnostics

In an installed environment, run:

```bash
dsh plugin --profile web exec dsh-tavern-doctor
dsh plugin --profile web exec dsh-tavern-doctor --json
```

In a source checkout, use `npm run doctor` and `npm run doctor -- --json`. Reports contain only versions, directory states, aggregate character/story/WAL (rollback log) counts, and fixed issue codes. They never print real paths, asset names, IDs, message text, or tokens, and there is no repair option.

If the problem remains, provide a minimal reproduction using the [bug-report guidance](#reporting-problems).

## Documentation

The detailed guides below are currently in Chinese.

| What you want to understand | Guide |
| --- | --- |
| Version changes and host requirements for upgrades | [Changelog](./CHANGELOG.md) |
| Card, script, variable, worldbook, message, and MVU APIs | [Tavern Helper compatibility](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/TAVERN_HELPER.md) |
| EJS, macros, decorators, and template examples | [Prompt templates](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/PROMPT_TEMPLATES.md) |
| Third-party API coverage and acceptance criteria | [Tavern Helper integration progress](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/TAVERN_HELPER_INTEGRATION.md), [ST template compatibility audit](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/ST_COMPATIBILITY_AUDIT.md) |
| Story isolation, branch rollback, memory, and prompt channels | [Architecture](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/ARCHITECTURE.md) |
| Verified host behavior, UI smoke-test coverage, and upgrade checks | [Host compatibility](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/HOST_COMPATIBILITY.md) |
| Dependency security updates, remaining advisories, and isolation boundaries | [Dependency security](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/DEPENDENCY_SECURITY.md) |
| Code boundaries, tests, package review, and delivery requirements | [Development conventions](https://github.com/Amakurai/dsh-liketavern/blob/main/AGENTS.md), [Release package review](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/RELEASING.md) |

## Development

### Environment and validation

The development stack is TypeScript ESM (NodeNext), React, and Vitest. Clone this repository and enter its directory; `package.json` defines the current host package versions.

From the repository root, using Node 24:

```bash
npm ci
npm run build
npm test
npm pack --dry-run
```

`lib/` is a committed deliverable. After changing `src/`, rebuild and commit the matching output. `npm pack` builds first; packages contain only compiled output, plugin configuration, presets, and release documentation. Tests use hand-written factory data; do not commit real cards, sessions, or memories.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start local dsh web using the repository's `cordis.patch.yml`; complete the linking steps below first |
| `npm run doctor` | Inspect the current `DSH_HOME` without modifying data |
| `npm run doctor:check` | Verify the compiled diagnostic entry point, installed links, and JSON output in a temporary environment |
| `npm run package:check` | Check the package allowlist, required output, and relative links in release documents; build first |

CI runs builds, tests, diagnostic entry checks, and package checks on Ubuntu and Windows. Ubuntu also verifies that `lib/` matches the committed output. Host upgrades additionally require boot and UI smoke checks in an installed environment; see [host compatibility](https://github.com/Amakurai/dsh-liketavern/blob/main/docs/HOST_COMPATIBILITY.md).

### Local linking and debugging

<details>
<summary>Expand Windows / macOS / Linux linking examples</summary>

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

### Repository layout

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

`test/` holds behavior and integration tests, `scripts/` holds build and delivery checks, `presets/` holds the Tavern host preset, `docs/` holds detailed guides, and `lib/` holds release output.

## Contributing

### Reporting problems

When opening a [GitHub issue](https://github.com/Amakurai/dsh-liketavern/issues), include:

- Plugin, dsh, and Node.js versions, operating system, browser, and installation method.
- The page and steps involved, expected and actual behavior, and relevant errors or read-only diagnostic results.
- A minimal reproduction with private content removed. For third-party cards, identify the scripts or APIs they require; a hand-written test card is useful.

For prompt problems, state whether you inspected “Last request” or an ST simulation. Remove secrets, private stories, and personal information from screenshots and logs before sharing them.

### Code and documentation

PRs for documentation corrections, translations, minimal reproductions, and API adapters are welcome. For larger features or compatibility changes, consider opening an issue describing the use case and expected behavior first.

Read the [development conventions](https://github.com/Amakurai/dsh-liketavern/blob/main/AGENTS.md) before starting. Add behavior tests for core/state changes and integration tests for host events, branches, requests, or failures; rebuild and include compiled output after source changes. Keep the Chinese and English README instructions aligned, and describe the reason for the change and the validation actually performed in your PR.

## License

[MIT](./LICENSE)
