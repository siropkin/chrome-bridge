// Self-test: starts the server on a test port, connects a fake extension over
// WebSocket, and exercises the CLI end-to-end. Run: node test/selftest.mjs
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

const PORT = 9871;
const ROOT = new URL('..', import.meta.url).pathname;
const env = { ...process.env, BRIDGE_PORT: String(PORT) };
// The fake extension's handshake version mirrors the repo manifest — cli
// health compares the two, and a hardcode here would trip its warning.
const MANIFEST_V = JSON.parse(fs.readFileSync(`${ROOT}extension/manifest.json`, 'utf8')).version;
const PKG_V = JSON.parse(fs.readFileSync(`${ROOT}package.json`, 'utf8')).version;

let passed = 0;
let server;
function assert(cond, name, detail) {
  if (!cond) {
    console.error(`FAIL ${name}${detail ? `\n${detail}` : ''}`);
    server?.kill();
    // A failure after the `start` test leaves a DETACHED server holding the
    // port — the next run would hang on EADDRINUSE. Stop it synchronously:
    // a pending fetch dies with process.exit, spawnSync does not.
    try {
      spawnSync('node', [`${ROOT}/cli.mjs`, 'stop'], { env });
    } catch {}
    process.exit(1);
  }
  passed++;
  console.log(`ok   ${name}`);
}

