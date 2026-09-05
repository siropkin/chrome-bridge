#!/usr/bin/env node
// chrome-bridge server — zero dependencies, Node >= 18.
// One port, two faces:
//   ws://127.0.0.1:9333/ws   — the Chrome extension connects here
//   POST 127.0.0.1:9333/cmd  — the CLI (or any agent) sends commands here
//   GET  127.0.0.1:9333/health
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.BRIDGE_PORT || 9333);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CMD_TIMEOUT_MS = 70_000; // `wait` supports up to 60s
// DNS-rebinding guard for both faces: a page served from evil.com:9333 whose
// DNS flips to 127.0.0.1 becomes "same-origin" with the bridge — the Origin/
// Sec-Fetch guards still block its POSTs, but GET /log would read fine. Fetch
// can't forge Host, so requiring a loopback Host closes every route at once.
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

// server.log gets one durable line per command — cap it here, at boot, so all
// three start paths (install.sh, cli start, manual) are covered by one guard.
// ponytail: boot-time cap only — between restarts the log grows unbounded;
// the pathological writer is the 24s rejected-seat probe (~200KB/day). Add a
// daily re-check if a long-lived server's log size ever actually matters.
try {
  const p = fileURLToPath(new URL('./server.log', import.meta.url));
  if (fs.statSync(p).size > 5_000_000) fs.truncateSync(p);
} catch {} // not started from the repo (spawned) or no log yet — the next writer creates it

// --- extension seats — one per Chrome profile ---------------------------------
// Every profile's extension connects with its stable ?id= and keeps its own
// seat: multiple profiles are drivable at once, each over its own socket. The
// server routes each command to ONE profile (never multi-casts side effects):
//   0 profiles  → the classic 'extension not connected' error
//   1 profile   → straight through, zero routing overhead
//   N profiles  → probe each for matching tabs; exactly one match routes
//                 automatically, several matches refuse with a --profile hint
//                 (never silently act in the personal browser when the agent
//                 meant the work one), msg.profile overrides with an explicit
//                 id (prefix match) or the exact profile name.
const seats = new Map(); // profileId -> { socket, v, name, pending: Map, nextId }

function dropSeatPending(seat, error) {
  for (const resolve of seat.pending.values()) resolve({ ok: false, error });
  seat.pending.clear();
}

// One command to one seat. Same shape as the old single-seat sendToExt: the
// MV3 service worker cycles, so a missing socket gets a brief reconnect grace.
function ask(seat, msg, timeoutMs = CMD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const attempt = (triesLeft) => {
      // Re-resolve each try: an SW-restart reconnect replaces the seat entry —
      // retrying against the captured one would retry a dead object while a
      // fresh seat sits in the map.
      const s = seats.get(seat.pid) ?? seat;
      if (s.socket && !s.socket.destroyed) {
        const id = s.nextId++;
        s.pending.set(id, resolve);
        s.socket.write(encodeFrame(JSON.stringify({ ...msg, id })));
        setTimeout(() => {
          if (s.pending.delete(id)) reject(new Error('extension timeout'));
        }, timeoutMs);
        return;
      }
      if (triesLeft <= 0) {
        reject(new Error('extension not connected — load extension/ at chrome://extensions'));
        return;
      }
      setTimeout(() => attempt(triesLeft - 1), 250);
    };
    attempt(40);
  });
}

const idShort = (pid) => String(pid).slice(0, 4);
// Human-readable seat tag ('birch'), falling back to the id prefix: the watch
// feed is for humans, and a uuid fragment means nothing to one. The word is
// derived from the profile id by the extension — stable across restarts.
const seatTag = (pid) => seats.get(pid)?.name || idShort(pid);
function seatByProfile(want) {
  // id prefix OR exact profile name: the feed and tabs rows show the human-readable
  // name ('@poplar'), so that's what a human (or agent) will reach for first.
  const pids = [...seats.keys()].filter((p) => p.startsWith(want) || seats.get(p)?.name === want);
  if (pids.length > 1) throw new Error(`--profile '${want}' matches ${pids.length} profiles — a few more characters disambiguate`);
  if (!pids.length) throw new Error(`no connected profile matching '${want}' — run: cli profiles`);
  return seats.get(pids[0]);
}

