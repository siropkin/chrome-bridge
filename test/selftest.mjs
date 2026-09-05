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
function cliRaw(args, input) {
  return new Promise((resolve) => {
    const p = spawn('node', [`${ROOT}/cli.mjs`, ...args], { env });
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
    // snap with scope 'trunc' answers a STRING (the real one does when the
    // tree truncates) — cli must echo the truncation line to stderr (it dies
    // in a `snap | grep` pipe otherwise) while stdout carries the tree.
    if (msg.type === 'snap' && msg.scope === 'trunc')
      return respond('tree line A\ntree line B\n… truncated at 300 nodes — scope with: snap <match> <css>');
    if (['snap', 'press', 'type', 'hover', 'net', 'click', 'fill', 'navigate', 'scroll', 'ask', 'upload', 'console', 'note', 'measure', 'grid', 'open', 'close', 'mark', 'release', 'unemulate', 'wait', 'emulate', 'resize', 'dialog', 'drag'].includes(msg.type)) return respond(msg); // echo for flag-parsing checks
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

  const press = await cli('press', 'example.com', 'Enter', '@e3');
  assert(press.status === 0 && press.stdout.includes('"key":"Enter"') && press.stdout.includes('"target":"@e3"'), 'cli press passes key+target', press.stdout + press.stderr);

  const typ = await cli('type', 'example.com', '@e2', 'hello', 'world');
  assert(typ.status === 0 && typ.stdout.includes('"value":"hello world"'), 'cli type joins text args', typ.stdout + typ.stderr);

  const hov = await cli('hover', 'example.com', '@e1');
  assert(hov.status === 0 && hov.stdout.includes('"target":"@e1"'), 'cli hover passes target', hov.stdout + hov.stderr);

  const netc = await cli('net', 'example.com', '--dur', '500', '--filter', '/api');
  assert(netc.status === 0 && netc.stdout.includes('"duration":500') && netc.stdout.includes('"filter":"/api"'), 'cli net flags', netc.stdout + netc.stderr);
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
  // A typoed flag must fail loudly — it used to be typed into the user's real form.
  const fillTypo = await cli('fill', 'example.com', '@e2', 'John', '--dfif');
  assert(fillTypo.status !== 0 && fillTypo.stderr.includes('unknown flag --dfif'), 'cli fill rejects a typoed flag instead of typing it', fillTypo.stdout + fillTypo.stderr);
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

  // measure/grid are real command types (their page-JS lives in the extension
  // with every other page script; ACT_VERBS carries the pill label)
  const meas = await cli('measure', 'example.com', '.btn');
  assert(meas.status === 0 && meas.stdout.includes('"type":"measure"') && meas.stdout.includes('"selector":".btn"'), 'cli measure sends its own type + selector', meas.stdout + meas.stderr);
  const gr = await cli('grid', 'example.com');
  assert(gr.status === 0 && gr.stdout.includes('"type":"grid"'), 'cli grid sends its own type', gr.stdout + gr.stderr);

  // Wire shapes for commands the suite never echoed before (open/close/mark/
  // release/unemulate/wait/emulate/resize + the new dialog/drag) — pins each
  // command's field names against renames.
  const waitEcho = await cli('wait', 'example.com', '--text', 'Saved', '--timeout', '500');
  assert(waitEcho.status === 0 && waitEcho.stdout.includes('"text":"Saved"') && waitEcho.stdout.includes('"timeout":500'), 'cli wait passes text+timeout', waitEcho.stdout + waitEcho.stderr);
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
    assert(bg.split('withCdp(').length === 8, 'ext: CDP handlers serialize per tab (helper + 6 wrap sites)');
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
    const CLI_LOCAL = ['batch', 'health', 'start', 'stop', 'watch', 'profiles', 'probe'];
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
  // A command with the server down must fail cleanly through cmd()'s fetch
  // catch — and point at the DETACHED start, never a foreground server.mjs.
  const tDown = await cli('tabs');
  assert(
    tDown.status !== 0 && tDown.stderr.includes('not running') && tDown.stderr.includes('node cli.mjs start') && !tDown.stderr.includes('node server.mjs'),
    'cli tabs fails cleanly with the server down, advises cli start',
    tDown.stdout + tDown.stderr
  );
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
