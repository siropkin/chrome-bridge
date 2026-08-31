# chrome-bridge

Let an AI agent drive your **real** Chrome — the tabs you already have open, with your logged-in sessions, SSO, and cookies. No fresh browser profile, no `--remote-debugging-port` restart, no MCP server, zero npm dependencies.

A tiny unpacked Chrome extension connects over WebSocket to a local Node server; anything that can run a shell command can drive the browser:

```bash
node server.mjs &                        # start the bridge (Node ≥ 18, no deps)
node cli.mjs snap localhost:8082         # compact a11y snapshot with element refs
node cli.mjs click localhost:8082 @e4    # click by ref
node cli.mjs fill localhost:8082 @e2 "hello@example.com"
node cli.mjs shot localhost:8082 out.png --scale 0.5 --format jpeg
```

## Why not Playwright (or playwright-mcp)?

Playwright drives a browser it launched — or one restarted with a debug port — so you lose your live, authenticated session. chrome-bridge drives the Chrome you're already looking at. It borrows Playwright's two best ideas (accessibility-tree snapshots with element refs, ref-based actions) and skips the 40 MB dependency and the fresh profile.

## Install

1. `git clone https://github.com/siropkin/chrome-bridge && cd chrome-bridge`
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `extension/` folder
3. `node server.mjs` — leave it running (`nohup node server.mjs > server.log 2>&1 &` to background it)

Verify: `node cli.mjs health` → `{"ok":true,"extension":true}`

## Use from an AI agent

Point the agent at [AGENTS.md](AGENTS.md) — a self-contained operating manual (commands, recipes, gotchas). One line in your `CLAUDE.md` / `.cursorrules` / agent instructions:

> To drive my Chrome browser, read `<path>/chrome-bridge/AGENTS.md` and run `node <path>/chrome-bridge/cli.mjs …`.

## Commands

| Command | What it does |
|---|---|
| `tabs` | List tabs (id, url, title, driven flag) |
| `open <url>` · `nav <match> <url>` · `close <match>` | Tab lifecycle |
| `snap <match>` | Accessibility-tree snapshot with `@eN` refs — **cheap; use it before screenshots** |
| `click <match> <@ref\|css>` | Click (scrolls into view, full pointer/mouse event sequence) |
| `fill <match> <@ref\|css> <value>` | Set input value — React-safe (native setter + input/change events) |
| `wait <match> [css\|--text t] [--timeout ms]` | Wait for element or visible text |
| `eval <match> <js\|-> [--world main]` | Run JS in the page; `-` reads from stdin |
| `shot <match> <out> [--scale N] [--format jpeg] [--quality N] [--crop x,y,w,h]` | Screenshot via CDP |
| `measure <match> <css>` | Bounding rect + computed styles as JSON — layout truth without pixels |
| `console <match> [--clear]` | Page console + uncaught errors (hook installs on first call) |
| `grid <match>` | Toggle an 8px alignment grid overlay |
| `emulate <match> <w> <h> [mobile]` · `unemulate <match>` | CDP device emulation without window resize |
| `resize <match> <w> <h>` | Resize the window |
| `mark <match>` · `release <match>` | Add/remove the purple driven-tab banner + tab group |

`<match>` is a substring of the tab URL; the most recently active matching tab wins. Refs expire on navigation — re-`snap`.

## Token-efficient agent workflow

1. **`snap` first** — a text tree costs ~10× fewer tokens than a screenshot and usually answers the question.
2. Act by ref: `click @e4`, `fill @e2 "…"`.
3. `shot` only when pixels matter, and then cheap: `--scale 0.5 --format jpeg`, or `--crop` to the component.
4. For layout questions ("is this centered?") trust `measure` numbers, not eyeballs.

## Design reviews

[design-eye.md](design-eye.md) — a procedure for comparing an implementation against a Figma/mockup without missing alignment and containment details.

## Development

`node test/selftest.mjs` — end-to-end check with a fake extension (no Chrome needed).

## Security

The server binds `127.0.0.1` only, but **any local process can then drive your authenticated browser**. Load the extension while you're testing; unload it at `chrome://extensions` when you're done.

## License

MIT
