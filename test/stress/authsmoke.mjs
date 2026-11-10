// Local authentication against a real Chrome, on any OS: the extension got
// the key through the native messaging host and took an authenticated seat
// (not legacy), a command makes the round trip, and after `extreload` the new
// worker authenticates again. CI's Windows job runs it — the Windows host
// (.cmd through cmd.exe, HKCU registry, the unpacked id from the UTF-16 path)
// has no other end-to-end check; run.sh is bash- and macOS/Linux-shaped.
//
// Usage: node test/stress/authsmoke.mjs [--profile <name>] [--url <page>] [--uninstall]
//   --profile    the profile to drive (default: the only one connected)
//   --url        a page to open (default: the stress fixture server's static.html)
//   --uninstall  then remove this OS user's host registration and check it's
//                gone, then register it again — CI only: on a real computer it
//                rewrites the registration every installed Chrome reads.
// Exit 0 = every check passed; each failure prints what was seen.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registeredHosts, registerHosts, unpackedId, unregisterHosts } from '../../nativehost.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'cli.mjs');
const opt = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
let profile = opt('--profile');
const url = opt('--url') || 'http://localhost:9334/fixtures/static.html?a=authsmoke';
const match = 'a=authsmoke';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (what) => console.log('PASS ' + what);
const bad = (what, seen) => {
  failed++;
  console.log('FAIL ' + what + (seen === undefined ? '' : '\n  seen: ' + String(seen).trim().split('\n').join('\n        ')));
};
const cli = (...a) => {
  const r = spawnSync(process.execPath, [CLI, ...a, ...(profile ? ['--profile', profile] : [])], { encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const health = () =>
  fetch('http://127.0.0.1:9333/health')
    .then((r) => r.json())
    .catch(() => null);
const seatOf = (h) => (h?.profiles || []).find((p) => (profile ? p.name === profile : true));

// 1. An authenticated seat — Chrome usually starts after the server here, so
// the first dial has no key (&nokey=not-found) and the retry must get it.
let h = null;
for (let i = 0; i < 45 && !seatOf(h); i++) {
  if (i) await sleep(2000);
  h = await health();
}
const seat = seatOf(h);
if (!seat) {
  bad('extension took a seat within 90s', JSON.stringify(h));
  process.exit(1);
}
if (!profile && h.profiles.length > 1) {
  bad('one profile connected (pass --profile <name> to pick one)', JSON.stringify(h.profiles));
  process.exit(1);
}
profile = seat.name;
seat.legacy ? bad(`profile ${profile} seated with local authentication`, JSON.stringify(h)) : ok(`profile ${profile} seated with local authentication (v${seat.v})`);

// 2. A command round trip through the signed CLI → server → extension.
const roundTrip = (tag) => {
  const o = cli('open', url);
  if (o.code !== 0) return bad(`${tag}: open ${url}`, o.out);
  const e = cli('eval', match, 'location.search');
  e.code === 0 && e.out.includes(match) ? ok(`${tag}: open + eval round trip`) : bad(`${tag}: eval on the opened tab`, e.out);
  const c = cli('close', match);
  if (c.code !== 0) bad(`${tag}: close`, c.out);
};
roundTrip('first seat');

// 3. extreload: the NEW worker (swlogs "loaded <time>" after t0) seats with
// authentication again — "extension":true alone is the old socket for a moment.
const t0 = Date.now();
const r = cli('extreload');
if (r.code !== 0) bad('extreload', r.out);
let back = false;
for (let i = 0; i < 30 && !back; i++) {
  await sleep(2000);
  const s = cli('swlogs');
  back = s.code === 0 && [...s.out.matchAll(/ loaded (\S+Z)/g)].some((m) => Date.parse(m[1]) >= t0);
}
h = await health();
const again = seatOf(h);
if (!back || !again) bad('extension came back after extreload within 60s', JSON.stringify(h));
else {
  again.legacy ? bad('reloaded worker seated with local authentication', JSON.stringify(again)) : ok('reloaded worker seated with local authentication');
  roundTrip('after extreload');
}

// 4. The registration names this checkout's unpacked id — the id Chrome
// computed for the loaded extension, or the seat above couldn't have happened.
const reg = registeredHosts();
const id = unpackedId(join(REPO, 'extension'));
const named = reg.manifests.some((f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')).allowed_origins.includes(`chrome-extension://${id}/`);
  } catch {
    return false;
  }
});
named ? ok(`host manifest allows this checkout's unpacked id ${id}`) : bad(`host manifest allows ${id}`, JSON.stringify(reg));
if (process.platform === 'win32') reg.keys.length ? ok(`registry values: ${reg.keys.join(', ')}`) : bad('HKCU NativeMessagingHosts values present', JSON.stringify(reg));

// 5. Uninstall's half: everything registered goes, then comes back.
if (process.argv.includes('--uninstall')) {
  const removed = unregisterHosts();
  const left = registeredHosts();
  !left.manifests.length && !left.keys.length ? ok(`unregister removed ${removed.length} entries`) : bad('unregister left nothing behind', JSON.stringify({ removed, left }));
  const re = registerHosts();
  re.errors.length ? bad('register again', re.errors.join('; ')) : ok('registered again');
}

console.log(`=== authsmoke: ${failed ? failed + ' failed' : 'all passed'} ===`);
process.exit(failed ? 1 : 0);
