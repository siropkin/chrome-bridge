#!/bin/bash
# chrome-bridge installer: checks Node, starts the server, prints the agent snippet.
# The only manual step is loading the extension (chrome://extensions requires a click).
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

command -v node >/dev/null || { echo "✗ Node.js >= 18 required: https://nodejs.org"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || { echo "✗ Node >= 18 required (you have $(node --version))"; exit 1; }
echo "✓ Node $(node --version)"

if curl -sf -m 2 localhost:9333/health >/dev/null 2>&1; then
  echo "✓ server already running (localhost:9333)"
else
  nohup node server.mjs > server.log 2>&1 &
  sleep 1
  curl -sf -m 2 localhost:9333/health >/dev/null
  echo "✓ server started (localhost:9333, log: $ROOT/server.log)"
fi

echo
echo "One manual step left — load the Chrome extension:"
echo "  1. open chrome://extensions"
echo "  2. enable Developer mode (top right)"
echo "  3. Load unpacked → $ROOT/extension/"
[ "$(uname)" = "Darwin" ] && open -a "Google Chrome" "chrome://extensions" || true

echo
echo "Then give your AI agent this one line (CLAUDE.md, .cursorrules, AGENTS.md, system prompt, …):"
echo
echo "  To drive my Chrome browser (real logged-in tabs), read $ROOT/AGENTS.md and run \`node $ROOT/cli.mjs <command>\`. If the health check fails, run \`node $ROOT/cli.mjs start\`; if the extension is disconnected, tell me to reload it."
echo
