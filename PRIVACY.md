# Chrome Bridge — Privacy Policy

chrome-bridge lets an AI agent or CLI on **your own machine** drive the Chrome browser you are already logged into. This policy describes what the extension does with your data.

## The short version

**Nothing leaves your machine.** The extension talks over a WebSocket to a server that binds to `127.0.0.1` on the same computer. There is no account, no sign-in, no analytics, no telemetry, no third-party service, and no data collected by the developer.

## What the extension does

- Connects to a local server (`127.0.0.1:9333`) that you or your AI agent started on your machine, and forwards automation commands to your own browser tabs.
- Reads the structure and content of the tabs you point it at (accessibility snapshots, screenshots, console and network capture) and hands it to the local server, which hands it to the CLI or AI agent you are running. This is the tool's entire function — your machine, your agent, your tabs.
- Marks the tabs it is driving with a small on-page pill indicator so you can always see what the agent is doing, and clears the marks when it is done.

## What is stored

Local browser storage only, on your machine:

- a randomly generated profile id (to tell your Chrome profiles apart in the CLI),
- per-tab "driven" markers for the current session.

No browsing history, credentials, or page content is persisted anywhere by the extension.

## What is transmitted

Page content from the tabs you drive goes to the local server and to the AI agent or script you connected to it — and nowhere else. It is not uploaded to any server controlled by the developer. If your agent itself sends that content elsewhere, that is between you and your agent.

## Contact

Questions: [GitHub issues](https://github.com/siropkin/chrome-bridge/issues).
