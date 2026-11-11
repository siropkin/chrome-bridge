// Local authentication — zero dependencies, Node >= 18.
//
// The bridge listens on 127.0.0.1, which every OS user on this computer can
// reach. This module keeps a per-user install key and proves both ends of a
// local request know it, so another OS user can neither drive this user's
// Chrome through the server nor pose as the server to the CLI.
//
// Key: 32 random bytes (base64url) in a private per-user folder, outside every
// checkout — stateDir() below. The server creates it (and repairs one other
// users could read, by replacing it); clients only read it. Never print it.
//
// Request (what bridgeFetch does; a raw HTTP client must do the same):
//   1. GET /auth?c=<client nonce>  →  {"s": <server nonce>, "p": H("server", c, s)}
//   2. Check p BEFORE sending anything else: a program that can't produce it
//      isn't this user's server, and the command must not reach it.
//   3. Send the request with  x-bridge-auth: <s>.<H("cli", s, "<METHOD> <path>", sha256(body))>
//      s is single-use and expires after 30 s.
//   H(...parts) = base64url(HMAC-SHA256(key, ["chrome-bridge/1", ...parts].join("\n")))
//   sha256(body) = base64url of the SHA-256 of the raw body bytes ("" for none).
//
// Extension (/ws?…&c=<client nonce>): the server's first frame is
//   {"type":"auth","s":<server nonce>,"p":H("server", c, s)}
// and the extension checks p, then answers {"type":"auth","m":H("extension", s, c)};
// only then does it get a seat. It reads the key through Chrome native
// messaging (nativehost.mjs). Without a key it dials once with &nokey=<why>
// (the server re-registers its helper) and is refused.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const CHALLENGE_TTL_MS = 30_000;
const MAX_CHALLENGES = 1024;
const posix = process.platform !== 'win32';

// Per-user and outside every checkout (an npm install lives in ~/.chrome-bridge,
// a key there would dirty the clone and survive its removal). Windows: the
// LOCALAPPDATA folder is already readable by this user (and admins) only.
export function stateDir(env = process.env, platform = process.platform, home = homedir()) {
  if (env.BRIDGE_STATE_DIR) return env.BRIDGE_STATE_DIR;
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'chrome-bridge');
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'chrome-bridge');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'chrome-bridge');
}

