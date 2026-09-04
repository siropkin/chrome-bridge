// Self-test: starts the server on a test port, connects a fake extension over
// WebSocket, and exercises the CLI end-to-end. Run: node test/selftest.mjs
import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';

const PORT = 9871;
const ROOT = new URL('..', import.meta.url).pathname;
const env = { ...process.env, BRIDGE_PORT: String(PORT) };

let passed = 0;
let server;
function assert(cond, name, detail) {
  if (!cond) {
    console.error(`FAIL ${name}${detail ? `\n${detail}` : ''}`);
    server?.kill();
    process.exit(1);
  }
  passed++;
  console.log(`ok   ${name}`);
}

// --- tiny WS client (client frames must be masked) ---------------------------
function wsClient(port) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(port, '127.0.0.1');
    let handshaken = false;
    let buf = Buffer.alloc(0);
    const handlers = [];
    const send = (obj) => {
      const payload = Buffer.from(JSON.stringify(obj));
      const mask = crypto.randomBytes(4);
      let head;
      if (payload.length < 126) {
        head = Buffer.from([0x81, 0x80 | payload.length]);
      } else if (payload.length < 65536) {
        head = Buffer.alloc(4);
        head[0] = 0x81;
        head[1] = 0x80 | 126;
        head.writeUInt16BE(payload.length, 2);
      } else {
        head = Buffer.alloc(10);
        head[0] = 0x81;
        head[1] = 0x80 | 127;
        head.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
      socket.write(Buffer.concat([head, mask, masked]));
    };
    socket.on('connect', () => {
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaken) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        if (!buf.subarray(0, idx).toString().includes('101')) return reject(new Error('handshake failed'));
        handshaken = true;
        buf = buf.subarray(idx + 4);
        resolve({ send, onMessage: (fn) => handlers.push(fn), socket });
      }
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
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
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len).toString();
        buf = buf.subarray(off + len);
        if (op === 0x1) for (const fn of handlers) fn(JSON.parse(payload));
      }
    });
    socket.on('error', reject);
  });
}

