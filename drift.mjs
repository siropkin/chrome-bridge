// Version drift between the four moving parts — the server process, its
// checkout on disk, each connected extension, and (for store installs) the
// release that extension came from. Pure functions: server.mjs feeds them
// live state, cli.mjs `update` plans with them, tests call them directly.

export const versionNewer = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

const label = (s) => s.name || String(s.pid).slice(0, 4);

// -> [{ pid: string|null, text }]; pid null = about the server itself (every
// command is affected), else about that one profile's extension.
//   bootVersion   package.json version when this server process started
//   diskVersion   package.json version on disk now
//   serverStale   server code files changed on disk after the process started
//   manifestVersion  extension/manifest.json on disk now
//   extMtime      newest mtime under extension/ (dev seats' same-version drift)
//   seats         [{ pid, name, v, install: 'store'|'dev'|null, boot }]
export function driftWarnings({ bootVersion, diskVersion, serverStale, manifestVersion, extMtime, seats }) {
  const out = [];
  const multi = seats.length > 1;
  if (bootVersion && diskVersion && bootVersion !== diskVersion)
    out.push({ pid: null, text: `this server runs ${bootVersion} code but its checkout now has ${diskVersion} — restart it: \`cli.mjs update\` (or \`cli.mjs stop && cli.mjs start\`)` });
  else if (serverStale)
    out.push({ pid: null, text: 'server code on disk changed after this server started — restart it: `cli.mjs stop && cli.mjs start`' });
  for (const s of seats) {
    if (!s.v || !manifestVersion) continue;
    if (s.install === 'store') {
      // Chrome auto-updates the store build; the checkout (CLI, server, skill)
      // only moves when someone runs update. Either direction is drift: an
      // older checkout lacks the extension's commands, a newer one documents
      // features this extension doesn't have yet (master runs ahead of the
      // store while a release sits in review).
      if (s.v === manifestVersion) continue;
      out.push({
        pid: s.pid,
        text: versionNewer(s.v, manifestVersion)
          ? `extension ${s.v} (Chrome Web Store, profile ${label(s)}) is newer than this bridge download (${manifestVersion}) — run \`cli.mjs update\``
          : `this bridge download (${manifestVersion}) is ahead of the Chrome Web Store extension ${s.v} (profile ${label(s)}) — its skill and CLI describe features that extension lacks: run \`cli.mjs update\` to match it`,
      });
      continue;
    }
    if (s.install !== 'dev') continue;
    const fix = multi ? `cli.mjs extreload --profile ${JSON.stringify(label(s))}` : 'cli.mjs extreload';
    if (s.v !== manifestVersion) out.push({ pid: s.pid, text: `extension ${s.v} is loaded (profile ${label(s)}), the repo has ${manifestVersion} — run \`${fix}\` (or reload at chrome://extensions)` });
    else if (s.boot && extMtime > s.boot + 2000)
      out.push({
        pid: s.pid,
        text: `extension code on disk changed after this build loaded (${new Date(extMtime).toISOString().slice(0, 16).replace('T', ' ')} UTC) — the running code may be stale: run \`${fix}\` (or reload at chrome://extensions)`,
      });
  }
  return out;
}

// What `cli.mjs update` should move the checkout to. A store install pins the
// checkout to the release tag of the extension Chrome actually runs — the
// skill and CLI then describe exactly that build. A dev install loads the
// extension from this checkout, so it follows the branch.
//   -> { target: 'branch' } | { target: 'tag', tag: 'vX.Y.Z', note? } | { error }
export function updateTarget(seats) {
  const live = seats.filter((s) => s.v);
  if (!live.length) return { error: 'no extension connected — update matches the download to your extension, so connect it first (cli.mjs health)' };
  const store = live.filter((s) => s.install === 'store');
  const dev = live.filter((s) => s.install !== 'store');
  if (store.length && !dev.length) {
    const v = store.map((s) => s.v).reduce((a, b) => (versionNewer(b, a) ? b : a));
    return { target: 'tag', tag: 'v' + v };
  }
  return { target: 'branch', ...(store.length ? { note: 'an unpacked build loads from this checkout, so it follows the branch — the store profile may run an older release than the docs describe' } : {}) };
}
