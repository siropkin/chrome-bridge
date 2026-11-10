// Native messaging host — how the extension gets this OS user's local key
// (localauth.mjs) with nothing for the user to do. Zero dependencies.
//
// The server writes a tiny helper program next to the key and tells Chrome
// where it is (a host manifest per browser folder; on Windows a registry
// value). The extension asks Chrome to run it and reads the key from its
// reply. Chrome looks only in THIS OS user's folders and registry, and runs a
// host only for the extension ids in allowed_origins — so another OS user can
// neither answer the extension nor read the key through it.
//
// Where Chrome looks (developer.chrome.com/docs/extensions/develop/concepts/native-messaging):
//   macOS/Linux  <user data dir>/NativeMessagingHosts/<name>.json — the default
//                folder of each installed browser, and the --user-data-dir of
//                any Chrome started with one (agents and CI do), found in ps.
//   Windows      HKCU\Software\Google\Chrome\NativeMessagingHosts\<name> = path
//                of the manifest (Chrome and Chrome for Testing read that key;
//                Chromium reads its own first, Edge its own).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import { listCheckouts, stateDir } from './localauth.mjs';

export const HOST_NAME = 'com.siropkin.chrome_bridge';
export const STORE_ID = 'kmhjlnokjigmnimgjjmiahlinjbcebkg';
const MANIFEST = HOST_NAME + '.json';
const REG_KEYS = ['Google\\Chrome', 'Chromium', 'Microsoft\\Edge'].map((k) => `HKCU\\Software\\${k}\\NativeMessagingHosts\\${HOST_NAME}`);

// Default user data dirs per browser; only the ones that exist get a manifest.
const BROWSER_DIRS = {
  darwin: ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Dev', 'Google/Chrome Canary', 'Google/Chrome for Testing', 'Chromium', 'Microsoft Edge', 'BraveSoftware/Brave-Browser'],
  linux: ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'google-chrome-for-testing', 'chromium', 'microsoft-edge', 'BraveSoftware/Brave-Browser'],
};

// The id Chrome gives an unpacked extension: the first 128 bits of
// SHA-256(absolute path), hex mapped to a-p. POSIX hashes the realpath's
// bytes; Windows the UTF-16 path with an upper-case drive letter
// (components/crx_file/id_util.cc).
export function unpackedId(dir, platform = process.platform) {
  let p = dir;
  let bytes;
  if (platform === 'win32') {
    p = win32.resolve(dir).replace(/^[a-z]:/, (d) => d.toUpperCase());
    bytes = Buffer.from(p, 'utf16le');
  } else {
    try {
      p = fs.realpathSync(dir);
    } catch {}
    bytes = Buffer.from(p, 'utf8');
  }
  return [...crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

// Extensions allowed to ask for the key: the Web Store build, and an unpacked
// build loaded from any checkout whose server ran with this key folder.
export function allowedOrigins(dir = stateDir(), platform = process.platform) {
  const ids = new Set([STORE_ID]);
  for (const repo of listCheckouts(dir)) {
    const ext = join(repo, 'extension');
    if (fs.existsSync(join(ext, 'manifest.json'))) ids.add(unpackedId(ext, platform));
  }
  return [...ids].map((id) => `chrome-extension://${id}/`);
}

// Chrome processes of THIS OS user started with --user-data-dir (an agent's
// own Chrome, CI). ps prints arguments unquoted: a path runs up to the next
// " --" flag. POSIX only — Windows hosts are found through the registry.
export function runningUserDataDirs(platform = process.platform) {
  if (platform === 'win32') return [];
  const r = spawnSync('ps', ['-A', '-ww', '-o', 'uid=', '-o', 'args='], { encoding: 'utf8', timeout: 3000 });
  if (r.status !== 0 || !r.stdout) return [];
  const uid = process.getuid();
  const dirs = new Set();
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m || Number(m[1]) !== uid) continue;
    const args = m[2];
    if (!/chrom|msedge|microsoft edge|brave/i.test(args.split(' --')[0])) continue;
    const d = args.match(/--user-data-dir=(.+?)(?=\s--|$)/)?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2');
    if (!d || !isAbsolute(d)) continue;
    try {
      const st = fs.statSync(d);
      if (st.isDirectory() && st.uid === uid) dirs.add(d);
    } catch {}
  }
  return [...dirs];
}

