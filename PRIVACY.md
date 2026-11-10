# Chrome Bridge — Privacy Policy

chrome-bridge lets an AI agent or CLI on **your own machine** drive the Chrome browser you are already logged into. This policy describes what the extension does with your data.

## The short version

**The bridge connection is local unless you opt in to Cloud Bridge, and local is not necessarily the entire workflow.** The extension talks over a WebSocket to a server that binds to `127.0.0.1` on the same computer. The local link needs no account and sends no browsing data or telemetry to the developer. The optional Cloud Bridge link (off until you connect it, see below) sends commands and their results through a hub you sign in to: by default the public hub the developer runs, which passes them through without storing them (except a file a command saves, kept for an hour, below), or a hub you run yourself.

The connected AI agent receives page content and may send it to its model provider or other services according to its configuration and policies. Browser actions such as form submissions, uploads and page requests can send data to the websites involved. Use only data and accounts you are authorized to expose to your chosen agent and those destinations.

## What the extension does

- Connects to a local server (`127.0.0.1:9333`) that you or your AI agent started on your machine, and forwards automation commands to your own browser tabs.
- Reads the structure and content of the tabs you point it at (accessibility snapshots, screenshots, console and network capture) and hands it to the local server, which hands it to the CLI or AI agent you are running. This is the tool's entire function — your machine, your agent, your tabs.
- Can also list all open tabs (titles and URLs) in every connected Chrome profile so the agent can pick one — this listing marks no tab and shows no pill, but the command appears in the in-memory activity feed (`cli watch`).
- Marks the tabs it is driving with a small on-page pill indicator so you can always see what the agent is doing, and clears the marks when it is done.
- The optional `ask`, `snap --find`, and `console --ask` commands process page text with Chrome's built-in on-device Gemini Nano (Prompt API) — the text stays on your machine; the first use downloads the model (~2GB) from Google.

## Cloud Bridge (optional, off by default)

Turning on **Cloud AI apps** in the popup's ⚙ Settings and connecting a profile opens a second WebSocket, from your browser to a Cloud Bridge hub, so cloud AI apps you authorize at that hub (Claude.ai, ChatGPT…) can drive this profile. By default that is the public hub at `https://cloud-bridge.ivan-seredkin.workers.dev`, run by the chrome-bridge developer on Cloudflare Workers; **Use another Cloud Bridge address** connects to a hub you run yourself instead. While it is paired and switched on:

- Commands arrive from the hub, and their results go back to it: page structure and text, screenshots, console and network lines, fetched bodies — whatever the command returns. The hub passes them to the AI app that called, which may send them to its model provider.
- There is no end-to-end encryption: MCP ends at the hub, so the hub's operator can technically read what passes through it. The connection is TLS on a hosted hub. The reference hub ([siropkin/cloud-bridge](https://github.com/siropkin/cloud-bridge)) stores call metadata only for 30 days: time, AI app, profile, tool name (`chrome`, `chrome_batch`), success, duration, and the hub's own error message (an error the extension returns is stored as a fixed marker, since its text can echo the command). Not arguments, not results (except a file a command saves, below).
- Commands that would read your disk or clipboard, or manage the local install, are refused over this link. To upload a file over it, the AI app gives a public web link or sends the file's bytes itself, up to 10 MB. A link is downloaded by the hub, not by your browser, so it can't reach your home or office network (the hub only fetches public addresses); the hub passes the file through without keeping it, and it goes only into the page's file field. `fetch --out` and `net --har` save their file at the hub instead of your disk: the hub keeps it for one hour, then deletes it, and its download link opens only for the Cloud Bridge account that made it (after signing in); the AI app that ran the command can read it through its connection. A HAR from a signed-in tab contains that site's cookies and tokens. Turning the Cloud AI apps switch off (or removing the extension from its popup) cuts the link immediately, deletes the token from the browser and tells the hub to delete this profile's record. If the hub can't be reached then, the popup says so, and the browser keeps that one token only to retry the sign-out there (every 30 seconds while Chrome runs, and on the next Connect) until the hub answers; at most the last 5 such tokens are kept. Removing the extension asks the hub to sign out too, but can't retry afterwards.
- Over this link, opening or fetching an address on your computer or local network (`localhost`, private and link-local addresses, `*.local` names) or a `file:` page is refused before it runs, so a cloud AI app can't read your router, other devices or this bridge's own helper. A public web name that points into your network isn't caught.
- What the public hub keeps besides that call metadata: files commands saved (for an hour, above), your GitHub account id and username (sign-in; the GitHub token is used once and not kept), the profiles you paired (name, extension version, last seen, the tool list, and the profile's token as a hash once pairing completes — while you confirm a pairing the hub holds the token for at most 10 minutes, until your browser collects it), and the AI apps you allowed. Cloudflare keeps the hub's error logs (time, method, path, error message) for 3 days; per-request logs are off. Your browser keeps a 7-day sign-in cookie for the hub. Switching Cloud AI apps off deletes that profile's record (above). Deleting the rest yourself isn't built yet: to delete your data from the public hub, open an issue at [siropkin/cloud-bridge](https://github.com/siropkin/cloud-bridge/issues).

## Permissions, and why

- `tabs`, `tabGroups` — find the tabs the agent is asked to drive, and group them visually so you can see what's automated.
- `scripting` — inject the accessibility snapshotter and the purple pill into the pages you point it at.
- `debugger` — attached only while a CDP command runs (`net`, `shot`, `emulate`, `upload`, `dialog`, `--trusted` clicks/keys, `wait --pixel-change`, and the `fetch --csrf` cookie read); Chrome shows its own "debugging this browser" infobar while attached.
- `alarms`, `storage` — keep the service worker alive and hold the local profile id and per-tab driven markers (session-scoped).
- `clipboardWrite` — the toolbar popup's copy buttons (copy a tab's ID for your agent, the setup and update prompts, the Cloud Bridge link). The extension never reads your clipboard.
- `<all_urls>` — the agent must be able to act on any page you point it at; nothing is read or touched until a command names the tab.

The automation command channel stays on `127.0.0.1`. That does not keep the websites you visit, actions you request, or the connected agent's model calls offline.

## What is stored

Local browser storage only, on your machine:

- a randomly generated profile id (to tell your Chrome profiles apart in the CLI),
- the Local AI agents on/off switch, once you've changed it,
- if you paired Cloud Bridge: the hub URL, the hub's access token for this profile, the on/off switch and a pending pairing code. Turning Cloud AI apps off deletes the token, the switch and the pending code (a token whose hub couldn't be told is kept until the hub confirms the sign-out, above); the hub URL stays so pairing again is one click,
- per-tab session state: driven markers, emulation and status flags, and the pill's recent-activity narration (short labels describing recent actions, which can include element text or search terms from the page).

