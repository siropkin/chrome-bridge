# Chrome Web Store listing — canonical copy

Paste-ready text for the Chrome Web Store console (no API for these fields — copy by hand).
Keep in sync with README.md's pitch sections. Last synced: 2026-09-12 (control-story pass: search head terms in the short description, the a11y-tree/token-efficiency and human-control stories in the body).

## Short description (max 132 chars)

AI browser automation via a local server: your agent drives your real logged-in Chrome — you watch and can veto any tab.

## Detailed description

chrome-bridge is browser automation for AI agents: ANY agent can drive the Chrome you're already using — your open tabs, your logged-in sessions, your SSO. Playwright-style tools drive a browser they launched with a fresh profile; chrome-bridge drives your real browser. That's the only mode.

GETTING STARTED — 3 steps, under a minute:

1. Install this extension.
2. Click its toolbar button and press "Copy setup prompt for your AI agent".
3. Paste that text to your agent (Claude Code, Cursor, or any agent that can run shell commands).

The agent does the rest itself: downloads the tiny zero-dependency bridge, starts it, verifies the connection, and runs a no-trace dry run before reporting back. The popup's dot shows when the bridge is ready.

WHAT YOU GET

• Your agent can read pages, click, fill forms, navigate, screenshot, capture network traffic — in YOUR logged-in browser.
• AI-first under the hood: the agent reads pages as an accessibility tree instead of screenshots — an order of magnitude fewer tokens per look — and every command is a one-line shell call any agent can run.
• Full local control: everything runs on 127.0.0.1, nothing leaves your machine. No cloud relay, no account, no telemetry.
• Built for the human watching: every tab the agent touches wears a 🟣 pill narrating each action in real time, joins a 🟣 tab group, and shows status in the favicon; every action lands in a history you can review; one trusted click on ⏏ rejects the agent from that tab.
• Point the agent at an exact tab: the toolbar popup copies a tab reference (id:…) that pins every command to that tab.
• Honest actions: if the page re-sorts under a saved element reference, the action fails loudly instead of clicking the wrong element; a click the app ignored says so instead of faking success; trusted input refuses to fake-fire on a hidden tab; a fill an editor's autosave can't see carries a warning; typing into heavy editors (docs, block editors) is paced and verified.
• Rich editor savvy: the agent can drop whole structured documents (headings, lists, links) into block editors in one shot — and clear them again, even when the editor owns its content model.
• No residue: a `doctor` command finds and cleans any leftover markers, and dead-session markers are reaped automatically on browser restart.
• Multiple Chrome profiles supported — the agent never silently acts in your personal browser when you meant the work one.

Advanced users can also run it from source (git clone) — see the GitHub repo.

PRIVACY

The extension talks only to a local server on 127.0.0.1 that you (or your agent) start. No data leaves your machine. Full policy: https://github.com/siropkin/chrome-bridge/blob/master/PRIVACY.md

## Category

Developer Tools (or Productivity — Developer Tools is the honest fit)

## Notes for the console

- Screenshots: regenerate from docs/store/*.html when the popup/pill UI changes (screenshot-1-pill.png, screenshot-2-history.png; add a popup screenshot once v1.21.0+ is live).
- The single-purpose statement and permission justifications already filed cover the existing permission set; clipboardWrite (since v1.19.0) is for the popup's user-clicked Copy button — nothing is read.