// A key folder moved by BRIDGE_STATE_DIR (tests) or an explicit host list:
// never touch the user's real browsers — a manifest pointing Chrome at a
// scratch key would lock the real extension out.
const isolated = (env) => !!(env.BRIDGE_STATE_DIR || env.BRIDGE_HOST_DIRS);

// Every NativeMessagingHosts folder that should hold our manifest.
// Isolated: exactly BRIDGE_HOST_DIRS (a path list), possibly none.
export function hostDirs({ env = process.env, platform = process.platform, home = homedir(), scan = true } = {}) {
  if (isolated(env)) return (env.BRIDGE_HOST_DIRS || '').split(delimiter).filter(Boolean);
  const base = platform === 'darwin' ? join(home, 'Library', 'Application Support') : platform === 'linux' ? env.XDG_CONFIG_HOME || join(home, '.config') : null;
  if (!base) return [];
  const out = BROWSER_DIRS[platform].map((b) => join(base, ...b.split('/'))).filter((d) => fs.existsSync(d));
  if (scan) out.push(...runningUserDataDirs(platform));
  return [...new Set(out)].map((d) => join(d, 'NativeMessagingHosts'));
}

// The helper itself. POSIX: a sh script (no Node: a Node upgrade can't break
// it). It prints one native-messaging frame — a 4-byte little-endian length,
// then JSON: {"k":"<key>"} (51 bytes) or {"e":"missing"} (15 bytes).
// Windows: Chrome starts a non-.exe host through cmd.exe; the .cmd runs a
// small Node script with the node that runs this server (rewritten on every
// start, so a moved Node heals with the next start).
function writeHostProgram(dir, platform) {
  if (platform === 'win32') {
    const js = join(dir, 'native-host.cjs');
    writeIfChanged(
      js,
      `// chrome-bridge native messaging host: hands this OS user's local key to the extension.\nconst fs = require('fs'), path = require('path');\nlet m = { e: 'missing' };\ntry {\n  const k = fs.readFileSync(path.join(__dirname, 'key'), 'utf8');\n  if (/^[A-Za-z0-9_-]{43}$/.test(k)) m = { k };\n} catch {}\nconst b = Buffer.from(JSON.stringify(m)), h = Buffer.alloc(4);\nh.writeUInt32LE(b.length);\nprocess.stdout.write(Buffer.concat([h, b]));\n`,
      0o600
    );
    const cmd = join(dir, 'native-host.cmd');
    writeIfChanged(cmd, `@echo off\r\n"${process.execPath}" "%~dp0native-host.cjs"\r\n`, 0o700);
    return cmd;
  }
  const sh = join(dir, 'native-host.sh');
  writeIfChanged(
    sh,
    `#!/bin/sh\n# chrome-bridge native messaging host: hands this OS user's local key to the extension.\nk=$(cat "$(dirname "$0")/key" 2>/dev/null)\ncase "$k" in\n  ${'?'.repeat(43)}) printf '\\063\\000\\000\\000{"k":"%s"}' "$k" ;;\n  *) printf '\\017\\000\\000\\000{"e":"missing"}' ;;\nesac\n`,
    0o700
  );
  return sh;
}

function writeIfChanged(file, text, mode) {
  let same = false;
  try {
    same = fs.readFileSync(file, 'utf8') === text;
  } catch {}
  if (!same) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode });
    fs.renameSync(tmp, file); // Chrome never reads a half-written manifest
  }
  fs.chmodSync(file, mode);
  return !same;
}

