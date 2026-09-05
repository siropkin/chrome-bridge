#!/bin/bash
# chrome-bridge installer: checks Node, starts the server, prints the agent snippet.
# The only manual step is loading the extension (chrome://extensions requires a click).
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
PORT=${BRIDGE_PORT:-9333}
HEALTH="127.0.0.1:$PORT/health"
OK='"ok":[[:space:]]*true'
EXT='"extension":[[:space:]]*true'

command -v node >/dev/null || { echo "✗ Node.js >= 18 required: https://nodejs.org"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || { echo "✗ Node >= 18 required (you have $(node --version))"; exit 1; }
echo "✓ Node $(node --version)"

# The extension hardcodes port 9333 (extension/background.js WS_URL) — a custom
# BRIDGE_PORT would split the stack and leave the extension dialing nothing.
if [[ -n ${BRIDGE_PORT+x} && $PORT != 9333 ]]; then
  echo "✗ BRIDGE_PORT=$PORT: the extension connects to 9333 only — unset BRIDGE_PORT or edit extension/background.js WS_URL to match"
  exit 1
fi

if body=$(curl -sf -m 2 "$HEALTH") && [[ $body =~ $OK ]]; then
  echo "✓ server already running (localhost:$PORT)"
  # The running server is the one from when it was started — if the repo was
  # upgraded since, it's old code with a passing health check. Say so.
  echo "  just upgraded? restart it:  node cli.mjs stop && node cli.mjs start"
else
  nohup node server.mjs >> server.log 2>&1 &
  for ((i=0;i<20;i++)); do
    body=$(curl -sf -m 2 "$HEALTH") && [[ $body =~ $OK ]] && break
    sleep 0.25
  done
  [[ $body =~ $OK ]] || { echo "✗ server did not start — see $ROOT/server.log"; exit 1; }
  echo "✓ server started (localhost:$PORT, log: $ROOT/server.log)"
fi

echo
echo "One manual step left — load the Chrome extension:"
echo "  1. open chrome://extensions"
echo "  2. enable Developer mode (top right)"
echo "  3. Load unpacked → $ROOT/extension/"
[ "$(uname)" = "Darwin" ] && open -a "Google Chrome" "chrome://extensions" || true

echo
echo "Want the agent to install its own integration too (the Claude Code skill, or the one-liner below)?"
echo "Paste docs/agent-setup.md into it — raw: https://raw.githubusercontent.com/siropkin/chrome-bridge/master/docs/agent-setup.md"
echo
echo "Last: give your AI agent this one line (CLAUDE.md, .cursorrules, AGENTS.md, system prompt, …):"
echo
echo "  To drive my Chrome browser (real logged-in tabs), read $ROOT/AGENTS.md and run \`node $ROOT/cli.mjs <command>\`. If the health check fails, run \`node $ROOT/cli.mjs start\`; if the extension is disconnected, tell me to reload it."

# Don't leave the user guessing whether the manual step worked — the server
# already knows (health.extension); poll until the extension says hello.
echo
printf "waiting for extension to connect"
for ((i=0;i<45;i++)); do
  body=$(curl -sf -m 2 "$HEALTH") && [[ $body =~ $EXT ]] && break
  printf "."; sleep 2
done
echo
if [[ $body =~ $EXT ]]; then
  echo "✓ extension connected — setup complete"
elif [[ -z $body ]]; then
  echo "⚠ server stopped responding — check $ROOT/server.log (restart: node $ROOT/cli.mjs start)"
else
  echo "⚠ extension not connected yet — finish the steps above (or reload the extension), then re-run ./install.sh to confirm; the server keeps waiting either way"
fi
echo
