# Chrome Web Store listing — canonical copy

Paste-ready text for the Chrome Web Store console (no API for these fields — copy by hand).
Keep in sync with README.md's pitch sections. Last synced: 2026-11-05 (accurate workflow positioning, setup requirements, and agent/website data boundaries; no unsupported competitor or benchmark claims).

## Title (= manifest `name`, ships with the extension — not a console field)

Chrome Bridge - AI Agent Browser Automation

## Short description (max 132 chars)

Open-source browser automation for shell-capable AI agents. Uses existing Chrome tabs and a local Node.js server.

## Detailed description

Chrome Bridge is a small, open-source CLI bridge for shell-capable AI agents to work in the Chrome you're already using: existing tabs, logged-in sessions and SSO.

One Chrome extension connects to a local Node.js server and command-line interface with no third-party runtime dependencies. No separate browser or MCP server is required. The extension alone is not the full setup, and your chosen AI service may have its own costs.

WHAT YOU CAN DO

• Inspect a page using accessibility snapshots, scoped to one region or compared with the previous snapshot.
• Check a user flow, fill a form, and verify the resulting page or server response.
• Inspect network requests, console output, layout measurements and page-performance signals.
• Use screenshots, mobile emulation and trusted input when a task needs them.
• Work with a specific existing tab by copying its id:… reference from the extension popup.

VISIBLE BROWSER FEEDBACK

Driven tabs show a purple activity pill, action history and tab group. The pill's release control refuses subsequent commands until an explicit reclaim. An action already running may still finish; this is not an undo button or a security boundary against a malicious local agent.

Multiple Chrome profiles are supported. Ambiguous matches require explicit profile selection. Some sites and commands require a visible tab, human authentication or other intervention. The bridge does not bypass login challenges or guarantee website compatibility.

GETTING STARTED

Requires Chrome 117 or newer, Node.js 18 or newer, and an AI agent that can run local shell commands. Documented setup supports macOS and Linux; Windows setup uses Git Bash.

1. Install this extension.
2. Click its toolbar button and press "Copy setup prompt for your AI agent".
3. Paste that text to your agent (Claude Code, Cursor, or any agent that can run shell commands).

The agent downloads the bridge, starts the local server and checks the connection. Follow any permission or login prompts yourself. Setup time depends on your environment; the popup indicates when the bridge is connected.

Chrome Bridge is free and MIT-licensed. Its focus is an inspectable, command-line workflow with visible browser feedback, not a claim to be faster, safer or more reliable than other automation tools. Interactive checks are not a replacement for a repeatable CI test suite.

Source, setup and operating manual: https://github.com/siropkin/chrome-bridge

PRIVACY

The extension-to-CLI connection is local, through 127.0.0.1. Chrome Bridge does not use a developer-operated cloud relay or collect your browsing data. Your connected AI agent receives page content and may send it to its model provider or other services. Requested browser actions, including form submissions and uploads, can send data to websites.

Use only information and accounts you are authorized to expose to your chosen agent. Full policy: https://raw.githubusercontent.com/siropkin/chrome-bridge/master/PRIVACY.md

(The console's privacy-link checker rejected the github.com/blob/… URL as "not reachable" at v1.26.0 submission — the raw.githubusercontent.com URL passes. Paste the raw one into the console field, exactly, no trailing period.)

## Category

Developer Tools (or Productivity — Developer Tools is the honest fit)

## Notes for the console

- Screenshots: regenerate from docs/store/*.html when the popup/pill UI changes (screenshot-1-pill.png, screenshot-2-history.png; add a popup screenshot once v1.21.0+ is live). The mocks are pinned to their exact target canvas (body is NxM px, content top-left-anchored), so any viewport works: serve the repo root, `emulate <match> <w> <h> dsf=2`, `shot <match> <out> --max <w>` — the dsf=2 raster downsamples to exact px; a plain 1x capture (a small window, a 1x external display) reads soft. Crop paths don't compose with emulation — emulate the exact size, don't crop.
- The single-purpose statement and permission justifications already filed cover the existing permission set; clipboardWrite (since v1.19.0) is for the popup's user-clicked Copy button — nothing is read.