export class LocalAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'unverified' | 'unsafe'
  }
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const nonce = () => b64u(crypto.randomBytes(18));
export const bodyHash = (body) => crypto.createHash('sha256').update(body ?? '').digest('base64url');
export const mac = (key, ...parts) => crypto.createHmac('sha256', Buffer.from(key, 'base64url')).update(['chrome-bridge/1', ...parts].join('\n')).digest('base64url');
// Bytes, not characters: a header is decoded as latin1, so 43 characters can
// be more than 43 bytes — and timingSafeEqual throws on a length mismatch,
// which took the whole server down. Anything not base64url is simply wrong.
const MAC_RE = /^[A-Za-z0-9_-]{43}$/;
export const same = (a, b) => typeof a === 'string' && typeof b === 'string' && MAC_RE.test(a) && MAC_RE.test(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const isNonce = (c) => typeof c === 'string' && NONCE_RE.test(c);

// Owner and mode of one path: null when missing; throws when another OS user
// owns it (nothing here can repair that).
function inspect(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  if (posix && st.uid !== process.getuid())
    throw new LocalAuthError('unsafe', `${p} belongs to another OS user, so it can't hold this user's chrome-bridge key — remove it (or ask its owner to), then: node cli.mjs start`);
  return { open: posix && (st.mode & 0o077) !== 0 };
}

// Server side: the key, created on first use. A folder or file other OS users
// could read gets locked down and a NEW key — the old one may have leaked.
export function ensureKey(dir = stateDir()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'key');
  const d = inspect(dir);
  const f = inspect(file);
  if (d.open) fs.chmodSync(dir, 0o700);
  if (f && (f.open || d.open || !KEY_RE.test(fs.readFileSync(file, 'utf8')))) fs.rmSync(file);
  try {
    fs.writeFileSync(file, b64u(crypto.randomBytes(32)), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e; // EEXIST: a concurrent start created it first — use theirs
  }
  return fs.readFileSync(file, 'utf8');
}

// Client side: read only. A key other users could read can't vouch for anything.
export function readKey(dir = stateDir()) {
  const file = join(dir, 'key');
  const d = inspect(dir);
  const f = d && inspect(file);
  if (!f) return null;
  if (d.open || f.open) throw new LocalAuthError('unsafe', `${file} is readable by other OS users — restarting the bridge replaces it with a private key: node cli.mjs stop && node cli.mjs start`);
  const key = fs.readFileSync(file, 'utf8');
  return KEY_RE.test(key) ? key : null;
}

// Server side: issue single-use challenges and check signed requests.
export function createGuard(dir = stateDir()) {
  const pending = new Map(); // server nonce → { key, exp }
  return {
    // null for a malformed client nonce (→ 400)
    challenge(cn) {
      if (typeof cn !== 'string' || !NONCE_RE.test(cn)) return null;
      // Re-read every time: a key deleted under a running server comes back,
      // and a rotated one is used from the next request on.
      const key = ensureKey(dir);
      const s = nonce();
      pending.set(s, { key, exp: Date.now() + CHALLENGE_TTL_MS });
      if (pending.size > MAX_CHALLENGES) pending.delete(pending.keys().next().value);
      return { s, p: mac(key, 'server', cn, s) };
    },
    verify(header, method, url, rawBody) {
      const [s, m] = String(header || '').split('.');
      const entry = s && pending.get(s);
      if (!entry) return false;
      pending.delete(s);
      return entry.exp > Date.now() && same(m, mac(entry.key, 'cli', s, `${method} ${url}`, bodyHash(rawBody)));
    },
  };
}

export const UNAUTHENTICATED =
  "not authenticated — local requests must be signed with this OS user's chrome-bridge key. Use node cli.mjs <command> (it signs automatically); a raw HTTP client can import bridgeFetch from localauth.mjs";

// Client side: fetch(base + path, init), signed — and only after the server
// proved it holds this user's key. Network errors propagate unchanged.
export async function bridgeFetch(base, path, init = {}, dir = stateDir()) {
  const cn = nonce();
  const where = base.replace(/^https?:\/\//, '');
  const r = await fetch(`${base}/auth?c=${cn}`, { signal: init.signal });
  const a = await r.json().catch(() => null);
  const key = readKey(dir);
  if (!key || typeof a?.s !== 'string' || !same(a.p, mac(key, 'server', cn, a.s)))
    throw new LocalAuthError(
      'unverified',
      `the program on ${where} couldn't prove it is this OS user's chrome-bridge server, so nothing was sent to it — restart the bridge: node cli.mjs stop && node cli.mjs start (if start says the port is taken, see who holds it: lsof -i :${where.split(':')[1] || 9333})`
    );
  const method = (init.method || 'GET').toUpperCase();
  const header = `${a.s}.${mac(key, 'cli', a.s, `${method} ${path}`, bodyHash(init.body))}`;
  return fetch(base + path, { ...init, headers: { ...init.headers, 'x-bridge-auth': header } });
}

// Checkouts that started a server with this key folder — uninstall removes the
// folder only once no other checkout still uses it.
export function registerCheckout(repo, dir = stateDir()) {
  const file = join(dir, 'checkouts.json');
  const list = new Set(listCheckouts(dir));
  if (list.has(repo)) return;
  list.add(repo);
  fs.writeFileSync(file, JSON.stringify([...list], null, 1) + '\n', { mode: 0o600 });
}
export function listCheckouts(dir = stateDir()) {
  try {
    const list = JSON.parse(fs.readFileSync(join(dir, 'checkouts.json'), 'utf8'));
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}
