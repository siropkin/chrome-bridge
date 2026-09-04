#!/usr/bin/env node
// chrome-bridge server — zero dependencies, Node >= 18.
// One port, two faces:
//   ws://127.0.0.1:9333/ws   — the Chrome extension connects here
//   POST 127.0.0.1:9333/cmd  — the CLI (or any agent) sends commands here
//   GET  127.0.0.1:9333/health
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.BRIDGE_PORT || 9333);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CMD_TIMEOUT_MS = 70_000; // `wait` supports up to 60s

let extSocket = null;
let nextId = 1;
const pending = new Map();

// --- activity feed (`cli.mjs watch`) ----------------------------------------
// One line per relayed command: what ran, where, ok or the error, how long.
// Ring of 300; `since` in GET /log picks up only the new lines.
const activity = [];
let actSeq = 0;
function summarize(msg) {
  const s = [msg.type];
  if (msg.urlMatch) s.push(msg.urlMatch);
  const extra = msg.target || msg.url || msg.key || msg.label || msg.text || msg.question || '';
  if (extra) s.push(String(extra).slice(0, 40));
  return s.join(' ');
}
function pushAct(msg, out, ms) {
  if (!msg?.type) return; // unparseable body — sendToExt already returned its error
  const line =
    new Date().toTimeString().slice(0, 8) +
    ' ' +
    summarize(msg) +
    (out.ok ? ` · ok ${(ms / 1000).toFixed(1)}s` : ` · ✗ ${String(out.error).slice(0, 80)}`);
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

function handleWsData(socket, chunk, state) {
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
      socket.end();
      return;
    }
    if (op === 0x9) {
      socket.write(encodeFrame(payload, 0xa));
      continue;
    }
    if (op === 0xa) continue;
    state.fragments.push(payload);
    if (fin) {
      const msg = Buffer.concat(state.fragments).toString();
      state.fragments = [];
      onExtMessage(msg);
    }
  }
}

function onExtMessage(data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  const resolve = pending.get(msg.id);
  if (resolve) {
    pending.delete(msg.id);
    resolve(msg);
  }
}

function dropPending(error) {
  for (const resolve of pending.values()) resolve({ ok: false, error });
  pending.clear();
}

function sendToExt(msg) {
  return new Promise((resolve, reject) => {
    // The MV3 service worker cycles; wait briefly for a reconnect before failing.
    const attempt = (triesLeft) => {
      if (extSocket && !extSocket.destroyed) {
        const id = nextId++;
        pending.set(id, resolve);
        extSocket.write(encodeFrame(JSON.stringify({ ...msg, id })));
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error('extension timeout'));
        }, CMD_TIMEOUT_MS);
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

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, extension: !!(extSocket && !extSocket.destroyed) }));
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
        out = await sendToExt(msg);
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
    // cross-origin (no CORS headers), so no drive-by guard is needed.
    const since = Number(new URL(req.url, 'http://x').searchParams.get('since') || 0);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(activity.filter((a) => a.seq > since)));
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
  // (no Origin header) may take the WS seat — never a web page.
  const origin = req.headers.origin;
  if (!key || (origin && !origin.startsWith('chrome-extension://'))) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  // First healthy connection holds the seat. A newcomer only takes it when
  // the current socket is already dead (SW restart closes the old socket,
  // freeing the seat) — a client stuck in a reconnect loop must not evict a
  // working connection.
  if (extSocket && !extSocket.destroyed) {
    socket.destroy();
    return;
  }
  extSocket = socket;
  console.log('[bridge] extension connected origin=' + (origin || 'none'));
  const state = { buf: Buffer.alloc(0), fragments: [] };
  socket.on('data', (chunk) => handleWsData(socket, chunk, state));
  const onGone = () => {
    if (extSocket === socket) {
      extSocket = null;
      dropPending('extension disconnected');
      console.log('[bridge] extension disconnected');
    }
    socket.destroy();
  };
  // 'end' fires on a half-open socket (peer FIN) — 'close' may never follow.
  socket.on('end', onGone);
  socket.on('close', onGone);
  socket.on('error', onGone);
});

server.listen(PORT, '127.0.0.1', () => console.log(`[bridge] ws + control on 127.0.0.1:${PORT}`));

// Heartbeat: app-level ping every 20s. A socket can be open at TCP level with
// a dead service worker behind it (health says "connected" while commands rot
// to the 70s timeout) — no pong in 5s means the seat is deaf, free it. The
// ping traffic also wakes/extends the MV3 service worker, so this doubles as
// the keepalive.
setInterval(() => {
  if (!extSocket || extSocket.destroyed) return;
  const sock = extSocket;
  const id = nextId++;
  const t = setTimeout(() => {
    if (pending.delete(id)) sock.destroy();
  }, 5000);
  pending.set(id, () => clearTimeout(t));
  sock.write(encodeFrame(JSON.stringify({ type: 'ping', id })));
}, 20_000);
