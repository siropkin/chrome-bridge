# Chrome Bridge — Privacy Policy

chrome-bridge lets an AI agent or CLI on **your own machine** drive the Chrome browser you are already logged into. This policy describes what the extension does with your data.

## The short version

**Nothing leaves your machine.** The extension talks over a WebSocket to a server that binds to `127.0.0.1` on the same computer. There is no account, no sign-in, no analytics, no telemetry, no third-party service, and no data collected by the developer.

## What the extension does

- Connects to a local server (`127.0.0.1:9333`) that you or your AI agent started on your machine, and forwards automation commands to your own browser tabs.
- Reads the structure and content of the tabs you point it at (accessibility snapshots, screenshots, console and network capture) and hands it to the local server, which hands it to the CLI or AI agent you are running. This is the tool's entire function — your machine, your agent, your tabs.
- Can also list all open tabs (titles and URLs) in every connected Chrome profile so the agent can pick one — this listing marks no tab and shows no pill, but it is recorded in the local activity feed (`cli watch` / `server.log`).
- Marks the tabs it is driving with a small on-page pill indicator so you can always see what the agent is doing, and clears the marks when it is done.
- The optional `ask`, `snap --find`, and `console --ask` commands process page text with Chrome's built-in on-device Gemini Nano (Prompt API) — the text stays on your machine; the first use downloads the model (~2GB) from Google.

## Permissions, and why

- `tabs`, `tabGroups` — find the tabs the agent is asked to drive, and group them visually so you can see what's automated.
- `scripting` — inject the accessibility snapshotter and the purple pill into the pages you point it at.
- `debugger` — attached only while a CDP command runs (`net`, `shot`, `emulate`, `upload`, `dialog`); Chrome shows its own "debugging this browser" infobar while attached.
- `alarms`, `storage` — keep the service worker alive and hold the local profile id and per-tab driven markers (session-scoped).
- `<all_urls>` — the agent must be able to act on any page you point it at; nothing is read or touched until a command names the tab.

All of it stays on `127.0.0.1` — no permission is used to talk to anything off your machine.

## What is stored

Local browser storage only, on your machine:

- a randomly generated profile id (to tell your Chrome profiles apart in the CLI),
- per-tab session state: driven markers, emulation and status flags, and the pill's recent-activity narration (short labels describing recent actions, which can include element text or search terms from the page).

All of it lives in session storage and is cleared when the browser closes. No browsing history, credentials, or page content is persisted beyond the browser session.

The local server also keeps a `server.log` at the repo root: one line per command (timestamp, command, URL fragment, selector) — typed `fill`/`type`/`paste` values are excluded by design, though page text can appear inside error lines. It is truncated to 5MB on server start, readable only by your user account, and deletable anytime.

## What is transmitted

Page content from the tabs you drive goes to the local server and to the AI agent or script you connected to it — and nowhere else. It is not uploaded to any server controlled by the developer. If your agent itself sends that content elsewhere, that is between you and your agent.

## Contact

Questions: [GitHub issues](https://github.com/siropkin/chrome-bridge/issues).

Last updated: 2026-09-09.