// --- tiny WS client (client frames must be masked) ---------------------------
function wsClient(port, id = 'alpha-test', name) {
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
      // ?v=/?id= mirror the real extension's handshake (cli health compares
      // versions against the repo manifest; --profile prefix-matches the id).
      socket.write(
        `GET /ws?v=${MANIFEST_V}&id=${id}${name ? `&name=${name}` : ''} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
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
function cliRaw(args, input, extraEnv = {}) {
  return new Promise((resolve) => {
    const p = spawn('node', [`${ROOT}/cli.mjs`, ...args], { env: { ...env, ...extraEnv } });
    if (input != null) {
      p.stdin.write(input);
      p.stdin.end();
    }
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => (stderr += c));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
function cli(...args) {
  return cliRaw(args, null);
}
function cliStdin(input, ...args) {
  return cliRaw(args, input);
}

// --- run ---------------------------------------------------------------------
server = spawn('node', [`${ROOT}/server.mjs`], { env, stdio: 'pipe' });
let serverErr = '';
server.stderr.on('data', (c) => (serverErr += c));
// Boot race: EADDRINUSE goes to stderr and stdout never fires — without the
// timer the suite hangs forever (a CI runner burns until its job timeout).
await Promise.race([
  new Promise((r) => server.stdout.once('data', r)),
  new Promise((_, rej) => setTimeout(() => rej(new Error('server did not boot; stderr: ' + serverErr)), 5000)),
]);

try {
  // The version lives in TWO files (package.json, extension/manifest.json) and
  // nothing but this check compares them — the v1.6.0 eager-clear bug shipped
  // precisely because same-version drift was invisible everywhere else.
  assert(PKG_V === MANIFEST_V, 'drift: package.json version matches extension/manifest.json', `package.json ${PKG_V} vs manifest ${MANIFEST_V}`);

  // health before extension connects
  let h = await cli('health');
  assert(h.status === 0 && JSON.parse(h.stdout).extension === false, 'health: extension false before connect');

  // connect fake extension
  const ext = await wsClient(PORT, 'alpha-test');
  let lastShot = null;
  // A real 1x1 PNG — imgDims parses the IHDR header to print dimensions, so
  // the suite exercises the parse for real (a fake payload never did).
  const PNG1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'base64'
  );
  ext.onMessage((msg) => {
    const respond = (result) => ext.send({ id: msg.id, ok: true, result });
    if (msg.type === 'ping') return respond('pong');
    if (msg.type === 'tabs')
      return respond([{ id: 1, url: 'https://example.com/', title: 'Example', active: true, driven: false }]);
    if (msg.type === 'probe')
      return respond(
        [{ id: 1, url: 'https://example.com/', lastAccessed: 1 }, { id: 2, url: 'https://dupe.example/a', lastAccessed: 2 }].filter((t) =>
          t.url.includes(msg.urlMatch)
        )
      );
    if (msg.type === 'eval') return respond({ echo: msg.code.length, world: msg.world, match: msg.urlMatch, label: msg.label || null });
    if (msg.type === 'big') return respond('x'.repeat(3 * 1024 * 1024)); // 3 MB — exercises 64-bit frames
    if (msg.type === 'shot') { lastShot = msg; return respond('data:image/png;base64,' + PNG1x1.toString('base64')); }
    if (msg.type === 'ansierr') return ext.send({ id: msg.id, ok: false, error: 'bad \x1b[31mRED\x1b[0m\nforged line' });
    // fetch answers with the result shape the CLI processes (status/ct/body),
    // binary when asked — the --out decode and the binary-requires---out
    // guard both run CLI-side.
    if (msg.type === 'fetch') {
      if (msg.url.includes('binary.example'))
        return respond({ status: 200, ct: 'application/pdf', binary: true, body: Buffer.from('PDFBYTES').toString('base64'), truncated: false });
      return respond({ status: 200, ct: 'application/json', binary: false, body: '{"a":1}', truncated: false });
    }
    // net --har answers with the {lines, har} shape the CLI writes to the file.
    if (msg.type === 'net' && msg.har)
      return respond({
        lines: 'GET 200 /x ⟵ a.js:1',
        har: { log: { version: '1.2', creator: { name: 'chrome-bridge', version: '9' }, entries: [{ startedDateTime: '2026-09-07T00:00:00.000Z', request: { method: 'GET', url: 'https://x/' } }] } },
      });
    // snap with scope 'trunc' answers a STRING (the real one does when the
    // tree truncates) — cli must echo the truncation line to stderr (it dies
    // in a `snap | grep` pipe otherwise) while stdout carries the tree.
    if (msg.type === 'snap' && msg.scope === 'trunc')
      return respond('tree line A\ntree line B\n… truncated at 300 nodes — scope with: snap <match> <css>');
    if (['snap', 'press', 'type', 'hover', 'net', 'click', 'fill', 'paste', 'navigate', 'scroll', 'ask', 'upload', 'console', 'note', 'measure', 'grid', 'open', 'close', 'mark', 'release', 'unemulate', 'wait', 'emulate', 'resize', 'dialog', 'drag'].includes(msg.type)) return respond(msg); // echo for flag-parsing checks
    return respond(null);
  });
  await new Promise((r) => setTimeout(r, 100));

  h = await cli('health');
  assert(JSON.parse(h.stdout).extension === true, 'health: extension true after connect');
  {
    const hv = JSON.parse(h.stdout);
    assert(hv.profiles?.length === 1 && hv.profiles[0].id === 'alpha-test' && hv.profiles[0].v === MANIFEST_V, 'health reports connected profiles + versions from the WS handshake', h.stdout);
  }

  // WS control frames must not kill the server: the close/ping handlers once
  // referenced a bare `socket` after a refactor — one frame crashed the process
  // and took every in-flight command with it.
  ext.socket.write(Buffer.from([0x89, 0x80, 0, 0, 0, 0])); // masked ping
  await new Promise((r) => setTimeout(r, 200));
  h = await cli('health');
  assert(JSON.parse(h.stdout).ok === true, 'server survives a WS ping frame', h.stdout + h.stderr);

  const tabs = await cli('tabs');
  assert(tabs.status === 0 && tabs.stdout.includes('example.com'), 'cli tabs', `status=${tabs.status}\nstdout=${tabs.stdout}\nstderr=${tabs.stderr}`);

  const ev = await cli('eval', 'example.com', 'document.title');
  assert(ev.status === 0 && ev.stdout.includes('"echo"'), 'cli eval round-trip');

  const shotPath = '/tmp/chrome-bridge-selftest.png';
  const shot = await cli('shot', 'example.com', shotPath);
  assert(shot.status === 0 && fs.readFileSync(shotPath).equals(PNG1x1) && shot.stdout.includes(', 1x1'), 'cli shot writes file + prints parsed dimensions', shot.stdout + shot.stderr);

  // --full is boolean: it must not swallow the next flag's value
  const shotFull = await cli('shot', 'example.com', shotPath, '--full', '--scale', '2');
  assert(shotFull.status === 0 && fs.readFileSync(shotPath).equals(PNG1x1), 'cli shot --full parses as boolean flag', shotFull.stderr);
  fs.unlinkSync(shotPath);

  const snap = await cli('snap', 'example.com', '#app', '--diff', '--href');
  assert(snap.status === 0 && snap.stdout.includes('"diff":true') && snap.stdout.includes('"scope":"#app"') && snap.stdout.includes('"href":true'), 'cli snap scope+diff+href flags', snap.stdout + snap.stderr);
  // --skeleton: depth-limited map; scope takes an @ref — the drill-down.
  const snapSkel = await cli('snap', 'example.com', '--skeleton');
  assert(snapSkel.status === 0 && snapSkel.stdout.includes('"skeleton":true') && snapSkel.stdout.includes('"scope":null'), 'cli snap --skeleton rides, scope stays null', snapSkel.stdout + snapSkel.stderr);
  const snapRef = await cli('snap', 'example.com', '@e12');
  assert(snapRef.status === 0 && snapRef.stdout.includes('"scope":"@e12"'), 'cli snap scope accepts an @ref (the skeleton drill-down)', snapRef.stdout + snapRef.stderr);

  // --find: query rides along; scope detection doesn't swallow it as a scope
  const snapFind = await cli('snap', 'example.com', '--find', 'the save button');
  assert(snapFind.status === 0 && snapFind.stdout.includes('"find":"the save button"') && snapFind.stdout.includes('"scope":null'), 'cli snap --find passes query, scope stays null', snapFind.stdout + snapFind.stderr);
  const snapFindScope = await cli('snap', 'example.com', '#app', '--find', 'the cancel button');
  assert(snapFindScope.status === 0 && snapFindScope.stdout.includes('"find":"the cancel button"') && snapFindScope.stdout.includes('"scope":"#app"'), 'cli snap --find with scope', snapFindScope.stdout + snapFindScope.stderr);
  const snapFindBare = await cli('snap', 'example.com', '--find');
  assert(snapFindBare.status !== 0 && snapFindBare.stderr.includes('--find needs a query'), 'cli snap --find without query fails', snapFindBare.stdout + snapFindBare.stderr);
  // --find is greedy: an unquoted multi-word query is the WHOLE query, not
  // find='cancel' + a bogus scope='button' returning the wrong tree silently.
  const snapFindGreedy = await cli('snap', 'example.com', '--find', 'cancel', 'button');
  assert(
    snapFindGreedy.status === 0 && snapFindGreedy.stdout.includes('"find":"cancel button"') && snapFindGreedy.stdout.includes('"scope":null'),
    'cli snap --find greedy multi-word query',
    snapFindGreedy.stdout + snapFindGreedy.stderr
  );

  // The truncation line rides stderr — a stdout copy dies in `snap | grep` and
  // the agent concludes "not found" when the truth is "not reached".
  const trunc = await cli('snap', 'example.com', 'trunc');
  assert(
    trunc.status === 0 && trunc.stdout.includes('tree line A') && trunc.stderr.includes('truncated at 300 nodes'),
    'cli snap echoes truncation warning to stderr',
    trunc.stdout + trunc.stderr
  );

  const shotMax = await cli('shot', 'example.com', shotPath, '--max', '800');
  assert(shotMax.status === 0 && lastShot?.max === 800, 'cli shot --max parses and reaches the extension', shotMax.stderr + JSON.stringify(lastShot));
  fs.unlinkSync(shotPath);

  const shotBad = await cli('shot', 'example.com', shotPath, '--max', '--full');
  assert(shotBad.status !== 0 && shotBad.stderr.includes('--max needs a value'), 'cli shot rejects flag-as-value', shotBad.stdout + shotBad.stderr);
  // Out-of-range values fail here — they used to pass validation and silently
  // degrade to a different screenshot on the CDP fallback path.
  const shotScale0 = await cli('shot', 'example.com', shotPath, '--scale', '-1');
  assert(shotScale0.status !== 0 && shotScale0.stderr.includes('--scale must be > 0'), 'cli shot rejects out-of-range --scale', shotScale0.stdout + shotScale0.stderr);
  const shotQual = await cli('shot', 'example.com', shotPath, '--quality', '200');
  assert(shotQual.status !== 0 && shotQual.stderr.includes('--quality must be 1..100'), 'cli shot rejects out-of-range --quality', shotQual.stdout + shotQual.stderr);

  // paste: BRIDGE_CLIPBOARD stands in for the OS clipboard (hermetic — CI
  // has no pbpaste); -- <text> bypasses it entirely (the agent usually HAS
  // the text and shouldn't touch the user's clipboard).
  const pasteClip = await cliRaw(['paste', 'example.com', '@e2', '--diff'], null, { BRIDGE_CLIPBOARD: 'clipboard text' });
  assert(
    pasteClip.status === 0 && pasteClip.stdout.includes('"value":"clipboard text"') && pasteClip.stdout.includes('"clip":true') && pasteClip.stdout.includes('"diff":true'),
    'cli paste reads the clipboard (override) with --diff',
    pasteClip.stdout + pasteClip.stderr
  );
  const pasteText = await cli('paste', 'example.com', '@e2', '--diff', '--', 'explicit paste text');
  assert(
    pasteText.status === 0 && pasteText.stdout.includes('"value":"explicit paste text"') && pasteText.stdout.includes('"clip":false') && pasteText.stdout.includes('"diff":true'),
    'cli paste -- <text> bypasses the clipboard',
    pasteText.stdout + pasteText.stderr
  );
  const pasteEmpty = await cliRaw(['paste', 'example.com', '@e2'], null, { BRIDGE_CLIPBOARD: '' });
  assert(pasteEmpty.status !== 0 && pasteEmpty.stderr.includes('clipboard is empty'), 'cli paste fails loudly on an empty clipboard', pasteEmpty.stdout + pasteEmpty.stderr);
  const pasteUsage = await cli('paste');
  assert(pasteUsage.status !== 0 && pasteUsage.stderr.includes('usage: paste'), 'cli paste usage error', pasteUsage.stdout + pasteUsage.stderr);

  const press = await cli('press', 'example.com', 'Enter', '@e3');
  assert(press.status === 0 && press.stdout.includes('"key":"Enter"') && press.stdout.includes('"target":"@e3"'), 'cli press passes key+target', press.stdout + press.stderr);

  const typ = await cli('type', 'example.com', '@e2', 'hello', 'world');
  assert(typ.status === 0 && typ.stdout.includes('"value":"hello world"'), 'cli type joins text args', typ.stdout + typ.stderr);
  // Long-form text is paste's job: a 2000+ char type is per-keystroke cost on
  // the page's clock and blew the 70s cap on heavy composers (live: LinkedIn).
  const typLong = await cli('type', 'example.com', '@e2', 'a'.repeat(2001));
  assert(typLong.status !== 0 && typLong.stderr.includes('paste <match>'), 'cli type refuses 2000+ chars, points at paste', typLong.stdout + typLong.stderr.slice(0, 200));

  const hov = await cli('hover', 'example.com', '@e1');
  assert(hov.status === 0 && hov.stdout.includes('"target":"@e1"'), 'cli hover passes target', hov.stdout + hov.stderr);

  const netc = await cli('net', 'example.com', '--dur', '500', '--filter', '/api');
  assert(netc.status === 0 && netc.stdout.includes('"duration":500') && netc.stdout.includes('"filter":"/api"'), 'cli net flags', netc.stdout + netc.stderr);
  // --har: the {lines, har} shape lands in a file; the lines print unchanged
  const harPath = '/tmp/chrome-bridge-selftest.har';
  const netHar = await cli('net', 'example.com', '--dur', '500', '--har', harPath);
  assert(
    netHar.status === 0 && netHar.stdout.includes('GET 200 /x') && fs.readFileSync(harPath, 'utf8').includes('"version": "1.2"') && netHar.stderr.includes('HAR 1.2, 1 entries'),
    'cli net --har writes the HAR file and prints the lines',
    netHar.stdout + netHar.stderr
  );
  fs.unlinkSync(harPath);
  // --ws: WebSocket frame capture flag rides the wire
  const netWs = await cli('net', 'example.com', '--ws', '--dur', '500');
  assert(netWs.status === 0 && netWs.stdout.includes('"ws":true') && netWs.stdout.includes('"duration":500'), 'cli net --ws rides with --dur', netWs.stdout + netWs.stderr);
  // --dur caps at 30s — the extension silently clamps, so fail here instead
  const netCap = await cli('net', 'example.com', '--dur', '60000');
  assert(netCap.status !== 0 && netCap.stderr.includes('--dur max is 30000'), 'cli net rejects --dur above the 30s cap', netCap.stdout + netCap.stderr);

  // --diff on actions: flag reaches the extension; plain actions don't send it
  const clickDiff = await cli('click', 'example.com', '@e3', '--diff');
  assert(clickDiff.status === 0 && clickDiff.stdout.includes('"target":"@e3"') && clickDiff.stdout.includes('"diff":true'), 'cli click --diff', clickDiff.stdout + clickDiff.stderr);
  const clickPlain = await cli('click', 'example.com', '@e3');
  assert(clickPlain.status === 0 && !clickPlain.stdout.includes('"diff"'), 'cli click without --diff sends no diff', clickPlain.stdout + clickPlain.stderr);
  const fillDiff = await cli('fill', 'example.com', '@e2', 'hello world', '--diff');
  assert(fillDiff.status === 0 && fillDiff.stdout.includes('"value":"hello world"') && fillDiff.stdout.includes('"diff":true'), 'cli fill --diff keeps value', fillDiff.stdout + fillDiff.stderr);
  // '--' separator: pasted content can legitimately start with '--' (dev.to
  // front-matter died on the stray-flag scan); after a bare '--' everything
  // is value. Before it, the fat-finger guard still fires.
  const fillDash = await cli('fill', 'example.com', '@e2', '--', '---\ntitle: x');
  assert(fillDash.status === 0 && fillDash.stdout.includes('"value":"---\\ntitle: x"'), 'cli fill -- separator passes --leading values', fillDash.stdout + fillDash.stderr);
  const fillDashDiff = await cli('fill', 'example.com', '@e2', '--diff', '--', 'hello world');
  assert(fillDashDiff.status === 0 && fillDashDiff.stdout.includes('"value":"hello world"') && fillDashDiff.stdout.includes('"diff":true'), 'cli fill flags before -- separator, value after', fillDashDiff.stdout + fillDashDiff.stderr);
  // A typoed flag must fail loudly — it used to be typed into the user's real form.
  const fillTypo = await cli('fill', 'example.com', '@e2', 'John', '--dfif');
  assert(fillTypo.status !== 0 && fillTypo.stderr.includes('unknown flag --dfif') && fillTypo.stderr.includes("'--' separator"), 'cli fill rejects a typoed flag instead of typing it, error teaches the -- separator', fillTypo.stdout + fillTypo.stderr);
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

  // fetch: result shape processed CLI-side — --out writes the body (base64
  // decoded for binary), text prints to stdout, binary without --out fails
  // with the hint.
  const fetchText = await cli('fetch', 'example.com', 'https://api.example.com/data');
  assert(fetchText.status === 0 && fetchText.stdout.includes('application/json') && fetchText.stdout.includes('{"a":1}'), 'cli fetch prints status + text body', fetchText.stdout + fetchText.stderr);
  const fetchOut = await cli('fetch', 'example.com', 'https://api.example.com/data', '--out', '/tmp/chrome-bridge-selftest.json');
  assert(fetchOut.status === 0 && fs.readFileSync('/tmp/chrome-bridge-selftest.json', 'utf8') === '{"a":1}' && fetchOut.stdout.includes('saved'), 'cli fetch --out writes the body', fetchOut.stdout + fetchOut.stderr);
  fs.unlinkSync('/tmp/chrome-bridge-selftest.json');
  const fetchBin = await cli('fetch', 'example.com', 'https://binary.example/doc', '--out', '/tmp/chrome-bridge-selftest.bin');
  assert(fetchBin.status === 0 && fs.readFileSync('/tmp/chrome-bridge-selftest.bin').equals(Buffer.from('PDFBYTES')), 'cli fetch --out decodes binary bodies', fetchBin.stdout + fetchBin.stderr);
  fs.unlinkSync('/tmp/chrome-bridge-selftest.bin');
  const fetchBinNoOut = await cli('fetch', 'example.com', 'https://binary.example/doc');
  assert(fetchBinNoOut.status !== 0 && fetchBinNoOut.stderr.includes('--out'), 'cli fetch refuses a binary body without --out', fetchBinNoOut.stdout + fetchBinNoOut.stderr);
  const fetchBadUrl = await cli('fetch', 'example.com', 'not-a-url');
  assert(fetchBadUrl.status !== 0 && fetchBadUrl.stderr.includes('full http(s) URL'), 'cli fetch validates the URL', fetchBadUrl.stdout + fetchBadUrl.stderr);
  const fetchTypo = await cli('fetch', 'example.com', 'https://x', '--ou', 'f');
  assert(fetchTypo.status !== 0 && fetchTypo.stderr.includes('unknown flag'), 'cli fetch rejects unknown flags', fetchTypo.stdout + fetchTypo.stderr);

  // measure/grid are real command types (their page-JS lives in the extension  // with every other page script; ACT_VERBS carries the pill label)
  const meas = await cli('measure', 'example.com', '.btn');
  assert(meas.status === 0 && meas.stdout.includes('"type":"measure"') && meas.stdout.includes('"selector":".btn"'), 'cli measure sends its own type + selector', meas.stdout + meas.stderr);
  const gr = await cli('grid', 'example.com');
  assert(gr.status === 0 && gr.stdout.includes('"type":"grid"'), 'cli grid sends its own type', gr.stdout + gr.stderr);

  // Wire shapes for commands the suite never echoed before (open/close/mark/
  // release/unemulate/wait/emulate/resize + the new dialog/drag) — pins each
  // command's field names against renames.
  const waitEcho = await cli('wait', 'example.com', '--text', 'Saved', '--timeout', '500');
  assert(waitEcho.status === 0 && waitEcho.stdout.includes('"text":"Saved"') && waitEcho.stdout.includes('"timeout":500'), 'cli wait passes text+timeout', waitEcho.stdout + waitEcho.stderr);
  // --human: CAPTCHA/2FA handoff — flag rides, default 120s (a human needs
  // more than a page), max 280s (the CLI HTTP client gives up at 5 min),
  // and it can't be mixed with the page-side wait modes.
  const waitHuman = await cli('wait', 'example.com', '--human');
  assert(
    waitHuman.status === 0 && waitHuman.stdout.includes('"human":true') && waitHuman.stdout.includes('"timeout":120000') && waitHuman.stdout.includes('"text":null'),
    'cli wait --human: default 120s, no page-side predicate',
    waitHuman.stdout + waitHuman.stderr
  );
  const waitHumanT = await cli('wait', 'example.com', '--human', '--timeout', '200000');
  assert(waitHumanT.status === 0 && waitHumanT.stdout.includes('"timeout":200000'), 'cli wait --human --timeout passes through', waitHumanT.stdout + waitHumanT.stderr);
  const waitHumanCap = await cli('wait', 'example.com', '--human', '--timeout', '300000');
  assert(waitHumanCap.status !== 0 && waitHumanCap.stderr.includes('280000'), 'cli wait --human caps at 280s (the 5-min HTTP wall)', waitHumanCap.stdout + waitHumanCap.stderr);
  const waitHumanMix = await cli('wait', 'example.com', '--human', '--text', 'Saved');
  assert(waitHumanMix.status !== 0 && waitHumanMix.stderr.includes('usage: wait'), 'cli wait --human is exclusive with --text/selector', waitHumanMix.stdout + waitHumanMix.stderr);
  const waitTypo = await cli('wait', 'example.com', '--tex', 'Saved');
  assert(waitTypo.status !== 0 && waitTypo.stderr.includes('unknown flag --tex'), 'cli wait rejects unknown flags', waitTypo.stdout + waitTypo.stderr);
  const waitBare = await cli('wait', 'example.com');
  assert(waitBare.status !== 0 && waitBare.stderr.includes('usage: wait'), 'cli wait needs a selector or --text', waitBare.stdout + waitBare.stderr);
  const dlg = await cli('dialog', 'example.com', 'accept');
  assert(dlg.status === 0 && dlg.stdout.includes('"accept":true') && !dlg.stdout.includes('"text"'), 'cli dialog accept sends no text', dlg.stdout + dlg.stderr);
  const dlgText = await cli('dialog', 'example.com', 'dismiss', '--text', 'no thanks');
  assert(dlgText.status === 0 && dlgText.stdout.includes('"accept":false') && dlgText.stdout.includes('"text":"no thanks"'), 'cli dialog dismiss --text', dlgText.stdout + dlgText.stderr);
  const dlgBad = await cli('dialog', 'example.com', 'maybe');
  assert(dlgBad.status !== 0 && dlgBad.stderr.includes('usage: dialog'), 'cli dialog validates the action', dlgBad.stdout + dlgBad.stderr);
  const drg = await cli('drag', 'example.com', '@e1', '@e2', '--diff');
  assert(drg.status === 0 && drg.stdout.includes('"from":"@e1"') && drg.stdout.includes('"to":"@e2"') && drg.stdout.includes('"diff":true'), 'cli drag passes from+to+diff', drg.stdout + drg.stderr);
  const dbl = await cli('click', 'example.com', '@e3', '--dbl');
  assert(dbl.status === 0 && dbl.stdout.includes('"dbl":true'), 'cli click --dbl', dbl.stdout + dbl.stderr);
  // --trusted: opt-in CDP Input on click/press/type/hover/drag (isTrusted
  // events — canvas tools, browser defaults). fill has no --trusted.
  const trus = await cli('click', 'example.com', '@e3', '--trusted', '--diff');
  assert(trus.status === 0 && trus.stdout.includes('"trusted":true') && trus.stdout.includes('"diff":true'), 'cli click --trusted rides with --diff', trus.stdout + trus.stderr);
  const trusPress = await cli('press', 'example.com', 'Enter', '--trusted');
  assert(trusPress.status === 0 && trusPress.stdout.includes('"trusted":true'), 'cli press --trusted', trusPress.stdout + trusPress.stderr);
  const trusType = await cli('type', 'example.com', '@e2', 'hi', '--trusted');
  assert(trusType.status === 0 && trusType.stdout.includes('"trusted":true') && trusType.stdout.includes('"value":"hi"'), 'cli type --trusted keeps the value', trusType.stdout + trusType.stderr);
  const trusFill = await cli('fill', 'example.com', '@e2', 'hi', '--trusted');
  assert(trusFill.status !== 0 && trusFill.stderr.includes('unknown flag'), 'cli fill has no --trusted (value setter has no events to fake)', trusFill.stdout + trusFill.stderr);
  // emulate focus: the spike command — the page believes it's focused.
  const emuFocus = await cli('emulate', 'example.com', 'focus');
  assert(emuFocus.status === 0 && emuFocus.stdout.includes('"focus":true') && !emuFocus.stdout.includes('"width"'), 'cli emulate focus mode (no w/h)', emuFocus.stdout + emuFocus.stderr);
  const emu = await cli('emulate', 'example.com', '375', '667', 'mobile');
  assert(emu.status === 0 && emu.stdout.includes('"width":375') && emu.stdout.includes('"mobile":true'), 'cli emulate wire shape', emu.stdout + emu.stderr);
  const rsz = await cli('resize', 'example.com', '800', '600');
  assert(rsz.status === 0 && rsz.stdout.includes('"width":800') && rsz.stdout.includes('"height":600'), 'cli resize wire shape', rsz.stdout + rsz.stderr);
  const opn = await cli('open', 'https://example.org/');
  assert(opn.status === 0 && opn.stdout.includes('"url":"https://example.org/"'), 'cli open passes the url', opn.stdout + opn.stderr);
  const mrk = await cli('mark', 'example.com');
  assert(mrk.status === 0 && mrk.stdout.includes('"urlMatch":"example.com"'), 'cli mark wire shape', mrk.stdout + mrk.stderr);
  const rel = await cli('release', 'example.com');
  assert(rel.status === 0 && rel.stdout.includes('"type":"release"'), 'cli release wire shape', rel.stdout + rel.stderr);
  const unm = await cli('unemulate', 'example.com');
  assert(unm.status === 0 && unm.stdout.includes('"type":"unemulate"'), 'cli unemulate wire shape', unm.stdout + unm.stderr);

  // batch: one process for N commands, quotes honored, '#' comments; the
  // '$ line' echo rides stderr so stdout stays pure concatenated results.
  const batch = await cliStdin('tabs example.com\n# comment\nfill example.com @e2 "hello world"\n', 'batch');
  assert(
    batch.status === 0 && batch.stdout.includes('"url":"https://example.com/"') && batch.stdout.includes('"value":"hello world"') && !batch.stdout.includes('$ '),
    'cli batch runs stdin commands (quotes, comments), results on stdout',
    batch.stdout + batch.stderr
  );
  assert(batch.stderr.includes('$ tabs example.com'), 'cli batch echoes lines to stderr', batch.stderr);

  // A leading --profile routes the batch's lines (history --batch emits one
  // per recorded command) — it used to read as an unknown command name.
  const batchProf = await cliStdin('--profile alpha-test\nsnap example.com\n', 'batch');
  assert(batchProf.status === 0 && batchProf.stdout.includes('"urlMatch":"example.com"'), 'cli batch accepts a leading --profile', batchProf.stdout + batchProf.stderr);

  // history: thin read over the server ring (the same data watch tails);
  // --batch exports the replayable form the server rebuilt at relay time.
  const hist = await cli('history');
  assert(hist.status === 0 && hist.stdout.includes('eval example.com') && hist.stdout.includes('· ok'), 'cli history reads the server ring', hist.stdout + hist.stderr);
  const histN = await cli('history', '-n', '1');
  assert(histN.status === 0 && histN.stdout.trim().split('\n').length === 1, 'cli history -n takes the newest N', histN.stdout + histN.stderr);
  const histBad = await cli('history', '--nope');
  assert(histBad.status !== 0 && histBad.stderr.includes('unknown flag'), 'cli history rejects unknown flags', histBad.stdout + histBad.stderr);
  const histPath = '/tmp/chrome-bridge-selftest.batch';
  const histExport = await cli('history', 'example.com', '--batch', histPath);
  const histScript = fs.readFileSync(histPath, 'utf8');
  assert(
    histExport.status === 0 && histScript.includes('fill example.com @e2 --diff -- "hello world"') && histScript.includes('eval example.com document.title'),
    'cli history --batch exports replayable, quoted commands',
    histExport.stdout + '\n' + histScript
  );
  fs.unlinkSync(histPath);

  const helpFlag = await cli('--help');
  assert(helpFlag.status === 0 && helpFlag.stdout.includes('chrome-bridge CLI'), 'cli --help prints usage, exit 0', helpFlag.stdout + helpFlag.stderr);
  const unknown = await cli('nope');
  assert(unknown.status !== 0 && unknown.stderr.includes('unknown command'), 'cli unknown command fails', unknown.stdout + unknown.stderr);

  // Stress-fix tripwires: selftest drives a FAKE extension, so the service
  // worker's own guards can't be executed here — assert them at source level.
  {
    const bg = fs.readFileSync(`${ROOT}extension/background.js`, 'utf8');
    const cliSrc = fs.readFileSync(`${ROOT}cli.mjs`, 'utf8');
    const serverSrc = fs.readFileSync(`${ROOT}/server.mjs`, 'utf8');
    // CDP debugger refcount: every attach/detach must route through the two
    // helpers. A raw chrome.debugger.attach/detach elsewhere races under
    // concurrent commands on one tab (stress-measured: 13% failures, 70s
    // lost-callback hangs, debugger sessions leaked onto later commands).
    assert(bg.split('chrome.debugger.attach(').length === 2, 'ext: one debugger-attach site (the refcount helper)');
    assert(bg.split('chrome.debugger.detach(').length === 2, 'ext: one debugger-detach site (the refcount helper)');
    assert(bg.split('await attachDbg(').length >= 6 && bg.split('await detachDbg(').length >= 6, 'ext: all 6 CDP call sites refcounted');
    // CDP commands serialize per tab — an unemulate racing a sibling's
    // sendCommand tore the shared session mid-flight (5.5% of interleaved
    // CDP commands in stress). (6 wrap sites: upload/net/emulate/unemulate/
    // shot/dialog.)
    assert(bg.split('withCdp(').length === 10, 'ext: CDP handlers serialize per tab (helper + 8 wrap sites)');
    // open must not await the favicon/banner marking — executeScript sits
    // pending forever on an uncommitted navigation (unreachable URL), which
    // hung open past its 8s cap to the server's 70s timeout. The response
    // also needs the requested URL: a still-pending tab has url "" and could
    // never be matched.
    assert(bg.includes('url: url || msg.url') && /markTab\(tab\.id\)\.catch/.test(bg), 'ext: open fire-and-forgets marking, url falls back to the request');
    // External debugger detach must reset the refcount (infobar cancel,
    // DevTools opened) — else a stale count wedges the session until close.
    assert(bg.includes('chrome.debugger.onDetach.addListener'), 'ext: onDetach resets the CDP refcount');
    // open/nav must reject a non-URL up front: tabs.create resolves such
    // strings relative to the extension itself (stress: open "::x" created a
    // driven chrome-extension://… tab and reported ok).
    assert(
      bg.includes("msg.type === 'open' || msg.type === 'navigate'") && bg.includes('invalid URL '),
      'ext: open/nav validate the URL before creating a tab'
    );
    // A stray unemulate (nothing emulated) must no-op cleanly — the CDP clear
    // at an unattached debugger logged a swlogs FAILED while the caller got ok.
    assert(bg.includes('if (!emulatedTabs.has(tabId)) return;'), 'ext: stray unemulate no-ops instead of logging a FAILED clear');
    // Pill surface tripwires — the states a human glances at. Same style as the
    // ACT_VERBS drift checks: found live in v1.5.0 browser testing.
    assert(
      bg.includes('failedSinceOk') && bg.includes('idleLabel') && bg.includes('failed since last ok'),
      'pill: idle label is failure-aware (consecutive-failure count, not bare AI idle)'
    );
    assert(
      bg.includes("MUTATING.has(msg.type) && msg.type !== 'eval'"),
      'pill: only a successful mutating command clears the failure count — reads are inspection, not recovery'
    );
    assert(bg.includes('pillTick') && bg.includes('startTick') && bg.includes('stopTick'), 'pill: elapsed-seconds ticker runs while a command is in flight');
    assert(bg.includes('scrollTop = p.scrollHeight'), 'pill: open history panel auto-scrolls to the newest lines');
    assert(bg.includes('⚠ bridge offline — reconnecting…'), 'pill: bridge outage shows as offline, not AI idle');
    assert(bg.includes("msg.type === 'note' ? 4000 : 800"), 'pill: a note holds its label ~4s — a ~100ms note command must not flash unseen');
    assert(bg.includes("replace(/^(Error:\\s*)+/, '')"), 'pill history: doubled Error: nesting deduped (the feed fix 756df17, third surface)');
    // Tab-match confusion: a lookalike URL path (evil.com/github.com matches
    // 'github.com') must not silently win — findTab warns on ambiguity (the
    // warning rides the result via onmessage), prefers driven tabs over MRU,
    // and mutating commands auto-mark so acting on a tab is never invisible.
    assert(bg.includes('tabs match') && bg.includes('msg._warn'), 'ext: findTab warns on an ambiguous match');
    assert(bg.includes('drivenTabs.has(b.id)'), 'ext: findTab prefers driven tabs over most-recently-active');
    assert(bg.includes('MUTATING.has(msg.type)') && bg.includes('markTab(matches[0].id)'), 'ext: mutating commands auto-mark the tab');
    assert(bg.includes('if (msg._warn)'), 'ext: onmessage appends the ambiguous-match warning to the result');

    // Contract drift tripwires: the command list lives in 3 places (cli USAGE,
    // handle() dispatch, ACT_VERBS) kept in sync by hand — fail here when they
    // drift instead of shipping a command with a wrong/missing pill label.
    const handleTypes = new Set([...bg.matchAll(/msg\.type === '(\w+)'/g)].map((m) => m[1]));
    for (const m of bg.matchAll(/\[([^\]]+)\]\.includes\(msg\.type\)/g))
      for (const q of m[1].matchAll(/'(\w+)'/g)) handleTypes.add(q[1]);
    const verbBlock = bg.slice(bg.indexOf('const ACT_VERBS'), bg.indexOf('};', bg.indexOf('const ACT_VERBS')));
    const verbKeys = new Set([...verbBlock.matchAll(/^  (\w+): \[/gm)].map((m) => m[1]));
    // ping/swlogs/tabs/probe never reach findTab (no pill; probe is a
    // server-internal routing query); note is special-cased in activityPhrases.
    const NO_VERBS = ['ping', 'swlogs', 'tabs', 'note', 'probe'];
    assert(
      [...handleTypes].filter((t) => !NO_VERBS.includes(t)).sort().join() === [...verbKeys].sort().join(),
      'drift: ACT_VERBS keys vs handle() types',
      `handle: ${[...handleTypes].sort()} verbs: ${[...verbKeys].sort()}`
    );
    const usageBlock = cliSrc.slice(cliSrc.indexOf('const USAGE'), cliSrc.indexOf('`;', cliSrc.indexOf('const USAGE')));
    const usageCmds = new Set(
      [...usageBlock.matchAll(/^  (\S+)/gm)].flatMap((m) => m[1].split('|')).filter((c) => /^[a-z]+$/.test(c))
    );
    // CLI-local commands (no wire type), the nav→navigate alias, and probe
    // (a server-internal routing query — no CLI surface).
    const CLI_LOCAL = ['batch', 'health', 'start', 'stop', 'watch', 'history', 'profiles', 'probe'];
    const usageWire = new Set([...usageCmds].filter((c) => !CLI_LOCAL.includes(c)).map((c) => (c === 'nav' ? 'navigate' : c)));
    assert(
      [...usageWire].sort().join() === [...handleTypes].filter((t) => t !== 'ping' && t !== 'probe').sort().join(),
      'drift: cli USAGE commands vs handle() types',
      `usage: ${[...usageWire].sort()} handle: ${[...handleTypes].sort()}`
    );
    // The label back-channel is gone — pill labels come from ACT_VERBS only.
    assert(!bg.includes('msg.label'), 'ext: no msg.label special-case (measure/grid are real types now)');
    // snap never prints a password field's value (autofilled credentials
    // would land in the agent's context + scrollback).
    assert(bg.includes("el.type === 'password'"), 'ext: snap masks password inputs');
    // Two Chrome profiles: the loser learns it lost (seat-taken) instead of
    // churning reconnects, and the server names the winner in /health.
    assert(bg.includes('seat-taken') && serverSrc.includes('seat-taken'), 'ext+server: WS seat loss is announced, not churned');
    // The agent's primary failure diagnostics — pin the exact strings.
    assert(serverSrc.includes('extension not connected — load extension/ at chrome://extensions'), 'server: disconnected-extension error text');
    assert(cliSrc.includes('node cli.mjs start') && !cliSrc.includes('node server.mjs'), 'cli: server-down advice spawns detached (cli start), never foreground server.mjs');
    // watch's boot-reset: actSeq resets on restart — without this check every
    // new line is filtered out after a server restart.
    assert(cliSrc.includes('res.boot !== boot'), 'cli: watch resets its cursor on server restart');
    // wait --human: the handoff must only complete on TRUSTED input (synthetic
    // events can't answer a CAPTCHA, and page JS must not be able to flip the
    // flag) and the server must hold it past the 70s command cap.
    assert(bg.includes('waitHuman') && bg.includes('e.isTrusted'), 'ext: wait --human completes only on trusted input');
    assert(bg.includes("world: 'ISOLATED'") && bg.includes('__bridgeHumanActed'), 'ext: the human-acted flag lives in the ISOLATED world (page JS cannot flip it)');
    assert(serverSrc.includes("msg.type === 'wait' && msg.human"), 'server: wait --human rides the long-wait path past the 70s cap');
    // The click coverage check must treat a shadow HOST containing the target
    // as a container, not an occluder — elementFromPoint returns the host for
    // shadow-tree points and host.contains() walks light DOM only (LinkedIn's
    // share modal made every in-shadow element unclickable).
    assert(bg.includes('root.host === top'), 'ext: click coverage walks the composed chain — a shadow host containing the target is a container, not an occluder');
    // paste: Chrome's ClipboardEvent constructor ignores the clipboardData
    // init key — only a duck-typed plain Event lets editor paste handlers
    // (Quill, ProseMirror) read the payload; no handler claiming it must
    // still land the text (caret insertion / execCommand).
    assert(bg.includes('ev.clipboardData =') && bg.includes('insertFromPaste'), 'ext: paste duck-types clipboardData (constructor drops it) and falls back to native insertion');
    // The bridge's own UI must not defeat the bridge's own observation: the
    // pill ticker mutates every 5s on a driven tab (settle could never go
    // quiet — every --diff ate its full 3s cap) and the pill is a role=button
    // that would mint a ref and own the snap diff.
    assert(bg.includes('BRIDGE_SEL') && bg.includes('inBridge'), 'ext: settle ignores the bridge-injected DOM (pill ticker, cursor, grid)');
    assert(bg.includes("el.id === 'bridge-banner'") && bg.includes("el.id === 'bridge-cursor'"), 'ext: snap excludes the bridge UI (the pill is not page content)');
    assert(bg.includes('Math.min(25, 15000 / text.length)'), 'ext: type caps its total inter-char sleep budget (~15s) for long text');
    // Shadow-piercing target resolution: document.querySelector can't reach
    // open shadow roots (Reddit's faceplate-*, LinkedIn's nested roots) —
    // every action script resolves via deepQuery (@refs/document CSS first,
    // deep walk on a miss).
    assert(bg.includes('const DEEPQ') && bg.split('deepQuery(sel').length >= 11, 'ext: action targets pierce open shadow roots (deepQuery at every resolution site)', `deepQuery sites: ${bg.split('deepQuery(sel').length}`);
    assert(bg.includes('deepAll(') && bg.includes("deepAll(${JSON.stringify(sel)}, document)"), 'ext: measure matches inside open shadow roots too');
    // net: the initiator (already arriving on requestWillBeSent) rides the
    // line — the request→issuing-script jump, nearly free with the debugger
    // already attached.
    assert(bg.includes('params.initiator') && bg.includes('⟵ '), 'ext: net lines carry the request initiator (⟵ script:line)');
    // HAR 1.2 export: entries built from the payloads already riding the
    // capture events (headers, postData, wallTime), bodies with base64
    // encoding flagged, initiator as the standard _initiator field.
    assert(bg.includes("version: '1.2'") && bg.includes('_initiator') && bg.includes('encoding:'), 'ext: net --har builds a real HAR 1.2 log (creator, entries, _initiator, base64 bodies)');
    // --ws: the debugger is attached for net anyway — the frame events are
    // nearly free; caps are printed, never silent.
    assert(
      bg.includes('Network.webSocketFrameSent') && bg.includes('Network.webSocketFrameReceived') && bg.includes('(no WebSocket frames this window)'),
      'ext: net --ws captures WebSocket frames with explicit caps and an honest empty state'
    );
    // --trusted routes through CDP Input.dispatch* — isTrusted=true events,
    // the one thing synthetic dispatch can't fake. It rides the same
    // attach/serialize plumbing as upload (refcount + withCdp).
    assert(bg.includes('Input.dispatchMouseEvent') && bg.includes('Input.dispatchKeyEvent') && bg.includes('trustedInput'), 'ext: --trusted drives CDP Input (isTrusted events) via the shared debugger plumbing');
    assert(bg.includes('trustedPointSrc') && bg.includes('COVERAGE_SRC') && bg.includes('cdpDrag'), 'ext: trusted input runs the same coverage preflight; trusted drag interpolates real pointer moves');
    // --skeleton: past the depth cut, count instead of emit — cut containers
    // read '… N inside' (self-describing truncation, deterministic drill via
    // the positional @ref scope), and skeleton diffs keep their own store.
    // --diff actions carry a verdict (#8, neobrowser VERIFIED-ACTIONS style):
    // first word of the result. The wall scan names bot walls; a pre-action
    // baseline makes the diff read exactly the action's effects; uncertain is
    // never promoted to succeeded.
    assert(
      bg.includes('WALL_SRC') && bg.includes('needs_human') && bg.includes('blocked') && bg.includes('uncertain') && bg.includes('succeeded'),
      'ext: --diff actions return verdict statuses (succeeded/needs_human/blocked/uncertain)'
    );
    assert(
      bg.includes('actAndVerify') && bg.includes('pre-action baseline'),
      'ext: verdicts diff against a pre-action baseline (not the last snap — click A used to bleed into click B --diff)'
    );
    assert(
      bg.includes('reCAPTCHA') && bg.includes('Cloudflare Turnstile') && bg.includes('DataDome'),
      'ext: the wall scan names the common bot walls (reCAPTCHA, Turnstile, DataDome, PerimeterX, Arkose)'
    );
    // --skeleton: past the depth cut, count instead of emit — cut containers
    // read '… N inside' (self-describing truncation, deterministic drill via
    // the positional @ref scope), and skeleton diffs keep their own store.
    assert(bg.includes('countLines') && bg.includes("' inside'"), 'ext: snap --skeleton counts the cut subtrees and marks them (… N inside)');
    assert(bg.includes("|skel' : ''"), 'ext: skeleton diffs keep their own store (counts churn — mixing shapes would diff noise)');
    // Focus emulation (#18 spike): enabled by 'emulate focus', cleared by
    // unemulate with the rest of the emulation family.
    assert(bg.includes('setFocusEmulationEnabled') && bg.split('setFocusEmulationEnabled').length === 3, 'ext: emulate focus sets and unemulate clears focus emulation');

    // The service worker is never executed here (the fake extension plays it)
    // — a syntax error in it would otherwise ship green, as would one in
    // install.sh (the first file a new user runs; nothing else even bash -ns it).
    assert(spawnSync('node', ['--check', `${ROOT}extension/background.js`]).status === 0, 'ext: background.js parses (node --check)');
    assert(spawnSync('bash', ['-n', `${ROOT}install.sh`]).status === 0, 'install.sh parses (bash -n)');

    // The per-domain recipe convention (#19): AGENTS.md points agents at
    // recipes/<domain>.md before acting — a missing dir/file 404s the
    // convention for every agent that reads the manual.
    assert(
      fs.existsSync(`${ROOT}recipes/README.md`) && fs.readFileSync(`${ROOT}AGENTS.md`, 'utf8').includes('recipes/README.md'),
      'recipes: the convention file exists and AGENTS.md points at it'
    );
    // The agent-setup paste text is THE install interface (both READMEs embed it
    // as the quick start) — same drift logic as AGENTS.md below: a stale copy
    // ships broken install instructions to every new user.
    const setupMd = fs.readFileSync(`${ROOT}docs/agent-setup.md`, 'utf8').trim();
    for (const f of ['README.md', 'README.zh-CN.md']) {
      assert(
        fs.readFileSync(`${ROOT}${f}`, 'utf8').includes(setupMd),
        `drift: ${f} embeds docs/agent-setup.md verbatim`,
        're-copy docs/agent-setup.md into the README quick-start block'
      );
    }

    // AGENTS.md's fenced Commands block is the agent-facing command list —
    // doc drift is a real bug class here (the --profile name landed without
    // touching any doc), so it must name exactly the cli USAGE commands.
    const agentsMd = fs.readFileSync(`${ROOT}AGENTS.md`, 'utf8');
    const cmdSec = agentsMd.slice(agentsMd.indexOf('## Commands'));
    const fenceStart = cmdSec.indexOf('```');
    const cmdFence = cmdSec.slice(fenceStart + 3, cmdSec.indexOf('```', fenceStart + 3));
    const docCmds = new Set(
      [...cmdFence.matchAll(/^(\S+)/gm)].flatMap((m) => m[1].split('|')).filter((c) => /^[a-z]+$/.test(c))
    );
    assert(
      [...usageCmds].sort().join() === [...docCmds].sort().join(),
      'drift: AGENTS.md Commands block vs cli USAGE commands',
      `usage: ${[...usageCmds].sort()} docs: ${[...docCmds].sort()}`
    );
  }

  // activity feed (watch): every relayed command lands in /log; since= yields a delta
  const logAll = (await fetch(`http://127.0.0.1:${PORT}/log`).then((r) => r.json())).lines;
  assert(
    logAll.some((a) => a.line.includes('eval example.com') && a.line.includes('· ok')) &&
      logAll.some((a) => a.line.includes('note example.com saving the draft')),
    'server /log records commands',
    JSON.stringify(logAll.slice(-3))
  );
  const logDelta = (await fetch(`http://127.0.0.1:${PORT}/log?since=${logAll[logAll.length - 1].seq - 1}`).then((r) => r.json())).lines;
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

  // DNS-rebinding guard: a non-loopback Host is refused on every route, even
  // with no Origin/Sec-Fetch headers at all (a rebound page is "same-origin",
  // so those guards don't apply to its GETs — Host is the one header fetch
  // can't forge).
  const hostReq = (path, method = 'GET') =>
    new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: { Host: `evil.com:${PORT}` } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      r.on('error', () => resolve(0));
      r.end();
    });
  assert((await hostReq('/log')) === 403, 'server: /log with rebound Host → 403');
  assert((await hostReq('/health')) === 403, 'server: /health with rebound Host → 403');
  assert((await hostReq('/cmd', 'POST')) === 403, 'server: /cmd with rebound Host → 403');
  assert((await hostReq('/stop', 'POST')) === 403, 'server: /stop with rebound Host → 403');
  h = await cli('health');
  assert(JSON.parse(h.stdout).ok === true, 'server survives the rebound /stop attempt', h.stdout + h.stderr);

  const rebindWs = await new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    let buf = '';
    s.on('data', (c) => (buf += c));
    s.on('connect', () =>
      s.write(
        // No Origin at all — a non-browser client would pass the origin rule;
        // only the Host guard rejects this.
        `GET /ws HTTP/1.1\r\nHost: evil.com:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      )
    );
    s.on('close', () => resolve(!buf.includes('101')));
    s.on('error', () => resolve(!buf.includes('101')));
    setTimeout(() => { s.destroy(); resolve(false); }, 1000);
  });
  assert(rebindWs, 'server: WS upgrade with rebound Host rejected');

  // Page-influenced error text can't inject ANSI escapes or forged lines into
  // the activity feed (server.log / `watch` terminal).
  await fetch(`http://127.0.0.1:${PORT}/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'ansierr' }),
  });
  const ansiLine = (await fetch(`http://127.0.0.1:${PORT}/log`).then((r) => r.json())).lines.find((a) => a.line.includes('ansierr'));
  assert(ansiLine && !/[\x00-\x1f\x7f]/.test(ansiLine.line), 'server /log strips control chars from error text', JSON.stringify(ansiLine));

  // --- multi-profile routing: a second fake profile takes its own seat ---------
  // Every command still routes to exactly ONE profile: unique matches route
  // automatically, cross-profile matches are refused with a --profile hint,
  // and --profile (prefix match) picks explicitly.
  const ext2 = await wsClient(PORT, 'beta-test');
  ext2.onMessage((msg) => {
    const respond = (result) => ext2.send({ id: msg.id, ok: true, result });
    if (msg.type === 'ping') return respond('pong');
    if (msg.type === 'probe')
      return respond(
        [{ id: 9, url: 'https://sample.org/', lastAccessed: 1 }, { id: 10, url: 'https://dupe.example/b', lastAccessed: 2 }].filter((t) =>
          t.url.includes(msg.urlMatch)
        )
      );
    if (msg.type === 'tabs') return respond([{ id: 9, url: 'https://sample.org/', title: 'Sample B', driven: false }]);
    if (['snap', 'eval', 'open'].includes(msg.type)) return respond(msg); // echo
    return respond(null);
  });
  await new Promise((r) => setTimeout(r, 100));

  {
    const hv = JSON.parse((await cli('health')).stdout);
    assert(hv.profiles?.length === 2, 'health lists both connected profiles', JSON.stringify(hv));
    const prof = await cli('profiles');
    assert(prof.status === 0 && prof.stdout.includes('alpha-test') && prof.stdout.includes('beta-test'), 'cli profiles lists ids + versions', prof.stdout + prof.stderr);

    const merged = await cli('tabs');
    assert(
      merged.status === 0 && merged.stdout.includes('"profile":"alph"') && merged.stdout.includes('"profile":"beta"') && merged.stdout.includes('sample.org'),
      'cli tabs merged across profiles with profile tags',
      merged.stdout + merged.stderr
    );

    // unique match routes automatically — example.com exists only in alpha
    const autoRoute = await cli('snap', 'example.com');
    assert(autoRoute.status === 0 && autoRoute.stdout.includes('"urlMatch":"example.com"'), 'multi-seat: unique match routes without --profile', autoRoute.stdout + autoRoute.stderr);

    // cross-profile match refuses and teaches --profile
    const refused = await cli('snap', 'dupe.example');
    assert(refused.status !== 0 && refused.stderr.includes('matches tabs in 2 profiles') && refused.stderr.includes('--profile'), 'multi-seat: cross-profile ambiguity refused with a --profile hint', refused.stdout + refused.stderr);

    // --profile routes explicitly (prefix match on the id)
    const pinned = await cli('--profile', 'beta', 'snap', 'sample.org');
    assert(pinned.status === 0 && pinned.stdout.includes('"urlMatch":"sample.org"'), 'multi-seat: --profile prefix routes to the named profile', pinned.stdout + pinned.stderr);

    const badProfile = await cli('--profile', 'nope', 'snap', 'example.com');
    assert(badProfile.status !== 0 && badProfile.stderr.includes("no connected profile matching 'nope'"), 'multi-seat: unknown --profile fails loudly', badProfile.stdout + badProfile.stderr);

    // open has no <match> to probe — needs --profile when several seats exist
    const openRefused = await cli('open', 'https://example.org/');
    assert(openRefused.status !== 0 && openRefused.stderr.includes('--profile'), 'multi-seat: open without --profile refused', openRefused.stdout + openRefused.stderr);
    const openPinned = await cli('--profile', 'alpha', 'open', 'https://example.org/');
    assert(openPinned.status === 0 && openPinned.stdout.includes('"url":"https://example.org/"'), 'multi-seat: open --profile routes', openPinned.stdout + openPinned.stderr);

    // the activity feed names who acted
    const feed = (await fetch(`http://127.0.0.1:${PORT}/log`).then((r) => r.json())).lines;
    assert(feed.some((a) => a.line.includes('snap sample.org @beta')), 'feed: routed command carries the profile tag', JSON.stringify(feed.slice(-3)));

    // The exported replay of a routed command carries --profile (batch accepts
    // a leading one) — replaying it in a multi-profile setup lands in the same
    // profile instead of relying on auto-routing.
    const histPath2 = '/tmp/chrome-bridge-selftest2.batch';
    await cli('history', '--batch', histPath2);
    assert(
      fs.readFileSync(histPath2, 'utf8').includes('--profile beta snap sample.org'),
      'history --batch: routed commands carry --profile',
      fs.readFileSync(histPath2, 'utf8')
    );
    fs.unlinkSync(histPath2);

    // --- human-facing profile names -------------------------------------------
    // The extension derives a stable word from its profile id (?name= in the WS
    // handshake); the feed and /health show it — a uuid prefix (@4371) means
    // nothing to the human reading the watch feed.
    const ext4 = await wsClient(PORT, 'named-test', 'oak-test');
    ext4.onMessage((msg) => {
      if (msg.type === 'ping') return ext4.send({ id: msg.id, ok: true, result: 'pong' });
      if (msg.type === 'probe') return ext4.send({ id: msg.id, ok: true, result: [{ id: 11, url: 'https://named.example/', lastAccessed: 1 }] });
      return ext4.send({ id: msg.id, ok: true, result: msg });
    });
    await new Promise((r) => setTimeout(r, 100));
    const hvNamed = JSON.parse((await cli('health')).stdout);
    const namedSeat = hvNamed.profiles?.find((p) => p.id === 'named-test');
    assert(namedSeat?.name === 'oak-test', 'health carries the profile name from the WS handshake', JSON.stringify(hvNamed.profiles));
    const namedSnap = await cli('snap', 'named.example');
    assert(namedSnap.status === 0, 'named-profile seat routes a unique match', namedSnap.stdout + namedSnap.stderr);
    const feedNamed = (await fetch(`http://127.0.0.1:${PORT}/log`).then((r) => r.json())).lines;
    assert(feedNamed.some((a) => a.line.includes('snap named.example @oak-test')), 'feed: human-readable profile name replaces the uuid prefix', JSON.stringify(feedNamed.slice(-3)));
    // --profile takes the id prefix OR the exact profile name — the feed shows
    // names, so the name is what a human reaches for first (found live: the
    // v1.6.0 name tag taught a selector the id never would).
    const byName = await cli('--profile', 'oak-test', 'snap', 'named.example');
    assert(byName.status === 0 && byName.stdout.includes('"urlMatch":"named.example"'), 'multi-seat: --profile accepts the profile name as well as the id', byName.stdout + byName.stderr);
    ext4.socket.destroy();
    await new Promise((r) => setTimeout(r, 100));

    // an extension without probe support (pre-1.5.0) must fail routing loudly —
    // treating its ok:false probe reply as a dead seat silently bypassed the
    // ambiguity refusal and reported real tabs as nonexistent
    const ext3 = await wsClient(PORT, 'gamma-old');
    ext3.onMessage((msg) => {
      if (msg.type === 'ping') return ext3.send({ id: msg.id, ok: true, result: 'pong' });
      if (msg.type === 'probe') return ext3.send({ id: msg.id, ok: false, error: 'Error: unknown type "probe"' });
      if (msg.type === 'tabs') return ext3.send({ id: msg.id, ok: true, result: [] });
      return ext3.send({ id: msg.id, ok: true, result: msg });
    });
    await new Promise((r) => setTimeout(r, 100));
    const stale = await cli('snap', 'dupe.example');
    assert(stale.status !== 0 && stale.stderr.includes("can't be probed") && stale.stderr.includes('reload it at chrome://extensions'), 'multi-seat: unprobeable extension fails routing loudly', stale.stdout + stale.stderr);
    ext3.socket.destroy();
  }

  // watch runs for real against the live server — until now it was the only
  // command whose loop no check executed (a silent no-output regression kept
  // 122 checks green). Header + a recorded feed line must reach stdout, and
  // SIGTERM must end it.
  {
    const w = spawn('node', [`${ROOT}/cli.mjs`, 'watch'], { env });
    let out = '';
    w.stdout.on('data', (c) => (out += c));
    await new Promise((r) => setTimeout(r, 1200));
    w.kill('SIGTERM');
    await new Promise((r) => w.once('close', r));
    assert(out.includes('— watching (Ctrl-C to exit) —') && out.includes('example.com'), 'cli watch prints the feed header + recorded lines', out.slice(0, 300));
  }

  // extension disconnect → health flips (both fake profiles gone; ext2 leaves
  // via a proper WS close frame — the 0x8 path must stay covered, it once
  // crashed the server)
  ext2.socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0])); // masked close
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
  // stop with nothing running must SUCCEED — the agent-setup paste flow
  // (docs/agent-setup.md) and install.sh's `stop && start` run it as the
  // first command on fresh machines where nothing is up.
  const stop2 = await cli('stop');
  assert(stop2.status === 0 && stop2.stdout.includes('nothing was running'), 'cli stop with server down exits 0', stop2.stdout + stop2.stderr);
  // A command with the server down must fail cleanly through cmd()'s fetch
  // catch — and point at the DETACHED start, never a foreground server.mjs.
  const tDown = await cli('tabs');
  assert(
    tDown.status !== 0 && tDown.stderr.includes('not running') && tDown.stderr.includes('node cli.mjs start') && !tDown.stderr.includes('node server.mjs'),
    'cli tabs fails cleanly with the server down, advises cli start',
    tDown.stdout + tDown.stderr
  );
  const wDown = await cli('watch');
  assert(wDown.status !== 0 && wDown.stderr.includes('not running'), 'cli watch fails cleanly with the server down', wDown.stdout + wDown.stderr);
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
