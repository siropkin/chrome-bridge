# @siropkin/chrome-bridge

Installer/launcher for [chrome-bridge](https://github.com/siropkin/chrome-bridge) — drive your real, logged-in Chrome from any AI agent (Claude Code, Cursor, Qwen, GLM, a script, a cron job) through a plain CLI: pages as token-cheap a11y trees, click/type/scroll with trusted CDP input when an app ignores synthetic events, multi-profile routing, per-tab 🟣 markers so you always see what the agent touches.

```bash
npx @siropkin/chrome-bridge          # install + start, print next steps
npx @siropkin/chrome-bridge health   # then it IS the CLI — args forward to it
```

What it does: clones the repo into `~/.chrome-bridge` (override with `CHROME_BRIDGE_HOME`), freshens it with a best-effort `git pull`, starts the local server (127.0.0.1:9333), then forwards your args to the real CLI. The Chrome half is the [Chrome Web Store extension](https://chromewebstore.google.com/detail/chrome-bridge/kmhjlnokjigmnimgjjmiahlinjbcebkg) (or load `~/.chrome-bridge/extension` unpacked).

This package is intentionally thin — the npm version can lag the repo harmlessly since the CLI refreshes itself from git. The canonical source, docs, and issue tracker are the GitHub repo.

**Not to be confused with** the bare [`chrome-bridge`](https://www.npmjs.com/package/chrome-bridge) package — an unrelated 2017 project (chrome-pagevars) that happens to hold the name. Also unrelated: `chrome-bridge-mcp`, `chrome-bridge-sdk`, `codex-chrome-bridge`.
