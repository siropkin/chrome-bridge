<p align="center"><img src="docs/creation-of-adam.png" width="600" alt="The Creation of Adam — two hands nearly touching, a spark between them"></p>

# chrome-bridge

**English** | [中文](README.zh-CN.md)

[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A5%2018-339933)](https://nodejs.org) [![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)

A small, open-source CLI bridge for **shell-capable AI agents** to work in the Chrome you're already using: your open tabs, logged-in sessions and SSO. One Chrome extension connects to a local Node server and CLI with no third-party runtime dependencies. No separate browser or MCP server is required. Driven tabs show a 🟣 pill with the current action and its history.

Use it to inspect a page, check a user flow, fill a form, or investigate network and performance behavior. The bridge connection is local; **your chosen AI agent may send received page content to its model provider**. Existing-browser access and CLI automation are not exclusive to Chrome Bridge; [compare the trade-offs](#how-it-compares).

![a driven tab in motion — the 🟣 pill narrates each action, a purple frame lights up while a command runs, the pointer flashes where the agent clicks](docs/demo.gif)

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/chrome-bridge/kmhjlnokjigmnimgjjmiahlinjbcebkg)**, or `git clone` this repo and load the unpacked folder.

## Quick start

Needs macOS or Linux (Git Bash on Windows), Chrome ≥ 117 and Node ≥ 18.

**Chrome Web Store (easiest).** Install the extension, click its toolbar button, choose **Copy setup prompt for your AI agent**, and paste the prompt to your agent (Claude Code, Cursor, …). The agent downloads the bridge, starts it, checks the connection and reports back. The popup shows ● bridge ready when it's done.

**From source.** Tell your agent:

```text
read https://raw.githubusercontent.com/siropkin/chrome-bridge/master/docs/agent-setup.md and do what it says
```

It clones the repo, starts the bridge and sets up its own integration. Then it asks you for the one step Chrome won't let a script do: open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick the `extension/` folder. Skip that step if you installed from the Web Store. Loading both copies makes every command ask for `--profile`.

<details>
<summary>Agent can't open URLs? Paste this prompt instead</summary>

````text
Set up chrome-bridge — the bridge that lets you drive my real, logged-in Chrome — and install your end of it. Do every step yourself and tell me the result of each. The only thing I do is the one-time extension load in Chrome (step 3).

1. Pick the repo root `<repo>`:
   - if your working directory is already a chrome-bridge checkout (it contains `cli.mjs` and `AGENTS.md`), use it;
   - else if `~/chrome-bridge/cli.mjs` exists, run `git -C ~/chrome-bridge pull --ff-only` (if the pull fails, show me the error and keep the existing copy) and use `~/chrome-bridge`;
   - else clone it and use `~/chrome-bridge`:

     ```
     git clone https://github.com/siropkin/chrome-bridge.git ~/chrome-bridge
     ```

     (if the clone fails — e.g. `~/chrome-bridge` exists with other content — show me the error and stop; don't delete or move anything)

   Substitute `<repo>` with the real path everywhere below.

2. Bring the bridge up on this checkout's code (needs Node ≥ 18 — if Node is missing or older, tell me and stop; don't install or upgrade anything yourself):

   ```
   node <repo>/cli.mjs stop
   node <repo>/cli.mjs start
   node <repo>/cli.mjs health
   ```

   (`stop` reporting "nothing was running" is fine; the stop-then-start pair guarantees the server runs the code you just fetched, not some older copy from another location — a loaded extension reconnects on its own.)

   - health prints a ⚠ line saying the loaded extension's version differs from the repo → run `node <repo>/cli.mjs extreload` (reloads the extension from disk), then re-run health; if the warning persists, ask me to reload the extension at `chrome://extensions`.
   - health reports `"extension":true` (with no ⚠) → jump to step 4.
   - health reports `"extension":false` → step 3. But if the extension was connected before your restart, wait ~10s and re-run health once first — it reconnects on its own after a server restart.
   - server won't start → show me the error and the last lines of `<repo>/server.log` (if it exists), then stop.

3. The one click only I can do — unless I installed Chrome Bridge from the [Chrome Web Store](https://chromewebstore.google.com/detail/chrome-bridge/kmhjlnokjigmnimgjjmiahlinjbcebkg), in which case skip this step entirely: the store copy connects on its own, and loading the unpacked folder too creates a second profile seat that makes every command demand `--profile`. Otherwise: ask me to open `chrome://extensions`, enable Developer mode, click Load unpacked, and select the `<repo>/extension` folder. On macOS you may run `open -a "Google Chrome" "chrome://extensions"` first. Then poll `node <repo>/cli.mjs health` every 5s (up to ~90s) until it reports `"extension":true`; if it doesn't, tell me what's still missing and stop — don't keep polling.

4. Install your integration — pick the ONE that applies to you:
   - Claude Code — link the skill so it auto-loads on browser tasks in every project and tracks every repo update (use `./.claude/skills/` instead of `~/.claude/skills/` only if I told you to scope it to this project):

     ```
     rm -rf ~/.claude/skills/chrome-bridge && mkdir -p ~/.claude/skills && ln -s <repo>/.claude/skills/chrome-bridge ~/.claude/skills/chrome-bridge
     ```

     (without the trailing slash, `rm -rf` removes only an old symlink or copy, never the repo. On Windows / Git Bash without symlink rights, fall back to `cp -r <repo>/.claude/skills/chrome-bridge ~/.claude/skills/` — and re-copy after every update, a copy goes stale)

   - any other agent (Cursor, Qwen, GLM, Kimi, …) — append this line to the instructions file you read at session start (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, …; create it in the project you're working in if none exists), but only if it's not already there. If your instructions live somewhere you can't edit, print the line and tell me to paste it there:

     ```
     To drive my Chrome browser (real logged-in tabs), read <repo>/AGENTS.md and run `node <repo>/cli.mjs <command>`. If the health check fails, run `node <repo>/cli.mjs start`; it waits briefly for an already-loaded extension to reconnect. If health still reports the extension disconnected afterward, tell me to reload it.
     ```

5. Tell me the bridge is up. From the next session your integration auto-loads; in this one, read `<repo>/AGENTS.md` when a browser task comes up.
````

</details>

**By hand.**

```bash
git clone https://github.com/siropkin/chrome-bridge && cd chrome-bridge && ./install.sh
```

Load the `extension/` folder as described above, then point your agent at [AGENTS.md](AGENTS.md), the full operating manual.

Check that it worked: `node cli.mjs health` should print `{"ok":true,"extension":true}`. You won't see anything in Chrome until the agent sends its first command; that's normal. To point the agent at one exact tab, use **Copy tab reference** in the toolbar popup and paste the `id:…` it gives you.

If chrome-bridge works for you, a [★ rating on the Chrome Web Store](https://chromewebstore.google.com/detail/chrome-bridge/kmhjlnokjigmnimgjjmiahlinjbcebkg) helps other people find it.

## How it works

The extension connects to a small local server on `127.0.0.1:9333`. Your agent drives it through the CLI:

```bash
node cli.mjs snap localhost:8082         # the page as a compact tree with element refs
node cli.mjs click localhost:8082 @e4    # click by ref
node cli.mjs fill localhost:8082 @e2 "hello@example.com"
node cli.mjs shot localhost:8082 out.png # screenshot, only when pixels matter
```

A `snap` shows the page as a short text tree. The agent can limit it to one part of the page or get only what changed since the last snap, and it acts on the `@e` refs instead of guessing pixel coordinates:

```
table "Hacker News new | past | comments | ask | show | jobs | submit" @e1
  link "Hacker News" @e5
  link "new" @e6
  link "submit" @e12
table "1. Playa Phone (playaphone.com) 122 points by cutoff 1 hour…" @e14
  link "Playa Phone" @e16
  link "41 comments" @e21
```

Writing your own agent loop? Skip the CLI and send JSON to `POST http://127.0.0.1:9333/cmd`, for example `{"type": "snap", "urlMatch": "…"}`.

## Example workflows

- "Check my dashboard every morning and post the change to Slack." A cron-launched agent uses the tab that's already logged in. If a login wall shows up, `wait --human` hands the tab to you.
- Fill a CMS from a CSV without logging in again.
- Compare a staging build against the Figma mockup. [design-eye.md](design-eye.md) is the checklist, and there's an 8px alignment grid overlay.
- See a page in a mobile view without resizing your window: `emulate <tab> 390 844 mobile`.
- Work in an existing authenticated session, including SSO and internal dashboards behind a VPN. This does not bypass login challenges or anti-bot restrictions.

A real run, checked live on GitHub: [recipes/github.com.md](recipes/github.com.md) sets a repo's social preview image.

## You stay in control

- **Every tab the agent touches wears a 🟣 pill**, including tabs it only reads. The pill shows what's happening right now (`🟣 taking screenshot…`) and keeps a history of past actions. Driven tabs also join a 🟣 tab group, which a page can't fake.
- **⏏ on the pill disconnects the agent from that tab.** The bridge refuses subsequent commands until an explicit `mark`; the agent is instructed to ask you before reclaiming it. An action already running may still finish. This is a workflow control, not a security boundary against a malicious local agent.
- **The toolbar popup releases the current tab, or every agent tab at once.**
- **`node cli.mjs watch`** prints every command live in your terminal.

![the 🟣 pill narrating a driven tab, with its action history open](docs/store/screenshot-1-pill.png)

## How it compares

Based on the linked official documentation, checked 2026-11-05. These are workflow trade-offs, not a ranking or a benchmark.

| Option | Where it fits |
|---|---|
| **Chrome Bridge** | A small, MIT-licensed extension plus local Node server/CLI with no third-party runtime dependencies. Designed around existing Chrome tabs, shell commands, scoped/diff snapshots, in-page action narration, and explicit profile routing. |
| **[Playwright extension + MCP](https://github.com/microsoft/playwright/tree/main/packages/extension#readme)** | Also connects to existing logged-in tabs. Its documented controls include connection approval, per-client tab groups and disconnection. It is a valid alternative for an MCP-based workflow. |
| **[Playwright CLI + skills](https://github.com/microsoft/playwright-cli)** | Provides shell-based browser automation for coding agents without MCP. It supports browser sessions and persistent profiles. Playwright and its CLI are also open source (Apache-2.0). |
| **[Claude in Chrome + Claude Code](https://code.claude.com/docs/en/chrome)** | Integrates browser testing, form filling and debugging into Claude Code, including its VS Code extension, and shares browser login state. Its documented prerequisites include a direct Anthropic plan and sign-in. |

Choose Chrome Bridge if its command interface, visible action feedback and small dependency footprint suit your workflow. Agent independence is a difference from Anthropic's integration, not from Playwright. Logged-in browser access, accessibility snapshots, open source, CLI operation and human controls are not unique claims.

For repeatable regression tests in CI, consider [Playwright Test](https://playwright.dev/docs/intro). Chrome Bridge's interactive checks do not replace a test runner. Its setup still requires an extension, Node and a local server; some sites or commands require human intervention or a visible tab.

There is no published head-to-head benchmark establishing that Chrome Bridge is faster, safer, more reliable or more token-efficient than these alternatives. The demos show capabilities on specific pages, not superiority or universal website compatibility.

### Chrome 136 broke copying (or reusing) your Chrome profile

Since Chrome 136 (May 2025), Chrome ignores `--remote-debugging-port` on your default profile, and a copied profile loses its logins ("Failed to decrypt", "Chrome is already in use"). chrome-bridge runs inside the Chrome you already have open, so none of that applies: no debugging port, no profile copy, no relaunch.

## Security

You're giving an agent your logged-in browser, so the design assumes you want to watch it work.

- **Local only.** The server listens on `127.0.0.1` and rejects requests that come from web pages, so a site you visit can't drive it. **Any local process can**, though. Unload the extension at `chrome://extensions` when you're not using it.
- **Readable code.** The whole extension is one unminified file (`extension/background.js`) plus a manifest. The Web Store build is the same files.
- **Page content is untrusted.** Anything the bridge returns may contain prompt injection; the rules agents follow are in [AGENTS.md](AGENTS.md). Be careful with `upload`: it reads any local file the agent names into the page. Never let a page decide what gets attached.
- **Exported history leaves out secrets.** `history --batch` comments out typed and pasted text, dialog answers and upload paths.
- **Some commands attach Chrome's debugger.** `net`, `emulate`, `shot`, `upload` and `dialog` do. While they run, Chrome shows its "started debugging this browser" bar, which goes away when the command finishes. Pages can detect the debugger, and anti-bot systems may flag the session. `snap`, `click`, `fill`, `eval` and the other commands don't attach it.

## Commands

Commands that work on a tab take a `<match>`: part of the tab's URL or title, or an exact `id:<tabId>`. The full reference, with every flag and gotcha, is in [AGENTS.md](AGENTS.md#commands).

- **Read:** `snap` · `shot` · `measure` · `perf` · `console` · `net` · `fetch` · `eval` · `ask`
- **Act:** `click` · `fill` · `type` · `paste` · `press` · `hover` · `drag` · `scroll` · `upload` · `clear` · `dialog`
- **Tabs:** `tabs` · `open` · `nav` · `close` · `activate` · `wait` (`--human` hands a tab to you)
- **Device view:** `emulate` · `unemulate` · `resize` · `grid`
- **Housekeeping:** `mark` · `release` · `note` · `watch` · `history` · `doctor` · `batch`
- **Server:** `start` · `stop` · `health` · `profiles` · `extreload` · `swlogs`

## Local Diagnostic Logging

**Background first:** reads, synthetic actions, direct-input uploads, and CDP screenshots do not activate tabs. Trusted input and chooser upload require a suitable visible/focused page and refuse hidden targets rather than switching focus. `emulate focus` is an explicit background option for focus-gated scripts, not a guarantee of rendering in an occluded window. Screenshot fallback now requires an already-active target; only explicit `activate` changes tab/window focus. See [the focus matrix](AGENTS.md#minimize-focus-changes).

Safety checks cover bulk close and queued `--diff` actions: a human-reclaimed tab cannot be closed with `--all`, and queued actions refuse to start after release or their dispatch deadline. Actions already running can still finish. Application `EvalError`s are returned without replaying the payload. `fetch --csrf` requires the tab and request to share an HTTP(S) origin, binds execution to that document in the isolated world, and refuses redirects. Pill history resets on navigation and worker restart; the current document can still read its own pill. Binary fetch streams are bounded by decoded bytes.

`eval` syntax failures now include a local line/column hint when available, without echoing your code. Fix the JavaScript or shell quoting before retrying; pass complex snippets through stdin with `eval <match> -`. The check runs only after Chrome reports a syntax error, so newer browser syntax is not blocked by your Node version.

For a later review of failures, retry loops, and missing features, open the extension popup's **Settings** and enable **Diagnostic logging**. It is **off by default**, local only, and shared across connected profiles. Choose a rolling size limit (1-100 MiB, default 10 MiB); view usage or delete the logs in the same panel.

The JSONL files in `.diagnostics/` record correlated command outcomes, timings, error categories, and privacy-preserving fingerprints, not raw page content, input values, or eval code. The existing `watch`/`history` feed stays in memory; command activity is no longer written to `server.log`. See [collection, privacy, and week-later analysis](docs/diagnostics.md).

Popup controls work from Chrome 117. After an uncertain settings write, the popup refreshes status or shows an unknown state with Retry; it never presents the previous setting as confirmed. Releasing one tab keeps controls for the others. Logging repairs incomplete JSONL tails and reports boot-scoped recovery/loss counters through health; partial profile failures and actual single-profile dispatch versions are retained in diagnostics.

## Install detail

<details>
<summary>Upgrades, port, Windows, several Chrome profiles</summary>

**Upgrading.** After `git pull`, restart the server and reload the extension. The old server keeps running the old code, and `health` still passes, so nothing else reminds you:

```bash
node cli.mjs stop && node cli.mjs start
node cli.mjs extreload
```

`health` warns when the loaded extension is older than the repo.

**Server stopped.** If the server dies or the machine reboots, the agent's health check fails and the agent restarts it with `node cli.mjs start`.

**Port.** Everything uses `127.0.0.1:9333`. `BRIDGE_PORT` moves the server and CLI, but the extension always connects to 9333, so you'd have to edit `extension/background.js` too. If `server.log` shows `EADDRINUSE`, something else holds 9333: find it with `lsof -i :9333`. It's often an old server from another checkout; `node <that-repo>/cli.mjs stop` frees it.

**Windows.** `install.sh` needs bash (Git Bash works). The bridge itself is plain Node, so `node server.mjs` and every `cli.mjs` command work anywhere.

**Several Chrome profiles.** Load the extension in each one; agents can drive them in parallel. If a tab match exists in more than one profile, the command is refused until the agent names one with `--profile <name>` (`cli.mjs profiles` lists them). That way the agent never clicks in your personal browser when it meant the work one. Don't load the Web Store build and the unpacked folder in the same profile; the bridge refuses that too and tells you to remove one.

**AI features.** `ask`, `snap --find` and `console --ask` use Chrome's built-in Gemini Nano and need Chrome ≥ 138.

</details>

## Development

`node test/selftest.mjs` runs an end-to-end check against a fake extension (no Chrome needed). CI runs it on every push. How to land changes (version bumps, tags, style) is in the *Developing* section of [AGENTS.md](AGENTS.md).

The npm package is [`@siropkin/chrome-bridge`](https://www.npmjs.com/package/@siropkin/chrome-bridge): `npx @siropkin/chrome-bridge` clones this repo into `~/.chrome-bridge` and starts it. The unscoped `chrome-bridge` package on npm is an unrelated project. To pin a version, check out a tag (`git tag -l`).

## License

MIT