// NOTE: must be async — a spawnSync here would freeze this process's event
// loop, and the fake extension (same process) could never answer.
function cli(...args) {
  return new Promise((resolve) => {
    const p = spawn('node', [`${ROOT}/cli.mjs`, ...args], { env });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => (stderr += c));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// --- run ---------------------------------------------------------------------
server = spawn('node', [`${ROOT}/server.mjs`], { env, stdio: 'pipe' });
await new Promise((r) => server.stdout.once('data', r));

try {
  // health before extension connects
  let h = await cli('health');
  assert(h.status === 0 && JSON.parse(h.stdout).extension === false, 'health: extension false before connect');

  // connect fake extension
  const ext = await wsClient(PORT);
  let lastShot = null;
  ext.onMessage((msg) => {
    const respond = (result) => ext.send({ id: msg.id, ok: true, result });
    if (msg.type === 'ping') return respond('pong');
    if (msg.type === 'tabs')
      return respond([{ id: 1, url: 'https://example.com/', title: 'Example', active: true, driven: false }]);
    if (msg.type === 'eval') return respond({ echo: msg.code.length, world: msg.world, match: msg.urlMatch, label: msg.label || null });
    if (msg.type === 'big') return respond('x'.repeat(3 * 1024 * 1024)); // 3 MB — exercises 64-bit frames
    if (msg.type === 'shot') { lastShot = msg; return respond('data:image/png;base64,' + Buffer.from('fakepng').toString('base64')); }
    if (['snap', 'press', 'type', 'hover', 'net', 'click', 'fill', 'navigate', 'scroll', 'ask', 'upload', 'console', 'note'].includes(msg.type)) return respond(msg); // echo for flag-parsing checks
    return respond(null);
  });
  await new Promise((r) => setTimeout(r, 100));

  h = await cli('health');
  assert(JSON.parse(h.stdout).extension === true, 'health: extension true after connect');

  const tabs = await cli('tabs');
  assert(tabs.status === 0 && tabs.stdout.includes('example.com'), 'cli tabs', `status=${tabs.status}\nstdout=${tabs.stdout}\nstderr=${tabs.stderr}`);

  const ev = await cli('eval', 'example.com', 'document.title');
  assert(ev.status === 0 && ev.stdout.includes('"echo"'), 'cli eval round-trip');

  const shotPath = '/tmp/chrome-bridge-selftest.png';
  const shot = await cli('shot', 'example.com', shotPath);
  assert(shot.status === 0 && fs.readFileSync(shotPath).toString() === 'fakepng', 'cli shot writes file');

  // --full is boolean: it must not swallow the next flag's value
  const shotFull = await cli('shot', 'example.com', shotPath, '--full', '--scale', '2');
  assert(shotFull.status === 0 && fs.readFileSync(shotPath).toString() === 'fakepng', 'cli shot --full parses as boolean flag', shotFull.stderr);
  fs.unlinkSync(shotPath);

  const snap = await cli('snap', 'example.com', '#app', '--diff', '--href');
  assert(snap.status === 0 && snap.stdout.includes('"diff":true') && snap.stdout.includes('"scope":"#app"') && snap.stdout.includes('"href":true'), 'cli snap scope+diff+href flags', snap.stdout + snap.stderr);

  // --find: query rides along; scope detection doesn't swallow it as a scope
  const snapFind = await cli('snap', 'example.com', '--find', 'the save button');
  assert(snapFind.status === 0 && snapFind.stdout.includes('"find":"the save button"') && snapFind.stdout.includes('"scope":null'), 'cli snap --find passes query, scope stays null', snapFind.stdout + snapFind.stderr);
  const snapFindScope = await cli('snap', 'example.com', '#app', '--find', 'the cancel button');
  assert(snapFindScope.status === 0 && snapFindScope.stdout.includes('"find":"the cancel button"') && snapFindScope.stdout.includes('"scope":"#app"'), 'cli snap --find with scope', snapFindScope.stdout + snapFindScope.stderr);
  const snapFindBare = await cli('snap', 'example.com', '--find');
  assert(snapFindBare.status !== 0 && snapFindBare.stderr.includes('--find needs a query'), 'cli snap --find without query fails', snapFindBare.stdout + snapFindBare.stderr);

  const shotMax = await cli('shot', 'example.com', shotPath, '--max', '800');
  assert(shotMax.status === 0 && lastShot?.max === 800, 'cli shot --max parses and reaches the extension', shotMax.stderr + JSON.stringify(lastShot));
  fs.unlinkSync(shotPath);

  const shotBad = await cli('shot', 'example.com', shotPath, '--max', '--full');
  assert(shotBad.status !== 0 && shotBad.stderr.includes('--max needs a value'), 'cli shot rejects flag-as-value', shotBad.stdout + shotBad.stderr);

  const press = await cli('press', 'example.com', 'Enter', '@e3');
  assert(press.status === 0 && press.stdout.includes('"key":"Enter"') && press.stdout.includes('"target":"@e3"'), 'cli press passes key+target', press.stdout + press.stderr);

  const typ = await cli('type', 'example.com', '@e2', 'hello', 'world');
  assert(typ.status === 0 && typ.stdout.includes('"value":"hello world"'), 'cli type joins text args', typ.stdout + typ.stderr);

  const hov = await cli('hover', 'example.com', '@e1');
  assert(hov.status === 0 && hov.stdout.includes('"target":"@e1"'), 'cli hover passes target', hov.stdout + hov.stderr);

  const netc = await cli('net', 'example.com', '--dur', '500', '--filter', '/api');
  assert(netc.status === 0 && netc.stdout.includes('"duration":500') && netc.stdout.includes('"filter":"/api"'), 'cli net flags', netc.stdout + netc.stderr);

  // --diff on actions: flag reaches the extension; plain actions don't send it
  const clickDiff = await cli('click', 'example.com', '@e3', '--diff');
  assert(clickDiff.status === 0 && clickDiff.stdout.includes('"target":"@e3"') && clickDiff.stdout.includes('"diff":true'), 'cli click --diff', clickDiff.stdout + clickDiff.stderr);
  const clickPlain = await cli('click', 'example.com', '@e3');
  assert(clickPlain.status === 0 && !clickPlain.stdout.includes('"diff"'), 'cli click without --diff sends no diff', clickPlain.stdout + clickPlain.stderr);
  const fillDiff = await cli('fill', 'example.com', '@e2', 'hello world', '--diff');
  assert(fillDiff.status === 0 && fillDiff.stdout.includes('"value":"hello world"') && fillDiff.stdout.includes('"diff":true'), 'cli fill --diff keeps value', fillDiff.stdout + fillDiff.stderr);
  const navDiff = await cli('nav', 'example.com', 'https://example.org/x', '--diff');
  assert(navDiff.status === 0 && navDiff.stdout.includes('"url":"https://example.org/x"') && navDiff.stdout.includes('"diff":true'), 'cli nav --diff', navDiff.stdout + navDiff.stderr);

  const scrollDiff = await cli('scroll', 'example.com', 'down', '--diff');
  assert(scrollDiff.status === 0 && scrollDiff.stdout.includes('"target":"down"') && scrollDiff.stdout.includes('"diff":true'), 'cli scroll --diff', scrollDiff.stdout + scrollDiff.stderr);
  const scrollPlain = await cli('scroll', 'example.com', '@e3');
  assert(scrollPlain.status === 0 && scrollPlain.stdout.includes('"target":"@e3"') && !scrollPlain.stdout.includes('"diff"'), 'cli scroll plain sends no diff', scrollPlain.stdout + scrollPlain.stderr);

  const ask = await cli('ask', 'example.com', 'what', 'is', 'this page about?');
  assert(ask.status === 0 && ask.stdout.includes('"question":"what is this page about?"'), 'cli ask joins question args', ask.stdout + ask.stderr);

  const up = await cli('upload', 'example.com', '@e5', `${ROOT}package.json`, `${ROOT}README.md`, '--diff');
  assert(up.status === 0 && up.stdout.includes('"files":["') && up.stdout.includes(`${ROOT}package.json`) && up.stdout.includes('"diff":true'), 'cli upload resolves absolute paths + --diff', up.stdout + up.stderr);
  const upMissing = await cli('upload', 'example.com', '@e5', '/nope/missing-file.txt');
  assert(upMissing.status !== 0 && upMissing.stderr.includes('file not found'), 'cli upload rejects missing file before round trip', upMissing.stdout + upMissing.stderr);
  const upNoArgs = await cli('upload', 'example.com');
  assert(upNoArgs.status !== 0 && upNoArgs.stderr.includes('usage: upload'), 'cli upload usage error', upNoArgs.stdout + upNoArgs.stderr);

  const conAsk = await cli('console', 'example.com', '--ask', 'what', 'broke?');
  assert(conAsk.status === 0 && conAsk.stdout.includes('"ask":"what broke?"'), 'cli console --ask joins question', conAsk.stdout + conAsk.stderr);
  const conAskBare = await cli('console', 'example.com', '--ask');
  assert(conAskBare.status === 0 && conAskBare.stdout.includes('"ask":true'), 'cli console bare --ask sends true', conAskBare.stdout + conAskBare.stderr);
  const conPlain = await cli('console', 'example.com');
  assert(conPlain.status === 0 && !conPlain.stdout.includes('"ask"'), 'cli console plain sends no ask', conPlain.stdout + conPlain.stderr);

  const evWorld = await cli('eval', '--world', 'main', 'example.com', 'document.title');
  assert(evWorld.status === 0 && evWorld.stdout.includes('"world":"MAIN"') && evWorld.stdout.includes('"match":"example.com"'), 'cli eval --world before match parses', evWorld.stdout + evWorld.stderr);

  const evWorldBad = await cli('eval', 'example.com', 'document.title', '--world', 'mian');
  assert(evWorldBad.status !== 0 && evWorldBad.stderr.includes('--world'), 'cli eval rejects invalid --world value', evWorldBad.stdout + evWorldBad.stderr);

  // large frame extension→server (3 MB result)
  const bigRes = await fetch(`http://127.0.0.1:${PORT}/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'big' }),
  });
  const big = await bigRes.json();
  assert(big.ok && big.result.length === 3 * 1024 * 1024, 'server: 3MB frame round-trip');

  const nt = await cli('note', 'example.com', 'saving', 'the', 'draft');
  assert(nt.status === 0 && nt.stdout.includes('"text":"saving the draft"'), 'cli note joins text args', nt.stdout + nt.stderr);
  const ntNoArgs = await cli('note', 'example.com');
  assert(ntNoArgs.status !== 0 && ntNoArgs.stderr.includes('usage: note'), 'cli note usage error', ntNoArgs.stdout + ntNoArgs.stderr);

  // measure/grid are eval sugar — they must still carry their own pill label
  const meas = await cli('measure', 'example.com', '.btn');
  assert(meas.status === 0 && meas.stdout.includes('"label":"measuring layout"'), 'cli measure carries its pill label', meas.stdout + meas.stderr);
  const gr = await cli('grid', 'example.com');
  assert(gr.status === 0 && gr.stdout.includes('"label":"toggling alignment grid"'), 'cli grid carries its pill label', gr.stdout + gr.stderr);

  // Stress-fix tripwires: selftest drives a FAKE extension, so the service
  // worker's own guards can't be executed here — assert them at source level.
  {
    const bg = fs.readFileSync(`${ROOT}extension/background.js`, 'utf8');
    // CDP debugger refcount: every attach/detach must route through the two
    // helpers. A raw chrome.debugger.attach/detach elsewhere races under
    // concurrent commands on one tab (stress-measured: 13% failures, 70s
    // lost-callback hangs, debugger sessions leaked onto later commands).
    assert(bg.split('chrome.debugger.attach(').length === 2, 'ext: one debugger-attach site (the refcount helper)');
    assert(bg.split('chrome.debugger.detach(').length === 2, 'ext: one debugger-detach site (the refcount helper)');
    assert(bg.split('await attachDbg(').length >= 5 && bg.split('await detachDbg(').length >= 5, 'ext: all 5 CDP call sites refcounted');
    // CDP commands serialize per tab — an unemulate racing a sibling's
    // sendCommand tore the shared session mid-flight (5.5% of interleaved
    // CDP commands in stress).
    assert(bg.split('withCdp(').length === 7, 'ext: CDP handlers serialize per tab (helper + 5 wrap sites)');
    // open must not await the favicon/banner marking — executeScript sits
    // pending forever on an uncommitted navigation (unreachable URL), which
    // hung open past its 8s cap to the server's 70s timeout. The response
    // also needs the requested URL: a still-pending tab has url "" and could
    // never be matched.
    assert(bg.includes('url: url || msg.url') && /markTab\(tab\.id\)\.catch/.test(bg), 'ext: open fire-and-forgets marking, url falls back to the request');
    // External debugger detach must reset the refcount (infobar cancel,
    // DevTools opened) — else a stale count wedges the session until close.
    assert(bg.includes('chrome.debugger.onDetach.addListener'), 'ext: onDetach resets the CDP refcount');
  }

  // activity feed (watch): every relayed command lands in /log; since= yields a delta
  const logAll = await fetch(`http://127.0.0.1:${PORT}/log`).then((r) => r.json());
  assert(
    logAll.some((a) => a.line.includes('eval example.com') && a.line.includes('· ok')) &&
      logAll.some((a) => a.line.includes('note example.com saving the draft')),
    'server /log records commands',
    JSON.stringify(logAll.slice(-3))
  );
  const logDelta = await fetch(`http://127.0.0.1:${PORT}/log?since=${logAll[logAll.length - 1].seq - 1}`).then((r) => r.json());
  assert(logDelta.length === 1, 'server /log since= delta filtering', JSON.stringify(logDelta));

  // unknown command surfaces the extension's error
  const bad = await (await fetch(`http://127.0.0.1:${PORT}/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'nope' }),
  })).json();
  assert(bad.ok === false || bad.result === null, 'server: unknown type handled');

  // drive-by protection: browser-origin requests are refused
  const evil = await fetch(`http://127.0.0.1:${PORT}/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ type: 'ping' }),
  });
  assert(evil.status === 403, 'server: POST /cmd with browser Origin → 403');

  const evilWs = await new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    let buf = '';
    s.on('data', (c) => (buf += c));
    s.on('connect', () =>
      s.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nOrigin: https://evil.example\r\n\r\n`
      )
    );
    s.on('close', () => resolve(true));
    s.on('error', () => resolve(true));
    setTimeout(() => { s.destroy(); resolve(false); }, 1000);
  });
  assert(evilWs, 'server: WS upgrade with browser Origin rejected');

  // extension disconnect → health flips
  ext.socket.destroy();
  await new Promise((r) => setTimeout(r, 500));
  h = await cli('health');
  assert(JSON.parse(h.stdout).extension === false, 'health: extension false after disconnect', h.stdout + h.stderr);

  // stop → health fails → start (detached) → health recovers. Runs last: it
  // kills the test server for real, and `start` spawns a detached replacement
  // that the final stop cleans up.
  const stop1 = await cli('stop');
  assert(stop1.status === 0 && stop1.stdout.includes('stopped'), 'cli stop', stop1.stdout + stop1.stderr);
  await new Promise((r) => setTimeout(r, 300));
  const hDown = await cli('health');
  assert(hDown.status !== 0 && hDown.stderr.includes('not running'), 'health fails after stop', hDown.stdout + hDown.stderr);
  const start = await cli('start');
  assert(start.status === 0 && start.stdout.includes('started'), 'cli start brings the server up', start.stdout + start.stderr);
  const hUp = await cli('health');
  assert(hUp.status === 0 && JSON.parse(hUp.stdout).ok === true, 'health ok after start', hUp.stdout + hUp.stderr);
  await cli('stop'); // leave no detached server behind

  console.log(`\n${passed} checks passed`);
} finally {
  server.kill();
}
process.exit(0);
