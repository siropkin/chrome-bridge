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

// Port 9333 is hardcoded in THREE places: extension/background.js (WS_URL —
// the extension can't read BRIDGE_PORT), cli.mjs, here. Change all three.
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
// the pathological writer is the 30s rejected-seat probe (~160KB/day). Add a
// daily re-check if a long-lived server's log size ever actually matters.
try {
  const p = fileURLToPath(new URL('./server.log', import.meta.url));
  fs.chmodSync(p, 0o600); // the log holds URL fragments and page text — owner-only, every boot
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
    const t0 = Date.now();
    const attempt = (triesLeft) => {
      // Re-resolve each try: an SW-restart reconnect replaces the seat entry —
      // retrying against the captured one would retry a dead object while a
      // fresh seat sits in the map.
      const s = seats.get(seat.pid) ?? seat;
      if (s.socket && !s.socket.destroyed) {
        const id = s.nextId++;
        // The budget is end-to-end: time burned in the no-socket retry loop
        // below comes OUT of it (a '5s deaf-seat budget' probe used to retry
        // 10s and only then start its 5s write timeout — 15s total).
        const left = timeoutMs - (Date.now() - t0);
        if (left <= 0) return reject(new Error('extension timeout'));
        const t = setTimeout(() => {
          if (s.pending.delete(id)) reject(new Error('extension timeout'));
        }, left);
        // Cleared on settle: one live 70s timer per command is storm litter.
        s.pending.set(id, (m) => {
          clearTimeout(t);
          resolve(m);
        });
        s.socket.write(encodeFrame(JSON.stringify({ ...msg, id })));
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
// Reconnect grace for the pinned path, symmetric with ask()'s 10s no-socket
// retry: right after a server restart the seats re-take in ~0.5-2s, and a
// --profile command landing in that window used to die instantly while an
// unpinned one rode the reconnect out (found by the parallel stress suite).
async function seatByProfileGrace(want) {
  const t0 = Date.now();
  for (;;) {
    try {
      return seatByProfile(want);
    } catch (e) {
      // Only the missing-seat case waits — an ambiguous prefix fails NOW.
      if (!/no connected profile matching/.test(String(e)) || Date.now() - t0 > 10_000) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

// Route one command to exactly one profile's seat.
// Adding a command? SEVEN registries stay in sync (a missing one fails SILENTLY):
// cli.mjs USAGE · cli.mjs run() · server.mjs CLI_LINES · server.mjs route() (only if it
// needs special routing) · background.js handle() · ACT_VERBS (pill narration) · MUTATING.
async function route(msg) {
  if (msg.type === 'tabs') {
    // Read-only: merged across profiles. Single profile keeps today's output
    // byte-identical (no profile tags) — the common case stays the old shape.
    if (msg.profile) return ask(await seatByProfileGrace(String(msg.profile)), msg); // pinned: that seat's rows, untagged
    if (!seats.size) throw new Error('extension not connected — load extension/ at chrome://extensions');
    if (seats.size === 1) return ask(seats.values().next().value, msg);
    const rows = [];
    for (const [pid, seat] of seats) {
      // 5s deaf-seat budget, same as the match probe below — a live seat
      // answers tabs in ms (the heartbeat keeps the SW warm); without the cap
      // one wedged profile would hold the whole merged list for 70s.
      const reply = await ask(seat, msg, 5_000).catch(() => null);
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
    seat = await seatByProfileGrace(String(msg.profile));
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
    const deaf = probes.filter((p) => !p.unsupported && p.tabs === null);
    const live = probes.filter((p) => p.tabs !== null);
    const matching = live.filter((p) => p.tabs.length);
    if (stale.length)
      throw new Error(
        `⚠ ${stale.length} profile(s) can't be probed — an extension without multi-profile support is loaded (${stale
          .map((p) => seatTag(p.pid))
          .join(', ')}): reload it at chrome://extensions, or name a profile: --profile <name or id> (see: cli profiles)`
      );
    // A probe that timed out is "can't know", NOT "no tabs match": excluding
    // it would auto-route into the other profile on a unique match — silently
    // bypassing the ambiguity refusal, the exact thing it exists to prevent
    // (usually a mid-restart service worker; retry or name a profile).
    if (deaf.length)
      throw new Error(
        `⚠ ${deaf.length} profile(s) didn't answer the match probe (${deaf
          .map((p) => seatTag(p.pid))
          .join(', ')}) — usually a service-worker restart; retry the command, or name a profile: --profile <name or id> (see: cli profiles)`
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
  // `wait --human` blocks for minutes (CAPTCHA/2FA handoff) — the 70s command
  // cap would kill it mid-handoff. 285s, just under the CLI HTTP client's
  // 5-min wall, which is the real ceiling (undici aborts the fetch at 300s).
  return await ask(seat, msg, msg.type === 'wait' && msg.human ? 285_000 : CMD_TIMEOUT_MS);
}

// --- activity feed (`cli.mjs watch`) ----------------------------------------
// One line per relayed command: what ran, where, ok or the error, how long.
// Ring of 300; `since` in GET /log picks up only the new lines.
const activity = [];
let actSeq = 0;

// Replayable CLI line for the ring, rebuilt from the command at relay time —
// `history --batch` turns the ring into a script. shellq matches cli batch's
// tokenizer ("double"/'single' quotes, glued to bare words): a token is bare
// only when whitespace/quotes can't split it and it isn't flag-shaped (a fill
// value like '--draft' must ride quoted or the fill parser rejects it as a
// flag). The ring is memory-only — server.log keeps the value-free display
// line, so fill values still never reach the durable log (same local trust
// line as /cmd itself).
const shellq = (s) => {
  s = String(s);
  return /[\s'"#]/.test(s) || /^--/.test(s) ? (s.includes('"') ? `'${s}'` : `"${s}"`) : s;
};
const D = (m) => (m.diff ? ' --diff' : '');
// Adding a command? SEVEN registries stay in sync (a missing one fails SILENTLY):
// cli.mjs USAGE · cli.mjs run() · server.mjs CLI_LINES · server.mjs route() (only if it
// needs special routing) · background.js handle() · ACT_VERBS (pill narration) · MUTATING.
// CLI_LINES mirrors the flag parsers in cli.mjs run() flag-for-flag — an
// unmirrored flag is silently dropped from history --batch replays.
const CLI_LINES = {
  open: (m) => `open ${shellq(m.url)}`,
  navigate: (m) => `nav ${shellq(m.urlMatch)} ${shellq(m.url)}${D(m)}`,
  close: (m) => `close ${shellq(m.urlMatch)}`,
  mark: (m) => `mark ${shellq(m.urlMatch)}`,
  release: (m) => `release ${shellq(m.urlMatch)}`,
  unemulate: (m) => `unemulate ${shellq(m.urlMatch)}`,
  tabs: (m) => `tabs${m.urlMatch ? ' ' + shellq(m.urlMatch) : ''}`,
  swlogs: () => 'swlogs',
  snap: (m) =>
    `snap ${shellq(m.urlMatch)}${m.scope ? ' ' + shellq(m.scope) : ''}${m.href ? ' --href' : ''}${m.skeleton ? ' --skeleton' : ''}${m.find ? ' --find ' + shellq(m.find) : ''}${D(m)}`,
  click: (m) => `click ${shellq(m.urlMatch)} ${shellq(m.target)}${m.dbl ? ' --dbl' : ''}${m.trusted ? ' --trusted' : ''}${D(m)}`,
  drag: (m) => `drag ${shellq(m.urlMatch)} ${shellq(m.from)} ${shellq(m.to)}${m.trusted ? ' --trusted' : ''}${D(m)}`,
  dialog: (m) => `dialog ${shellq(m.urlMatch)} ${m.accept ? 'accept' : 'dismiss'}${m.text ? ' --text ' + shellq(m.text) : ''}`,
  // fill/type: flags first, then the '--' separator, then the value — a value
  // starting with '--' (dev.to front-matter) would otherwise die on the
  // fill parser's stray-flag scan at replay. The VALUE ITSELF IS REDACTED:
  // the ring feeds `history` output and `--batch` exports, and typed values
  // can be secrets (server.log's display line never had them — the ring
  // shouldn't either). pushAct emits these as `# secret ·` comments so a
  // replay skips the step instead of typing literal stars.
  fill: (m) => `fill ${shellq(m.urlMatch)} ${shellq(m.target)}${D(m)} -- "***"`,
  type: (m) => `type ${shellq(m.urlMatch)} ${shellq(m.target)}${m.trusted ? ' --trusted' : ''}${D(m)} -- "***"`,
  // paste: a clipboard read (clip) is re-read at replay time, not embedded —
  // the exported script shouldn't freeze (or leak) what the clipboard held.
  // The explicit-value branch is redacted like fill/type.
  paste: (m) =>
    m.clip
      ? `paste ${shellq(m.urlMatch)}${m.target ? ' ' + shellq(m.target) : ''}${D(m)}`
      : `paste ${shellq(m.urlMatch)}${m.target ? ' ' + shellq(m.target) : ''}${D(m)} -- "***"`,
  press: (m) => `press ${shellq(m.urlMatch)} ${shellq(m.key)}${m.target ? ' ' + shellq(m.target) : ''}${m.trusted ? ' --trusted' : ''}${D(m)}`,
  hover: (m) => `hover ${shellq(m.urlMatch)} ${shellq(m.target)}${m.trusted ? ' --trusted' : ''}${D(m)}`,
  scroll: (m) => `scroll ${shellq(m.urlMatch)} ${shellq(m.target)}${D(m)}`,
  upload: (m) => `upload ${shellq(m.urlMatch)} ${shellq(m.target)} ${(m.files || []).map(shellq).join(' ')}${D(m)}`,
  fetch: (m) => `fetch ${shellq(m.urlMatch)} ${shellq(m.url)}`,
  ask: (m) => `ask ${shellq(m.urlMatch)} ${shellq(m.question)}`,
  wait: (m) =>
    `wait ${shellq(m.urlMatch)}${m.selector ? ' ' + shellq(m.selector) : ''}${m.text ? ' --text ' + shellq(m.text) : ''}${
      m.human ? ' --human' : ''
    }${m.pixel ? ' --pixel-change' : ''}${m.timeout != null && m.timeout !== 10000 && !m.human ? ' --timeout ' + m.timeout : ''}`,
  // Multiline code can't be one batch line — null drops it to a comment.
  eval: (m) =>
    m.code.includes('\n')
      ? null
      : `eval ${shellq(m.urlMatch)} ${shellq(m.code)}${m.world && m.world !== 'auto' ? ' --world ' + m.world.toLowerCase() : ''}`,
  // The output path is CLI-side and never rides the msg — placeholder name.
  shot: (m) =>
    `shot ${shellq(m.urlMatch)} shot-replay.png${m.full ? ' --full' : ''}${m.crop ? ' --crop ' + m.crop.join(',') : ''}` +
    `${m.max != null ? ' --max ' + m.max : ''}${m.scale != null ? ' --scale ' + m.scale : ''}` +
    `${m.format ? ' --format ' + m.format : ''}${m.quality != null ? ' --quality ' + m.quality : ''}${m.diff ? ' --diff' : ''}`,
  net: (m) =>
    `net ${shellq(m.urlMatch)}${m.duration != null ? ' --dur ' + m.duration : ''}${m.filter ? ' --filter ' + shellq(m.filter) : ''}${
      m.body ? ' --body ' + shellq(m.body) : ''
    }${m.ws ? ' --ws' : ''}${m.har ? ' --har net-replay.har' : ''}`,
  measure: (m) => `measure ${shellq(m.urlMatch)} ${shellq(m.selector)}`,
  console: (m) => `console ${shellq(m.urlMatch)}${m.clear ? ' --clear' : ''}${m.ask ? (m.ask === true ? ' --ask' : ' --ask ' + shellq(m.ask)) : ''}`,
  grid: (m) => `grid ${shellq(m.urlMatch)}`,
  note: (m) => `note ${shellq(m.urlMatch)} ${shellq(m.text)}`,
  emulate: (m) => (m.focus ? `emulate ${shellq(m.urlMatch)} focus` : `emulate ${shellq(m.urlMatch)} ${m.width} ${m.height}${m.mobile ? ' mobile' : ''}`),
  resize: (m) => `resize ${shellq(m.urlMatch)} ${m.width} ${m.height}`,
};
// `watch` keys its `since` cursor on actSeq, which resets on restart — the
// boot id lets it detect the reset instead of silently filtering out every
// line until seq climbs back past the old high-water mark.
const bootId = Date.now();
function summarize(msg) {
  const s = [msg.type];
  if (msg.urlMatch) s.push(msg.urlMatch);
  if (msg.profile) s.push('@' + seatTag(msg.profile)); // multi-profile: who acted
  // value stays out on purpose: fill values can be secrets, and this line is
  // persisted to server.log. Same for a dialog's --text answer (a prompt
  // answer can be a code or a password); note/wait text stays — the note's
  // text is its whole purpose, and wait --text is a page-text expectation.
  const extra =
    msg.target || msg.url || msg.key || msg.selector || msg.find || (msg.type === 'dialog' ? '' : msg.text) || msg.question ||
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
  // The replayable form rides the ring (see CLI_LINES above); a failed command
  // is commented out so a replayed script proceeds past it instead of dying.
  // Secret-shaped commands (fill/type/paste values) are redacted in CLI_LINES
  // AND commented out here — a replay must skip the step, not type "***".
  const replay = CLI_LINES[msg.type]?.(msg);
  const prof = msg.profile ? `--profile ${seatTag(msg.profile)} ` : '';
  const secret = msg && (msg.type === 'fill' || msg.type === 'type' || (msg.type === 'paste' && !msg.clip));
  const cmd = replay == null ? null : !out.ok ? `# failed · ${prof}${replay}` : secret ? `# secret · ${prof}${replay}` : prof + replay;
  activity.push({ seq: ++actSeq, line, cmd });
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
      // Logging must never kill the relay: a malformed field ({"type":"shot",
      // "crop":"z"}) reached CLI_LINES's m.crop.join and the throw — inside an
      // async 'end' handler — took the whole server down as an unhandled
      // rejection (found by the parallel stress suite; one curl repro).
      try {
        pushAct(msg, out, Date.now() - t0);
      } catch (e) {
        console.log('[act] logging failed for ' + (msg?.type || '?') + ': ' + String(e).slice(0, 80));
      }
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
  // lets its 30s keepalive alarm re-probe) instead of evicting the live socket.
  const existing = seats.get(id);
  if (existing && existing.socket && !existing.socket.destroyed) {
    console.log(`[bridge] seat taken — rejected v=${v || '?'} id=${id} (duplicate; holder is alive)`);
    socket.end(encodeFrame(JSON.stringify({ type: 'seat-taken' }))); // end() flushes before FIN — write()+destroy() can lose the bounce frame
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
      // Unsolicited event frames (no pending id): the human clicked the pill's
      // ⏏. The feed must show it — otherwise the agent's next command silently
      // re-marks the tab and from the human's seat "nobody noticed".
      if (msg?.type === 'event' && msg.kind === 'self-release') {
        const line = (
          new Date().toTimeString().slice(0, 8) +
          ` ⏏ human released a tab via the pill${msg.url ? ' (' + String(msg.url).slice(0, 60) + ')' : ''} @${seatTag(this.pid)}`
        ).replace(/[\x00-\x1f\x7f\x9b]/g, ' '); // same ANSI/newline strip as pushAct — the URL is page-influenced
        activity.push({ seq: ++actSeq, line, cmd: null });
        if (activity.length > 300) activity.shift();
        console.log('[act] ' + line);
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
      console.log(`[bridge] extension disconnected id=${id}`);
    }
    // Unconditional, NOT inside the guard: this pending map is THIS socket's
    // own, so draining it can never touch a replacement seat's commands. The
    // hazardous order — heartbeat destroy() in a timer phase sets destroyed
    // synchronously, a reconnect's upgrade lands in the same iteration's poll
    // phase and takes the seat, and only then does the close-phase onGone run
    // — used to skip this drain and hang the old seat's commands to the 70s
    // timeout (instrumented repro, stress review).
    dropSeatPending(seat, 'extension disconnected mid-command — it reconnects on its own; the command may have run before the reply was lost, so check the tab before retrying');
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
// commands rot to the 70s timeout) — no pong means the seat is deaf, free it.
// The pong budget is 10s, not a hair trigger: a BUSY sw (a full-page --diff's
// synchronous pixel compare blocks its event loop for seconds) must not read
// as dead — destroying that seat errors every in-flight command for nothing.
// The ping traffic also wakes/extends the MV3 service worker, so this doubles
// as the keepalive.
setInterval(() => {
  for (const seat of seats.values()) {
    if (!seat.socket || seat.socket.destroyed) continue;
    const t = setTimeout(() => {
      if (seat.pending.delete(seat.pingId)) seat.socket.destroy();
    }, 10_000);
    seat.pingId = seat.nextId++;
    seat.pending.set(seat.pingId, () => clearTimeout(t));
    seat.socket.write(encodeFrame(JSON.stringify({ type: 'ping', id: seat.pingId })));
  }
}, 20_000);