// Route one command to exactly one profile's seat.
async function route(msg) {
  if (msg.type === 'tabs') {
    // Read-only: merged across profiles. Single profile keeps today's output
    // byte-identical (no profile tags) — the common case stays the old shape.
    if (msg.profile) return ask(seatByProfile(String(msg.profile)), msg); // pinned: that seat's rows, untagged
    if (!seats.size) throw new Error('extension not connected — load extension/ at chrome://extensions');
    if (seats.size === 1) return ask(seats.values().next().value, msg);
    const rows = [];
    for (const [pid, seat] of seats) {
      const reply = await ask(seat, msg).catch(() => null);
      const tabs = reply?.ok ? reply.result : null;
      if (!tabs) {
        rows.push({ profile: seatTag(pid), error: 'unresponsive' });
        continue;
      }
      for (const t of tabs) rows.push({ ...t, profile: seatTag(pid) });
    }
    return { ok: true, result: rows };
  }

  let seat;
  if (msg.profile) {
    seat = seatByProfile(String(msg.profile));
  } else if (seats.size === 0) {
    throw new Error('extension not connected — load extension/ at chrome://extensions');
  } else if (seats.size === 1) {
    seat = seats.values().next().value;
  } else {
    // Multi-seat: probe every profile for matching tabs. Commands without a
    // <match> (open, ping, swlogs) can't be probed — refuse with the hint.
    if (!msg.urlMatch) throw new Error(`multiple profiles are connected — name one: --profile <name or id> (see: cli profiles)`);
    const probes = await Promise.all(
      [...seats.entries()].map(async ([pid, s]) => {
        const reply = await ask(s, { type: 'probe', urlMatch: msg.urlMatch }, 5_000).catch(() => null);
        // ok:false = the seat ANSWERED but can't probe (an extension older
        // than multi-profile support). Distinct from null = never answered —
        // treating a refused probe as dead would silently bypass the
        // ambiguity refusal and report real tabs as nonexistent.
        return { pid, tabs: reply?.ok ? reply.result : null, unsupported: !!reply && !reply.ok };
      })
    );
    const stale = probes.filter((p) => p.unsupported);
    const live = probes.filter((p) => p.tabs !== null);
    const matching = live.filter((p) => p.tabs.length);
    if (stale.length)
      throw new Error(
        `⚠ ${stale.length} profile(s) can't be probed — an extension without multi-profile support is loaded (${stale
          .map((p) => seatTag(p.pid))
          .join(', ')}): reload it at chrome://extensions, or name a profile: --profile <name or id> (see: cli profiles)`
      );
    if (!live.length) throw new Error('no profile answered — extensions disconnected?');
    if (!matching.length)
      throw new Error(`no tab matching "${msg.urlMatch}" in any connected profile — run tabs to find it`);
    if (matching.length > 1)
      throw new Error(
        `⚠ "${msg.urlMatch}" matches tabs in ${matching.length} profiles (${matching.map((p) => seatTag(p.pid)).join(', ')}) — name one: --profile <name or id> (see: cli profiles)`
      );
    seat = seats.get(matching[0].pid);
    if (!seat) throw new Error('the matching profile disconnected during routing — retry the command');
  }
  // The activity feed names who acted — but only when profiles are actually
  // in play (multi-seat, or the caller named one): a lone profile keeps the
  // old single-seat line shape.
  const explicit = !!msg.profile;
  if (seats.size > 1 || explicit) msg.profile = seat.pid;
  return await ask(seat, msg);
}