All of it lives in session storage and is cleared when the browser closes — except these, in local storage, which survive restarts: the profile id (it names your profile in the CLI; it is random, not derived from any account), the Local AI agents switch and, once you pair, the Cloud Bridge settings above, including the hub's access token. No browsing history, website credentials, or page content is persisted beyond the browser session. Removing the extension deletes all of it.

The server keeps a short in-memory command history. `server.log` contains operational startup/connection notices, not new command or tab activity. Old pre-upgrade logs may still contain URL fragments, selectors, or error text; they are not automatically deleted. `history --batch` comments out pasted/typed text, dialog answers, clipboard pastes, and upload paths rather than retaining them for replay (single-line `eval` code is kept verbatim — don't embed secrets in it).

**Optional local diagnostic logging is off by default.** Turn it on in the popup's ⚙ Settings → Diagnostic logs. It applies to all connected profiles and persists as owner-only files in `.diagnostics/` on the server machine. Records contain timestamps, build versions, timings, command names, selected options, result sizes, error categories, and keyed fingerprints of inputs and identities. No raw input text, URLs, selectors, eval code, upload paths, headers, cookies, screenshots, or response bodies are stored. Unknown command names are fingerprinted. The default rolling limit is 10 MiB (configurable from 1 to 100); old event files are replaced at the limit. Turning it off stops collection but preserves files; Delete diagnostic logs removes the records without changing settings. The settings file contains a local fingerprint key and must not be shared. Metadata can still be sensitive. Nothing is uploaded automatically. See [diagnostic logging](docs/diagnostics.md) for coverage and analysis guidance.

Files you explicitly ask for land where you point them: screenshots (`shot`), page bodies (`fetch --out`), and HAR captures (`net --har`). A HAR from a logged-in tab contains full request/response headers — including cookies and tokens — plus bodies: the CLI writes it readable only by your user account (0600) and warns on every save. Treat such files as secrets.

## What is transmitted

The bridge passes page content from the tabs you drive to the local server and the AI agent or script you connected to it. It does not upload that content to a server controlled by the developer; with Cloud Bridge paired, it goes through the hub you chose (above). The connected agent may transmit received content to its model provider or other services; review that agent's configuration and privacy policy. Requested browser actions can also transmit information to websites, including the contents of submitted forms or uploaded files.

## Contact

Questions: [GitHub issues](https://github.com/siropkin/chrome-bridge/issues).

Last updated: 2026-11-08.
