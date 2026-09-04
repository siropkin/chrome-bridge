# chrome-bridge

**English** | [中文](README.zh-CN.md)

[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A5%2018-339933)](https://nodejs.org) [![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)

Let **any AI agent** drive your **real** Chrome — the tabs you already have open, with your logged-in sessions, SSO, and cookies. No fresh browser profile, no `--remote-debugging-port` restart, no MCP server, zero npm dependencies.

![chrome-bridge driving a tab — 🟣 corner tag marks it](docs/banner.png)

## Quick start

```bash
git clone https://github.com/siropkin/chrome-bridge && cd chrome-bridge && ./install.sh
```

Then load the extension: `chrome://extensions` → Developer mode → **Load unpacked** → select the `extension/` folder (Chrome requires that click — scripts can't).

Verify it's up: `node cli.mjs health` → `{"ok":true,"extension":true}`

Done. Tell your agent about it:

- **Claude Code** — copy `.claude/skills/chrome-bridge/` into your project's `.claude/skills/` (or your `~/.claude/skills/`). It auto-loads on browser tasks and points at `AGENTS.md` for the full manual.
- **Any other agent** (Cursor, Qwen, GLM, Baseten, raw curl) — paste this one line into your agent's instructions (`CLAUDE.md`, `.cursorrules`, `AGENTS.md`, system prompt, …):

  > To drive my Chrome browser (real logged-in tabs), read `<path>/chrome-bridge/AGENTS.md` and run `node <path>/chrome-bridge/cli.mjs <command>`. If the health check fails, run `node <path>/chrome-bridge/cli.mjs start`; if the extension is disconnected, tell me to reload it.

That's the whole integration. `AGENTS.md` is a self-contained operating manual — commands, recipes, gotchas — that any agent with file or web access can read. Agents with web access can read it straight from GitHub: `https://raw.githubusercontent.com/siropkin/chrome-bridge/master/AGENTS.md`.

---

A tiny unpacked Chrome extension connects over WebSocket to a local Node server; anything that can run a shell command can drive the browser:

```bash
node server.mjs &                        # start the bridge (Node ≥ 18, no deps)
node cli.mjs snap localhost:8082         # compact a11y snapshot with element refs
node cli.mjs click localhost:8082 @e4    # click by ref
node cli.mjs fill localhost:8082 @e2 "hello@example.com"
node cli.mjs shot localhost:8082 out.png --max 800 --format jpeg
```

A `snap` looks like this — the whole page as a compact text tree with refs you act on:

```
table "Hacker News new | past | comments | ask | show | jobs | submit" @e1
  link "Hacker News" @e5
  link "new" @e6
  link "submit" @e12
  link "login" @e13
table "1. Playa Phone (playaphone.com) 122 points by cutoff 1 hour…" @e14
  link "Playa Phone" @e16
  link "41 comments" @e21
```

Link URLs are omitted by default (they were ~60% of snapshot tokens — the `@eN` ref is what you click); nameless links keep theirs, and `snap --href` brings them all back.

## Why not Playwright (or playwright-mcp)?

Playwright drives a browser it launched — or one restarted with a debug port — so you lose your live, authenticated session. chrome-bridge drives the Chrome you're already looking at. It borrows Playwright's two best ideas (accessibility-tree snapshots with element refs, ref-based actions) and skips the 40 MB dependency and the fresh profile.

## Why not an MCP browser bridge?

MCP bridges (mcp-chrome, BrowserMCP, playwriter) also drive your real browser — but they need an MCP-capable client and a configured, long-running MCP server. (playwright-mcp, above, is an MCP bridge too — it just also loses your live session.) chrome-bridge is a plain CLI and one HTTP endpoint (`POST /cmd`): any agent that can run a shell command can use it — nothing for the agent to install or configure — and the same commands work from a script, a cron job, or your own terminal.

## Install detail

`install.sh` checks Node ≥ 18, starts the server in the background (logs to `server.log`), opens `chrome://extensions`, waits for the extension to connect (up to ~90s), and prints the agent one-liner with your real path filled in. If the server dies or the machine reboots, the agent's health check fails and it can restart it itself with `node cli.mjs start` (`node cli.mjs stop` shuts it down).

Tabs the bridge drives get a 🟣 pill in the bottom-right corner (click it to hide until the next navigation) and join a 🟣 tab group so you always know what's being automated. The pill narrates what the agent is doing right now (`🟣 taking screenshot…`, `🟣 reading page…`, `🟣 AI idle` when nothing's running) and its tooltip lists the last few actions; while a command runs, a purple viewport frame lights up, the tab's favicon shows ⏳ (✅ when it lands), and clicks/hovers flash a purple pointer where the agent acts. `release` (or `close`) gives them back.

## Works with any AI agent — not just Claude

The bridge is a plain local CLI + HTTP endpoint, so it's harness-agnostic by design:

| Agent / harness | Where the one-liner goes |
|---|---|
| Claude Code | `CLAUDE.md` |
| Kimi CLI (Moonshot) | `AGENTS.md` or system prompt |
| Qwen Code (Alibaba) | `AGENTS.md` |
| GLM / DeepSeek / other coding agents | `AGENTS.md` or system prompt |
| Cursor | `.cursor/rules` |
| Your own agent loop | call `cli.mjs`, or skip it and POST JSON straight to `http://127.0.0.1:9333/cmd` |

The HTTP API is one endpoint: `POST /cmd` with `{"type": "snap", "urlMatch": "…"}` — any language, any framework, any model.

## Commands

| Command | What it does |
|---|---|
| `tabs` | List tabs (id, url, title, driven flag) |
| `open <url>` · `nav <match> <url> [--diff]` · `close <match>` | Tab lifecycle — `open`/`nav` wait for the page to load (8s cap) |
| `snap <match> [css] [--diff] [--href]` | Accessibility-tree snapshot with `@eN` refs — **cheap; use it before screenshots**. Scope to a subtree, diff against the last snap, or include all link URLs with `--href`. Lines prefixed `*` are elements new since the previous snap |
| `click <match> <@ref\|css> [--diff]` | Click (scrolls into view, full pointer/mouse event sequence, overlay-coverage check) |
| `fill <match> <@ref\|css> <value> [--diff]` | Set input value — React-safe (native setter + input/change events) |
| `type <match> <@ref\|css> <text> [--diff]` · `press <match> <key> [@ref] [--diff]` · `hover <match> <@ref\|css> [--diff]` | Per-char typing (autocomplete UIs), key presses, hover |
| `scroll <match> <up\|down\|top\|bottom\|@ref\|css> [--diff]` | Scroll — finds the real scroller on app-shell pages (Linear, Gmail) that scroll an inner panel, not the window |
| `upload <match> <@ref\|css> <file...> [--diff]` | Set a file input's files via CDP — works on hidden inputs; target the input or an element wrapping it |
| `ask <match> <question>` | *(experimental)* Local Gemini Nano answers from page text — no cloud tokens, pre-filter quality |
| `wait <match> [css\|--text t] [--timeout ms]` | Wait for element or visible text — MutationObserver-driven, resolves as soon as the page changes |
| `eval <match> <js\|-> [--world main|isolated]` | Run JS in the page; `-` reads from stdin |
| `shot <match> <out> [--max px] [--scale N] [--format jpeg] [--quality N] [--crop x,y,w,h] [--full]` | Screenshot via CDP. Long edge capped at `--max` px (default 1280, `0` = native res) — models downscale big images on read anyway, so native res buys file size, not detail. `--full` = whole page height |
| `net <match> [--dur ms] [--filter s]` | Capture network traffic via CDP — one compact line per request |
| `measure <match> <css>` | Bounding rect + computed styles as JSON — layout truth without pixels |
| `console <match> [--clear] [--ask [q]]` | Page console + uncaught errors (hook installs on first call); `--ask` triages the log with local Gemini Nano — only the verdict costs cloud tokens |
| `grid <match>` | Toggle an 8px alignment grid overlay |
| `emulate <match> <w> <h> [mobile]` · `unemulate <match>` | Switch between desktop and mobile device views — CDP emulation, no window resize |
| `resize <match> <w> <h>` | Resize the window |
| `batch` | Run commands from stdin, one per line — one process for a whole sequence; stops on the first error |
| `mark <match>` · `release <match>` | Add/remove the driven-tab corner tag + 🟣 tab group |
| `swlogs` | Service-worker console tail (errors/warnings) |
| `start` · `stop` | Server lifecycle — `start` spawns it detached if down (agents can self-heal a dead server) |

`<match>` is a substring of the tab URL; the most recently active matching tab wins. Refs survive re-`snap`s (an element keeps its `@eN` while its role+name are unchanged) and expire on navigation — re-`snap` after `nav`.

## Desktop & mobile device emulation

Switch any tab between desktop and mobile device views without resizing your window — same mechanism as the DevTools device toolbar (CDP metrics + touch + mobile UA):

```bash
node cli.mjs emulate news.ycombinator.com 390 844 mobile   # iPhone-sized view, touch + mobile UA
node cli.mjs emulate news.ycombinator.com 1440 900         # desktop-sized view
node cli.mjs unemulate news.ycombinator.com                # back to normal
```

![mobile emulation of a driven tab](docs/mobile.png)

## Token-efficient agent workflow

1. **`snap` first** — a text tree costs ~10× fewer tokens than a screenshot and usually answers the question.
2. Keep it small: `snap <match> "dialog"` scopes to a subtree; after an action, `snap --diff` returns only what changed (refs stay stable across snaps).
3. **Act + observe in one call**: `click <match> @e4 --diff` runs the click, settles (waits for the DOM to go quiet, 3s cap), and returns the snap-diff in the same result — no separate `wait` and `snap` round trips.
4. `shot` only when pixels matter, and then cheap: `--max 800 --format jpeg`, or `--crop` to the component.
5. For layout questions ("is this centered?") trust `measure` numbers, not eyeballs.
6. Batch independent steps — `printf 'click m @e4\nfill m @e2 "hi"\n' \| node cli.mjs batch` — one process and one shell call for the whole sequence.

## Design reviews

[design-eye.md](design-eye.md) — a procedure for comparing an implementation against a Figma/mockup without missing alignment and containment details. Includes the 8px alignment grid overlay:

![8px alignment grid overlay](docs/grid.png)

## Development

`node test/selftest.mjs` — end-to-end check with a fake extension (no Chrome needed).

## Security

The server binds `127.0.0.1` only and rejects browser-origin requests, so a web page you visit can't drive the bridge — but **any local process still can**. Load the extension while you're testing; unload it at `chrome://extensions` when you're done.

## License

MIT