// --- activity feed (`cli.mjs watch`) ----------------------------------------
// One line per relayed command: what ran, where, ok or the error, how long.
// Ring of 300; `since` in GET /log picks up only the new lines.
const activity = [];
let actSeq = 0;
// `watch` keys its `since` cursor on actSeq, which resets on restart — the
// boot id lets it detect the reset instead of silently filtering out every
// line until seq climbs back past the old high-water mark.
const bootId = Date.now();
function summarize(msg) {
  const s = [msg.type];
  if (msg.urlMatch) s.push(msg.urlMatch);
  if (msg.profile) s.push('@' + seatTag(msg.profile)); // multi-profile: who acted
  // value stays out on purpose: fill values can be secrets, and this line is
  // persisted to server.log.
  const extra =
    msg.target || msg.url || msg.key || msg.selector || msg.find || msg.text || msg.question ||
    (msg.files || []).map((f) => String(f).split('/').pop()).join(', ') || '';
  if (extra) s.push(String(extra).slice(0, 40));
  return s.join(' ');
}
function pushAct(msg, out, ms) {
  if (!msg?.type) return; // unparseable body — route already returned its error
  const line = (
    new Date().toTimeString().slice(0, 8) +
    ' ' +
    summarize(msg) +
    (out.ok ? ` · ok ${(ms / 1000).toFixed(1)}s` : ` · ✗ ${String(out.error).replace(/^(Error:\s*)+/, '').slice(0, 80)}`)
    // Page text reaches the line via error messages (click-overlay text,
    // select option values) — strip control chars so a page can't inject ANSI
    // escapes or forged newlines into server.log / the `watch` terminal.
  ).replace(/[\x00-\x1f\x7f\x9b]/g, ' ');
  activity.push({ seq: ++actSeq, line });
  if (activity.length > 300) activity.shift();
  console.log('[act] ' + line); // server.log gets a durable copy for post-mortems
}