const recordFile = (dir) => join(dir, 'hosts.json');
function readRecord(dir) {
  try {
    const r = JSON.parse(fs.readFileSync(recordFile(dir), 'utf8'));
    return Array.isArray(r?.manifests) ? r.manifests.filter((p) => typeof p === 'string' && p.endsWith(MANIFEST)) : [];
  } catch {
    return [];
  }
}

const reg = (...args) => spawnSync('reg', args, { encoding: 'utf8', windowsHide: true, timeout: 5000 });

// Write the helper and a manifest wherever Chrome looks. Returns
// { host, manifests: [paths written or current], errors: [text] }.
export function registerHosts({ dir = stateDir(), env = process.env, platform = process.platform, home = homedir(), scan = true } = {}) {
  const host = writeHostProgram(dir, platform);
  const manifest = JSON.stringify({ name: HOST_NAME, description: "chrome-bridge: gives the extension this OS user's local key", path: host, type: 'stdio', allowed_origins: allowedOrigins(dir, platform) }, null, 1) + '\n';
  const manifests = [];
  const errors = [];
  const put = (file) => {
    try {
      fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeIfChanged(file, manifest, 0o600);
      manifests.push(file);
    } catch (e) {
      errors.push(`${file}: ${e.code || e.message}`);
    }
  };
  if (platform === 'win32' && !isolated(env)) {
    const file = join(dir, MANIFEST);
    put(file);
    for (const key of REG_KEYS) {
      const r = reg('add', key, '/ve', '/t', 'REG_SZ', '/d', file, '/f');
      if (r.status !== 0) errors.push(`${key}: ${(r.stderr || r.error?.message || 'reg add failed').trim()}`);
    }
  } else for (const d of hostDirs({ env, platform, home, scan })) put(join(d, MANIFEST));
  // Remember every place we wrote, so uninstall finds folders of Chromes
  // that have since quit (a stale --user-data-dir).
  const all = [...new Set([...readRecord(dir), ...manifests])].filter((p) => fs.existsSync(p));
  try {
    writeIfChanged(recordFile(dir), JSON.stringify({ manifests: all }, null, 1) + '\n', 0o600);
  } catch (e) {
    errors.push(`${recordFile(dir)}: ${e.code || e.message}`);
  }
  return { host, manifests, errors };
}

// Where our helper is registered now: manifests that name our host and
// point into this key folder (never another program's), and registry values.
export function registeredHosts({ dir = stateDir(), env = process.env, platform = process.platform, home = homedir() } = {}) {
  const candidates = new Set(readRecord(dir));
  if (platform === 'win32' && !isolated(env)) candidates.add(join(dir, MANIFEST));
  else for (const d of hostDirs({ env, platform, home, scan: false })) candidates.add(join(d, MANIFEST));
  const manifests = [...candidates].filter((file) => {
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      return m?.name === HOST_NAME && typeof m.path === 'string' && dirname(m.path) === dir;
    } catch {
      return false;
    }
  });
  const keys = platform === 'win32' && !isolated(env) ? REG_KEYS.filter((key) => reg('query', key, '/ve').status === 0) : [];
  return { manifests, keys };
}

// Undo registerHosts: the manifests and registry values above, and the
// helper. Returns what it removed.
export function unregisterHosts(opts = {}) {
  const { dir = stateDir() } = opts;
  const { manifests, keys } = registeredHosts(opts);
  const removed = [];
  for (const file of manifests) {
    try {
      fs.rmSync(file);
      removed.push(file);
    } catch {}
  }
  for (const key of keys) if (reg('delete', key, '/f').status === 0) removed.push(key);
  for (const f of ['native-host.sh', 'native-host.cmd', 'native-host.cjs', 'hosts.json']) {
    try {
      fs.rmSync(join(dir, f));
      removed.push(join(dir, f));
    } catch {}
  }
  return removed;
}
