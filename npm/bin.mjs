#!/usr/bin/env node
// chrome-bridge installer/launcher.
//   npx @siropkin/chrome-bridge           install/update into ~/.chrome-bridge, start the server, print next steps
//   npx @siropkin/chrome-bridge <args…>   same, then run the real CLI with <args>
// The bridge lives at github.com/siropkin/chrome-bridge — this package only
// fetches and runs it, so the npm version can lag the repo harmlessly.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = process.env.CHROME_BRIDGE_HOME || join(homedir(), '.chrome-bridge');
const REPO = 'https://github.com/siropkin/chrome-bridge';
const cli = join(DIR, 'cli.mjs');

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) {
    console.error(`chrome-bridge: failed to run ${cmd} — ${r.error.message}`);
    process.exit(1);
  }
  return r.status ?? 0;
};

if (!existsSync(cli)) {
  console.log(`chrome-bridge: installing into ${DIR}`);
  if (run('git', ['clone', '--depth', '1', REPO, DIR]) !== 0) {
    console.error(`chrome-bridge: git clone failed — install git, or clone by hand: git clone ${REPO}`);
    process.exit(1);
  }
} else {
  // Best-effort freshen — a pull failure (offline, pinned tag, dirty tree)
  // never blocks the CLI, so its noise goes nowhere too.
  run('git', ['-C', DIR, 'pull', '--ff-only', '--quiet'], { stdio: 'ignore' });
}

// The server start is a no-op when one is already up (any checkout, port 9333).
if (run(process.execPath, [cli, 'start']) !== 0) process.exit(1);

const args = process.argv.slice(2);
if (args.length) process.exit(run(process.execPath, [cli, ...args]));

console.log(`
chrome-bridge is up (checkout: ${DIR})
Next: install the Chrome extension — easiest from the Chrome Web Store:
  https://chromewebstore.google.com/detail/chrome-bridge/kmhjlnokjigmnimgjjmiahlinjbcebkg
  (or load ${join(DIR, 'extension')} unpacked at chrome://extensions)
Verify: npx @siropkin/chrome-bridge health`);