// --- minimal RFC 6455 server (text frames) -----------------------------------
function encodeFrame(data, op = 0x1) {
  const payload = Buffer.from(data);
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | op, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | op;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | op;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

function handleWsData(seat, chunk, state) {
  state.buf = state.buf.length ? Buffer.concat([state.buf, chunk]) : chunk;
  while (true) {
    const buf = state.buf;
    if (buf.length < 2) return;
    const fin = (buf[0] & 0x80) !== 0;
    const op = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      len = Number(buf.readBigUInt64BE(2));
      off = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < off + maskLen + len) return;
    let payload = buf.subarray(off + maskLen, off + maskLen + len);
    if (masked) {
      const mask = buf.subarray(off, off + 4);
      payload = Buffer.from(payload); // copy before mutating
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    state.buf = buf.subarray(off + maskLen + len);
    if (op === 0x8) {
      seat.socket.end();
      return;
    }
    if (op === 0x9) {
      seat.socket.write(encodeFrame(payload, 0xa));
      continue;
    }
    if (op === 0xa) continue;
    state.fragments.push(payload);
    if (fin) {
      const msg = Buffer.concat(state.fragments).toString();
      state.fragments = [];
      seat.onMessage(msg); // replies are per-seat: ids are only unique within one socket
    }
  }
}

const server = http.createServer((req, res) => {
  if (!LOOPBACK_HOST.test(req.headers.host || '')) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        extension: !![...seats.values()].find((s) => s.socket && !s.socket.destroyed),
        profiles: [...seats.entries()].map(([pid, s]) => ({ id: pid, v: s.v, ...(s.name ? { name: s.name } : {}) })),
      })
    );
    return;
  }
  if (req.method === 'POST' && req.url === '/cmd') {
    // Drive-by protection: a browser page's fetch always carries Origin and
    // Sec-Fetch-* headers; the CLI (Node fetch) and curl never do. Reject
    // anything a malicious web page could have sent.
    if (req.headers.origin || req.headers['sec-fetch-site']) {
      res.writeHead(403);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let msg, out;
      const t0 = Date.now();
      try {
        msg = JSON.parse(body);
        out = await route(msg);
      } catch (e) {
        out = { ok: false, error: String(e) };
      }
      pushAct(msg, out, Date.now() - t0);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/log')) {
    // Read-only feed for `cli.mjs watch`; a page can't read the response
    // cross-origin (no CORS headers), and the Host guard above covers the
    // DNS-rebinding route to reading it same-origin.
    const since = Number(new URL(req.url, 'http://x').searchParams.get('since') || 0);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ boot: bootId, lines: activity.filter((a) => a.seq > since) }));
    return;
  }
  if (req.method === 'POST' && req.url === '/stop') {
    // Same drive-by guard as /cmd: browsers must never stop the bridge.
    if (req.headers.origin || req.headers['sec-fetch-site']) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    console.log('[bridge] stop requested — exiting');
    // Exit the moment the response is handed to the kernel, not 50ms later —
    // holding the port any longer races a `start` right behind us (the new
    // server hits EADDRINUSE while we're still bound).
    res.end(JSON.stringify({ ok: true }), () => process.exit(0));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  // Only the extension (chrome-extension:// origin) or non-browser clients
  // (no Origin header) may take the WS seat — never a web page. The Host
  // check is the same anti-rebinding guard as the HTTP face.
  const origin = req.headers.origin;
  if (!key || (origin && !origin.startsWith('chrome-extension://')) || !LOOPBACK_HOST.test(req.headers.host || '')) {
    socket.destroy();
    return;
  }
  // The extension announces its manifest version and a stable per-profile id
  // (?v=…&id=…) — /health lets `cli health` compare versions (stale-extension
  // trap after git pull) and lists every connected profile.
  const u = new URL(req.url, 'http://x');
  const v = u.searchParams.get('v');
  // Human-readable profile word (see seatTag) — display only; the id stays
  // the identity everywhere.
  const name = u.searchParams.get('name');
  // All id-less clients (old extensions, raw test sockets) share one 'anon'
  // seat: a second id-less connection is the same legacy browser reconnecting
  // (SW race) — it gets the seat-taken bounce, not a second seat posing as a
  // second profile.
  const id = u.searchParams.get('id') || 'anon';
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  // One seat per profile. A duplicate id is the SAME profile's service-worker
  // reconnect race — bounce it with a seat-taken frame (the SW backs off and
  // lets its 24s keepalive alarm re-probe) instead of evicting the live socket.
  const existing = seats.get(id);
  if (existing && existing.socket && !existing.socket.destroyed) {
    console.log(`[bridge] seat taken — rejected v=${v || '?'} id=${id} (duplicate; holder is alive)`);
    socket.write(encodeFrame(JSON.stringify({ type: 'seat-taken' })));
    socket.destroy();
    return;
  }
  const seat = {
    pid: id,
    v,
    name,
    socket,
    nextId: 1,
    pending: new Map(),
    onMessage(data) {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(msg);
      }
    },
  };
  seats.set(id, seat);
  console.log(`[bridge] extension connected origin=${origin || 'none'} v=${v || '?'} id=${id}`);
  const state = { buf: Buffer.alloc(0), fragments: [] };
  socket.on('data', (chunk) => handleWsData(seat, chunk, state));
  const onGone = () => {
    if (seats.get(id) === seat) {
      seats.delete(id);
      dropSeatPending(seat, 'extension disconnected');
      console.log(`[bridge] extension disconnected id=${id}`);
    }
    socket.destroy();
  };
  // 'end' fires on a half-open socket (peer FIN) — 'close' may never follow.
  socket.on('end', onGone);
  socket.on('close', onGone);
  socket.on('error', onGone);
});

server.listen(PORT, '127.0.0.1', () => console.log(`[bridge] ws + control on 127.0.0.1:${PORT}`));

// Heartbeat: app-level ping every 20s per seat. A socket can be open at TCP
// level with a dead service worker behind it (health says "connected" while
// commands rot to the 70s timeout) — no pong in 5s means the seat is deaf,
// free it. The ping traffic also wakes/extends the MV3 service worker, so
// this doubles as the keepalive.
setInterval(() => {
  for (const seat of seats.values()) {
    if (!seat.socket || seat.socket.destroyed) continue;
    const t = setTimeout(() => {
      if (seat.pending.delete(seat.pingId)) seat.socket.destroy();
    }, 5000);
    seat.pingId = seat.nextId++;
    seat.pending.set(seat.pingId, () => clearTimeout(t));
    seat.socket.write(encodeFrame(JSON.stringify({ type: 'ping', id: seat.pingId })));
  }
}, 20_000);
