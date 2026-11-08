// Self-test: starts the server on a test port, connects a fake extension over
// WebSocket, and exercises the CLI end-to-end. Run: node test/selftest.mjs
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// A free ephemeral port per run, not a fixed one: with a fixed port two
// concurrent selftests (two agents, a pre-push hook beside a manual run)
// took each other's server down, and the loser failed at whatever check it
// had reached ("cli stop", "server did not boot") — a fake regression.
const PORT = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const ROOT = new URL('..', import.meta.url).pathname;
const diagnosticDirectory = fs.mkdtempSync(join(tmpdir(), 'bridge-selftest-'));
// Every file a run writes lives in its own scratch dir: fixed /tmp paths let
// two concurrent runs delete each other's files mid-test (an uncaught ENOENT,
// or an upload of a vanished file failing an unrelated check).
const scratch = fs.mkdtempSync(join(tmpdir(), 'bridge-selftest-run-'));
const scratchFile = (name) => join(scratch, name);
const env = { ...process.env, BRIDGE_PORT: String(PORT), BRIDGE_CMD_TIMEOUT_MS: '750', BRIDGE_DIAGNOSTICS_DIR: diagnosticDirectory, BRIDGE_DIAGNOSTICS_TEST: '1' };
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
function wsClient(port, id = 'alpha-test', name, install, vOverride, boot) {
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
        `GET /ws?v=${vOverride || MANIFEST_V}&id=${id}${name ? `&name=${name}` : ''}${install ? `&install=${install}` : ''}${boot ? `&boot=${boot}` : ''} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
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
  const diagnosticTests = spawnSync(process.execPath, ['--test', `${ROOT}/test/diagnostics.mjs`, `${ROOT}/test/background.mjs`, `${ROOT}/test/drift.mjs`, `${ROOT}/test/commands.mjs`], { encoding: 'utf8' });
  assert(diagnosticTests.status === 0, 'diagnostics: collector, popup, version-drift and command-grammar unit tests', diagnosticTests.stdout + diagnosticTests.stderr);
  // The version lives in TWO files (package.json, extension/manifest.json) and
  // nothing but this check compares them — the v1.6.0 eager-clear bug shipped
  // precisely because same-version drift was invisible everywhere else.
  assert(PKG_V === MANIFEST_V, 'drift: package.json version matches extension/manifest.json', `package.json ${PKG_V} vs manifest ${MANIFEST_V}`);

  // health before extension connects
  let h = await cli('health');
  assert(h.status !== 0 && JSON.parse(h.stdout).extension === false, 'health: extension false before connect — exit 1 (a disconnected bridge must not pass a `health && …` preflight)', h.stdout + h.stderr);

  // connect fake extension
  const ext = await wsClient(PORT, 'alpha-test');
  let lastShot = null;
  // A real 1x1 PNG — imgDims parses the IHDR header to print dimensions, so
  // the suite exercises the parse for real (a fake payload never did).
  const PNG1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'base64'
  );
  // Same bytes, IHDR rewritten to 1280x800 — a capture that hit the default --max cap.
  const PNG_WIDE = Buffer.from(PNG1x1);
  PNG_WIDE.writeUInt32BE(1280, 16);
  PNG_WIDE.writeUInt32BE(800, 20);
  ext.onMessage((msg) => {
    if (msg.type === 'diagnostics-result') return;
    const respond = (result) => ext.send({ id: msg.id, ok: true, result });
    if (msg.type === 'ping') return respond('pong');
    if (msg.type === 'timeout-test') return; // regression: server must label post-dispatch uncertainty
    if (msg.type === 'strip-test') return respond(Object.keys(msg).filter((k) => k.startsWith('_')).join(',') || 'clean');
    if (msg.type === 'tabs')
      return respond([{ id: 1, url: 'https://example.com/', title: 'Example', active: true, driven: false }]);
    // doctor: one residue row (grouped, not driven) + one stale memory id —
    // the cli's --fix then releases the row through the normal release path.
    if (msg.type === 'doctor')
      return respond({
        rows: [
          { id: 7, url: 'https://residue.example/', title: 'Residue', grouped: true, driven: false, status: '✅', emulated: false, debugger: false },
          { id: 8, url: 'https://busy.example/', title: 'Another session', grouped: true, driven: true, status: '⏳', emulated: true, debugger: true },
        ],
        stale: [999],
      });
    // no release reply: the generic echo fallback answers it (ok:true) — the
    // cli's --fix only checks for an error
    if (msg.type === 'probe')
      return respond(
        [{ id: 1, url: 'https://example.com/', lastAccessed: 1 }, { id: 2, url: 'https://dupe.example/a', lastAccessed: 2 }].filter((t) =>
          t.url.includes(msg.urlMatch)
        )
      );
    if (msg.type === 'eval') {
      if (msg.code.includes('probe:,') || msg.code === 'JSON.parse("{")') return ext.send({ id: msg.id, ok: false, error: "SyntaxError: Unexpected token ','" });
      // BIGEVAL: a >50K string result — the cli must cap the printout (the
      // last uncapped read was a context bomb: eval document.body.innerText).
      if (msg.code.includes('BIGEVAL')) return respond('y'.repeat(60_000));
      // PAGEERR: the reply carries new page errors — stderr only, stdout untouched.
      if (msg.code.includes('PAGEERR'))
        return ext.send({ id: msg.id, ok: true, result: 'clean-result', pageErrors: { count: 7, lines: ['error boom \x1b[31mred', 'pageerror TypeError: x is undefined'] } });
      return respond({ echo: msg.code.length, world: msg.world, match: msg.urlMatch, label: msg.label || null });
    }
    if (msg.type === 'big') return respond('x'.repeat(3 * 1024 * 1024)); // 3 MB — exercises 64-bit frames
    if (msg.type === 'shot') {
      lastShot = msg;
      // --diff returns the {note, data} shape the CLI writes to the file
      // (crop on change, full capture on baseline/no-change).
      if (msg.diff) return respond({ note: 'diff: 2.1% of pixels changed — the saved file is the changed region', data: 'data:image/png;base64,' + PNG1x1.toString('base64') });
      if (msg.urlMatch === 'wide.example') return respond('data:image/png;base64,' + PNG_WIDE.toString('base64'));
      return respond('data:image/png;base64,' + PNG1x1.toString('base64'));
    }
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
    // scope 'empty' answers the empty string the real extension returns on a
    // still-loading page — cli must fail loud, not print nothing with exit 0 (#60).
    if (msg.type === 'snap' && msg.scope === 'empty') return respond('');
    // scope 'layer': a modal appended past the cut — cli echoes it to stderr too.
    if (msg.type === 'snap' && msg.scope === 'layer')
      return respond('tree line A\n… truncated at 300 nodes\n(modal layer past the cut — shown anyway; drill: snap <match> @ref)\ndialog @e9 modal\n  button "Accept all" @e10');
    if (['snap', 'press', 'type', 'hover', 'net', 'perf', 'click', 'fill', 'paste', 'navigate', 'scroll', 'ask', 'upload', 'console', 'note', 'measure', 'grid', 'open', 'close', 'mark', 'release', 'activate', 'unemulate', 'wait', 'emulate', 'resize', 'dialog', 'drag', 'clear'].includes(msg.type)) return respond(msg); // echo for flag-parsing checks
    return respond(null);
  });
  await new Promise((r) => setTimeout(r, 100));

  h = await cli('health');
  assert(JSON.parse(h.stdout).extension === true, 'health: extension true after connect');
  {
    const configure = (body, headers = {}) => fetch(`http://127.0.0.1:${PORT}/diagnostics`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert(JSON.parse(h.stdout).diagnostics.enabled === false, 'diagnostics: off by default');
    const popupRequest = (action, extra = {}) => new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => reject(new Error('popup settings timed out')), 2000);
      ext.onMessage((msg) => {
        if (msg.type === 'diagnostics-result' && msg.requestId === requestId) {
          clearTimeout(timer);
          resolve(msg);
        }
      });
      ext.send({ type: 'diagnostics', requestId, action, ...extra });
    });
    assert((await popupRequest('status')).result.enabled === false, 'diagnostics: popup reads server settings over its existing socket');
    assert(!(await popupRequest('configure', { enabled: true, limitMiB: 101 })).ok, 'diagnostics: popup rejects invalid limits');
    assert((await popupRequest('configure', { enabled: true, limitMiB: 1 })).ok, 'diagnostics: popup can opt in');
    await popupRequest('clear');
    await popupRequest('configure', { enabled: false, limitMiB: 1 });
    assert((await configure({ action: 'configure', enabled: true, limitMiB: 1 }, { origin: 'https://evil.example' })).status === 403, 'diagnostics: web pages cannot enable logging');
    assert((await (await configure({ action: 'configure', enabled: true, limitMiB: 1 })).json()).ok, 'diagnostics: explicit local opt-in');
    await cli('tabs');
    const events = fs.readFileSync(join(diagnosticDirectory, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const started = events.find((event) => event.event === 'command_start');
    const finished = events.find((event) => event.event === 'command_finish');
    assert(started.command.name === 'tabs' && finished.id === started.id && finished.outcome.ok && started.caller.test, 'diagnostics: correlated command outcome and test label');
    const completed = events.find((event) => event.event === 'cli_finish');
    assert(completed?.caller.invocation === started.caller.invocation, 'diagnostics: CLI and server share an invocation');
    const invalid = await cli('click');
    const latest = fs.readFileSync(join(diagnosticDirectory, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
    assert(invalid.status === 1 && latest.event === 'cli_finish' && latest.command.name === 'click' && latest.outcome.errorCode === 'invalid_arguments', 'diagnostics: CLI validation failures are recorded');
    await configure({ action: 'configure', enabled: false, limitMiB: 1 });
    const bytes = fs.statSync(join(diagnosticDirectory, 'events.jsonl')).size;
    await cli('tabs');
    assert(fs.statSync(join(diagnosticDirectory, 'events.jsonl')).size === bytes, 'diagnostics: disabling stops recording');
    await configure({ action: 'clear' });
    assert(!fs.existsSync(join(diagnosticDirectory, 'events.jsonl')), 'diagnostics: clear removes records');
  }
  {
    const hv = JSON.parse(h.stdout);
    assert(hv.profiles?.length === 1 && hv.profiles[0].id === 'alpha-test' && hv.profiles[0].v === MANIFEST_V, 'health reports connected profiles + versions from the WS handshake', h.stdout);
    // `<repo>` discovery: a running server names the checkout it runs from —
    // the agent asks the bridge instead of guessing ~/chrome-bridge vs npm.
    assert(typeof hv.repo === 'string' && fs.existsSync(join(hv.repo, 'cli.mjs')), 'health names the repo it runs from (repo field)', h.stdout);
  }

  // Stale-skill warning: a copied (non-symlink) ~/.claude/skills/chrome-bridge
  // whose SKILL.md differs from the repo's goes stale on every pull — health
  // warns on stderr (exit code unchanged); a symlinked install tracks the
  // repo and stays quiet.
  {
    const home = fs.mkdtempSync(scratchFile('chrome-bridge-selftest-home-'));
    const sdir = join(home, '.claude', 'skills', 'chrome-bridge');
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(join(sdir, 'SKILL.md'), 'a stale copied skill');
    const stale = await cliRaw(['health'], null, { HOME: home });
    assert(stale.status === 0 && stale.stderr.includes('the installed Claude Code skill'), 'health: a stale copied skill warns on stderr', stale.stderr);
    // A copy whose SKILL.md is current but whose reference/ files are missing is stale too.
    fs.copyFileSync(`${ROOT}.claude/skills/chrome-bridge/SKILL.md`, join(sdir, 'SKILL.md'));
    const staleRef = await cliRaw(['health'], null, { HOME: home });
    assert(staleRef.stderr.includes('the installed Claude Code skill'), 'health: a copied skill missing reference/ files warns', staleRef.stderr);
    fs.rmSync(sdir, { recursive: true, force: true });
    fs.symlinkSync(`${ROOT}.claude/skills/chrome-bridge`, sdir);
    const linked = await cliRaw(['health'], null, { HOME: home });
    assert(linked.status === 0 && !linked.stderr.includes('the installed Claude Code skill'), 'health: a symlinked skill stays quiet', linked.stderr);
    fs.rmSync(home, { recursive: true, force: true });
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

  // The relay accepted this frame, but the extension never replied. A bare
  // "extension timeout" invites a blind retry of a click/fill that may already
  // have landed; the response must state the post-dispatch uncertainty.
  const timeoutReply = await fetch(`http://127.0.0.1:${PORT}/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'timeout-test', urlMatch: 'example.com' }),
  }).then((r) => r.json());
  assert(
    timeoutReply.ok === false && /timeout after dispatch.*may have run.*inspect the tab or history/i.test(timeoutReply.error),
    'server: post-dispatch timeout warns that the command may have run',
    JSON.stringify(timeoutReply)
  );

  // Client-supplied internal fields (_tabId/_pill) must never reach the
  // extension: the refusal's "no marking, no bookkeeping" guarantee and the
  // per-tab inflight counters both trust them to be extension-set.
  const stripReply = await fetch(`http://127.0.0.1:${PORT}/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'strip-test', urlMatch: 'example.com', _tabId: 999, _pill: true }),
  }).then((r) => r.json());
  assert(stripReply.ok === true && stripReply.result === 'clean', 'server: /cmd strips client-supplied underscore-internal fields', JSON.stringify(stripReply));

  const shotPath = scratchFile('chrome-bridge-selftest.png');
  const shot = await cli('shot', 'example.com', shotPath);
  assert(shot.status === 0 && fs.readFileSync(shotPath).equals(PNG1x1) && shot.stdout.includes(', 1x1'), 'cli shot writes file + prints parsed dimensions', shot.stdout + shot.stderr);

  // A default shot that hit the 1280 cap reminds the agent that human-facing shots need --max 0.
  assert(!shot.stderr.includes('--max 0'), 'cli shot: no cap reminder below the cap', shot.stderr);
  const shotWide = await cli('shot', 'wide.example', shotPath);
  assert(shotWide.status === 0 && shotWide.stdout.includes(', 1280x800') && shotWide.stderr.includes('re-run with --max 0'), 'cli shot: default cap hit prints the --max 0 reminder on stderr', shotWide.stdout + shotWide.stderr);
  const shotWideMax = await cli('shot', 'wide.example', shotPath, '--max', '1280');
  assert(shotWideMax.status === 0 && !shotWideMax.stderr.includes('--max 0'), 'cli shot: an explicit --max stays quiet', shotWideMax.stderr);
  const nestedShot = scratchFile('nested-shot/nested/out.png');
  const shotNested = await cli('shot', 'example.com', nestedShot);
  assert(shotNested.status === 0 && fs.existsSync(nestedShot), 'cli shot creates a missing output folder', shotNested.stdout + shotNested.stderr);
  fs.rmSync(scratchFile('nested-shot'), { recursive: true, force: true });

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
  const layer = await cli('snap', 'example.com', 'layer');
  assert(
    layer.status === 0 && layer.stdout.includes('Accept all') && layer.stderr.includes('(modal layer past the cut') && layer.stderr.includes('dialog @e9 modal') && !layer.stderr.includes('Accept all'),
    'cli snap echoes a past-the-cut modal layer (header + its line) to stderr',
    layer.stdout + layer.stderr
  );

  // Empty tree (still-loading page): exit non-zero with guidance — a silent
  // empty stdout read as "empty page" to scripts (#60).
  const emptySnap = await cli('snap', 'example.com', 'empty');
  assert(
    emptySnap.status !== 0 && emptySnap.stderr.includes('empty tree') && !emptySnap.stdout.trim(),
    'cli snap on an empty tree fails loud instead of printing nothing',
    emptySnap.stdout + emptySnap.stderr
  );

  const shotMax = await cli('shot', 'example.com', shotPath, '--max', '800');
  assert(shotMax.status === 0 && lastShot?.max === 800, 'cli shot --max parses and reaches the extension', shotMax.stderr + JSON.stringify(lastShot));
  fs.unlinkSync(shotPath);

  // shot --diff: the {note, data} result — the note explains the file, the
  // CLI writes the (cropped) image and prints the dims of what it wrote.
  const shotDiffPath = scratchFile('chrome-bridge-selftest-diff.png');
  const shotDiff = await cli('shot', 'example.com', shotDiffPath, '--diff');
  assert(
    shotDiff.status === 0 && fs.readFileSync(shotDiffPath).equals(PNG1x1) && shotDiff.stdout.includes('changed region') && shotDiff.stdout.includes('saved '),
    'cli shot --diff writes the returned image and prints the note',
    shotDiff.stdout + shotDiff.stderr
  );
  fs.unlinkSync(shotDiffPath);
  const shotDiffExcl = await cli('shot', 'example.com', shotDiffPath, '--diff', '--full');
  assert(shotDiffExcl.status !== 0 && shotDiffExcl.stderr.includes('--diff is exclusive'), 'cli shot --diff is exclusive with --full/--crop', shotDiffExcl.stdout + shotDiffExcl.stderr);

  // wait --pixel-change: rides as a predicate-less mode like --human
  const waitPix = await cli('wait', 'example.com', '--pixel-change', '--timeout', '500');
  assert(waitPix.status === 0 && waitPix.stdout.includes('"pixel":true') && waitPix.stdout.includes('"timeout":500'), 'cli wait --pixel-change rides with --timeout', waitPix.stdout + waitPix.stderr);
  const waitPixMix = await cli('wait', 'example.com', '--pixel-change', '--text', 'x');
  assert(waitPixMix.status !== 0 && waitPixMix.stderr.includes('usage: wait'), 'cli wait --pixel-change is exclusive with --text/selector', waitPixMix.stdout + waitPixMix.stderr);

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
  // ref-first — the act-by-ref order of every other verb — used to send the
  // key as the selector ('element not found: Control+k', e2e run)
  const pressRefFirst = await cli('press', 'example.com', '@e3', 'Control+k', '--diff');
  assert(
    pressRefFirst.status === 0 && pressRefFirst.stdout.includes('"key":"Control+k"') && pressRefFirst.stdout.includes('"target":"@e3"'),
    'cli press accepts the ref before the key',
    pressRefFirst.stdout + pressRefFirst.stderr
  );

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
  const harPath = scratchFile('chrome-bridge-selftest.har');
  const netHar = await cli('net', 'example.com', '--dur', '500', '--har', harPath);
  assert(
    netHar.status === 0 && netHar.stdout.includes('GET 200 /x') && fs.readFileSync(harPath, 'utf8').includes('"version": "1.2"') && netHar.stderr.includes('HAR 1.2, 1 entries'),
    'cli net --har writes the HAR file and prints the lines',
    netHar.stdout + netHar.stderr
  );
  // A HAR from a logged-in tab is a credential bundle (Cookie/Authorization/
  // Set-Cookie + bodies): owner-only perms like server.log, and the warning
  // says so (DevTools itself warns on HAR export).
  assert(
    (fs.statSync(harPath).mode & 0o777) === 0o600 && netHar.stderr.includes('cookies/tokens'),
    'cli net --har writes owner-only 0600 and warns about cookies/tokens',
    netHar.stderr + ' mode=' + (fs.statSync(harPath).mode & 0o777).toString(8)
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
  const navTypo = await cli('nav', 'example.com', 'https://example.org/x', '--dfif');
  assert(navTypo.status !== 0 && navTypo.stderr.includes('unknown flag --dfif'), 'cli nav rejects an unknown flag before routing', navTypo.stdout + navTypo.stderr);

  // Extra positionals must fail loud — `click <m> "#list" @e3` used to click
  // #list and silently drop the ref (#59); the same hole ate extras on
  // close/clear/scroll/drag. press keeps its optional [@ref] (max 3).
  const clickExtra = await cli('click', 'example.com', '#list', '@e3');
  assert(clickExtra.status !== 0 && clickExtra.stderr.includes("unexpected extra argument '@e3'"), 'cli click rejects an extra positional instead of dropping it', clickExtra.stdout + clickExtra.stderr);
  const closeExtra = await cli('close', 'example.com', 'example.org');
  assert(closeExtra.status !== 0 && closeExtra.stderr.includes('unexpected extra argument'), 'cli close rejects an extra positional', closeExtra.stdout + closeExtra.stderr);
  const pressExtra = await cli('press', 'example.com', 'Enter', '@e3', 'x');
  assert(pressExtra.status !== 0 && pressExtra.stderr.includes('unexpected extra argument'), 'cli press rejects a second target', pressExtra.stdout + pressExtra.stderr);
  const pressOk = await cli('press', 'example.com', 'Enter', '@e3');
  assert(pressOk.status === 0 && pressOk.stdout.includes('"target":"@e3"'), 'cli press keeps its optional target', pressOk.stdout + pressOk.stderr);

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
  const upTypo = await cli('upload', 'example.com', '@e5', '--dfif');
  assert(upTypo.status !== 0 && upTypo.stderr.includes('unknown flag --dfif'), 'cli upload rejects an unknown flag before treating it as a file', upTypo.stdout + upTypo.stderr);
  const upNoArgs = await cli('upload', 'example.com');
  assert(upNoArgs.status !== 0 && upNoArgs.stderr.includes('usage: upload'), 'cli upload usage error', upNoArgs.stdout + upNoArgs.stderr);

  const conAsk = await cli('console', 'example.com', '--ask', 'what', 'broke?');
  assert(conAsk.status === 0 && conAsk.stdout.includes('"ask":"what broke?"'), 'cli console --ask joins question', conAsk.stdout + conAsk.stderr);
  const conAskBare = await cli('console', 'example.com', '--ask');
  assert(conAskBare.status === 0 && conAskBare.stdout.includes('"ask":true'), 'cli console bare --ask sends true', conAskBare.stdout + conAskBare.stderr);
  const conPlain = await cli('console', 'example.com');
  assert(conPlain.status === 0 && !conPlain.stdout.includes('"ask"'), 'cli console plain sends no ask', conPlain.stdout + conPlain.stderr);
  const conTypo = await cli('console', 'example.com', '--clr');
  assert(conTypo.status !== 0 && conTypo.stderr.includes('unknown argument --clr'), 'cli console rejects a typoed flag instead of running uncleared', conTypo.stdout + conTypo.stderr);
  const conExtra = await cli('console', 'example.com', 'extra');
  assert(conExtra.status !== 0 && conExtra.stderr.includes('unknown argument extra'), 'cli console rejects a stray positional', conExtra.stdout + conExtra.stderr);

  // snap's stray-flag scan: a typoed --dfif used to return a FULL snap the
  // agent then read as a diff — the unsafe-success class takeFlags exists for.
  const snapTypo = await cli('snap', 'example.com', '--dfif');
  assert(snapTypo.status !== 0 && snapTypo.stderr.includes('unknown flag --dfif'), 'cli snap rejects an unknown flag (no silent full-snap-as-diff)', snapTypo.stdout + snapTypo.stderr);
  const snapFindDash = await cli('snap', 'example.com', '--find', 'the', '--recursive', 'flag');
  assert(snapFindDash.status === 0 && snapFindDash.stdout.includes('"find":"the --recursive flag"'), 'cli snap --find keeps flag-like query words (no silent drop)', snapFindDash.stdout + snapFindDash.stderr);
  const snapFindDiff = await cli('snap', 'example.com', '--find', 'cancel', '--diff');
  assert(snapFindDiff.status === 0 && snapFindDiff.stdout.includes('"find":"cancel"') && snapFindDiff.stdout.includes('"diff":true'), 'cli snap --find + --diff: known flags after the query still apply', snapFindDiff.stdout + snapFindDiff.stderr);

  // wait: --text takes every word up to the next flag (the single-token read
  // OR'd leftovers in as a selector — a false "page ready" signal); selector
  // and --text are alternatives, and --human/--pixel-change don't combine.
  const waitText = await cli('wait', 'example.com', '--text', 'Saved', 'successfully');
  assert(waitText.status === 0 && waitText.stdout.includes('"text":"Saved successfully"') && !waitText.stdout.includes('"selector":".'), 'cli wait --text joins multi-word text', waitText.stdout + waitText.stderr);
  const waitBoth = await cli('wait', 'example.com', '.foo', '--text', 'Saved');
  assert(waitBoth.status !== 0 && waitBoth.stderr.includes('selector OR --text'), 'cli wait refuses selector + --text together', waitBoth.stdout + waitBoth.stderr);
  const waitHuPix = await cli('wait', 'example.com', '--human', '--pixel-change');
  assert(waitHuPix.status !== 0 && waitHuPix.stderr.includes('--human OR --pixel-change'), 'cli wait refuses --human + --pixel-change', waitHuPix.stdout + waitHuPix.stderr);
  const waitNoText = await cli('wait', 'example.com', '.foo', '--text');
  assert(waitNoText.status !== 0 && waitNoText.stderr.includes('--text needs a value'), 'cli wait --text without a value fails loud', waitNoText.stdout + waitNoText.stderr);
  const waitTextTimeout = await cli('wait', 'example.com', '--text', 'a', 'b', '--timeout', '500');
  assert(waitTextTimeout.status === 0 && waitTextTimeout.stdout.includes('"text":"a b"') && waitTextTimeout.stdout.includes('"timeout":500'), 'cli wait --text joins up to the next known flag', waitTextTimeout.stdout + waitTextTimeout.stderr);
  // wait --js: a polled page expression — its own mode, --world rides only with it.
  const waitJs = await cli('wait', 'example.com', '--js', "document.querySelectorAll('.row').length", '>', '2;', '--world', 'main', '--timeout', '500');
  assert(
    waitJs.status === 0 && waitJs.stdout.includes('"js":"document.querySelectorAll(\'.row\').length > 2"') && waitJs.stdout.includes('"world":"MAIN"') && waitJs.stdout.includes('"timeout":500'),
    'cli wait --js joins the expression, strips a trailing semicolon, carries --world',
    waitJs.stdout + waitJs.stderr
  );
  const waitJsDash = await cli('wait', 'example.com', '--js', 'x--', '>', '0');
  assert(waitJsDash.status === 0 && waitJsDash.stdout.includes('"js":"x-- > 0"'), 'cli wait --js keeps --leading code tokens', waitJsDash.stdout + waitJsDash.stderr);
  const waitJsStdin = await cliStdin('window.app?.ready', 'wait', 'example.com', '--js', '-');
  assert(waitJsStdin.status === 0 && waitJsStdin.stdout.includes('"js":"window.app?.ready"'), 'cli wait --js - reads the expression from stdin', waitJsStdin.stdout + waitJsStdin.stderr);
  const waitJsMix = await cli('wait', 'example.com', '.foo', '--js', 'true');
  assert(waitJsMix.status !== 0 && waitJsMix.stderr.includes('--js is its own wait mode'), 'cli wait --js refuses a selector alongside', waitJsMix.stdout + waitJsMix.stderr);
  const waitWorldNoJs = await cli('wait', 'example.com', '.foo', '--world', 'main');
  assert(waitWorldNoJs.status !== 0 && waitWorldNoJs.stderr.includes('--world applies to --js only'), 'cli wait --world needs --js', waitWorldNoJs.stdout + waitWorldNoJs.stderr);
  const waitJsStmt = await cli('wait', 'example.com', '--js', 'const a = 1; a');
  assert(waitJsStmt.status !== 0 && waitJsStmt.stderr.includes('ONE expression') && !waitJsStmt.stderr.includes('const a'), 'cli wait --js: statements fail locally with the IIFE hint, code not echoed', waitJsStmt.stdout + waitJsStmt.stderr);
  const waitJsEmpty = await cli('wait', 'example.com', '--js');
  assert(waitJsEmpty.status !== 0 && waitJsEmpty.stderr.includes('--js needs an expression'), 'cli wait --js without a value fails loud', waitJsEmpty.stdout + waitJsEmpty.stderr);

  // Page errors ride the reply envelope: stderr gets the count + lines (control
  // chars stripped), stdout stays the command's own result.
  const pageErr = await cli('eval', 'example.com', 'PAGEERR');
  assert(
    pageErr.status === 0 && pageErr.stdout.trim() === 'clean-result' && pageErr.stderr.includes('⚠ 7 new page errors since the last command (newest 2)') && pageErr.stderr.includes('pageerror TypeError: x is undefined') && !pageErr.stderr.includes('\x1b'),
    'cli prints page errors to stderr, sanitized, stdout untouched',
    pageErr.stdout + pageErr.stderr
  );

  // tabs id:<tabId>: the exact reference every command takes must filter the
  // list too — [] for a live tab read as "gone, re-open it".
  const tabsId = await cli('tabs', 'id:1');
  assert(tabsId.status === 0 && tabsId.stdout.includes('example.com'), 'cli tabs id:<tabId> finds the live tab', tabsId.stdout + tabsId.stderr);
  const tabsIdGone = await cli('tabs', 'id:424242');
  assert(tabsIdGone.status === 0 && tabsIdGone.stdout.trim() === '[]', 'cli tabs id: for a dead id prints [] (truthful, not a substring miss)', tabsIdGone.stdout);
  const tabsExtra = await cli('tabs', 'a', 'b');
  assert(tabsExtra.status !== 0 && tabsExtra.stderr.includes('usage: tabs'), 'cli tabs rejects extra positionals (silent wrong-filter class)', tabsExtra.stdout + tabsExtra.stderr);

  // Positional-only commands fail loud on extras, same as flag commands.
  const openExtra = await cli('open', 'https://example.com', 'extra');
  assert(openExtra.status !== 0 && openExtra.stderr.includes('usage: open'), 'cli open rejects extra args', openExtra.stdout + openExtra.stderr);
  const markExtra = await cli('mark', 'example.com', 'extra');
  assert(markExtra.status !== 0 && markExtra.stderr.includes('usage: mark'), 'cli mark rejects extra args', markExtra.stdout + markExtra.stderr);

  // eval output cap: 60K in, 50K + a named-remedy note out.
  const evBig = await cli('eval', 'example.com', 'BIGEVAL');
  assert(evBig.status === 0 && evBig.stdout.length < 51000 && evBig.stdout.includes('truncated at 50000 chars'), 'cli eval caps huge output with a truncation note', `len=${evBig.stdout.length}`);
  const evSmall = await cli('eval', 'example.com', 'document.title');
  assert(evSmall.status === 0 && !evSmall.stdout.includes('truncated'), 'cli eval small output passes through uncapped', evSmall.stdout + evSmall.stderr);

  // start on a running bridge names the extension state, like the fresh path.
  const startUp = await cli('start');
  assert(startUp.status === 0 && startUp.stdout.includes('already running — extension connected'), 'cli start already-running reports extension state', startUp.stdout + startUp.stderr);

  const evWorld = await cli('eval', '--world', 'main', 'example.com', 'document.title');
  assert(evWorld.status === 0 && evWorld.stdout.includes('"world":"MAIN"') && evWorld.stdout.includes('"match":"example.com"'), 'cli eval --world before match parses', evWorld.stdout + evWorld.stderr);

  const evWorldBad = await cli('eval', 'example.com', 'document.title', '--world', 'mian');
  assert(evWorldBad.status !== 0 && evWorldBad.stderr.includes('--world'), 'cli eval rejects invalid --world value', evWorldBad.stdout + evWorldBad.stderr);
  for (const argv of [['eval', 'example.com', '1', '--world', 'isolated'], ['wait', 'example.com', '--js', '1', '--world', 'isolated']]) {
    const r = await cli(...argv);
    assert(r.status !== 0 && r.stderr.includes('--world isolated was removed') && r.stderr.includes('drop --world'), `cli ${argv[0]} --world isolated is refused with the removal + next step (MV3 can't eval there)`, r.stdout + r.stderr);
  }
  const evSyntax = await cli('eval', 'example.com', '(()=>{return ({probe:, fn:()=>.click()})})()');
  assert(evSyntax.status === 1 && /line 1, column \d+/.test(evSyntax.stderr) && evSyntax.stderr.includes('stdin') && evSyntax.stderr.includes('before retrying') && !evSyntax.stderr.includes('probe:,'), 'cli eval: malformed JavaScript gets a location and repair guidance without echoing code', evSyntax.stderr);
  const evMultilineSyntax = await cliStdin('const privateValue = "do-not-print";\n({probe:,})', 'eval', 'example.com', '-');
  assert(evMultilineSyntax.status === 1 && evMultilineSyntax.stderr.includes('line 2, column') && !evMultilineSyntax.stderr.includes('do-not-print'), 'cli eval: stdin syntax hints locate multiline errors without echoing input', evMultilineSyntax.stderr);
  const evRuntimeSyntax = await cli('eval', 'example.com', 'JSON.parse("{")');
  assert(evRuntimeSyntax.status === 1 && evRuntimeSyntax.stderr.includes('SyntaxError') && !evRuntimeSyntax.stderr.includes('Local syntax check'), 'cli eval: runtime parsing errors are not mislabeled as malformed input', evRuntimeSyntax.stderr);

  // large frame extension→server (3 MB result)
  const bigRes = await fetch(`http://127.0.0.1:${PORT}/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'big' }),
  });
  const big = await bigRes.json();
  assert(big.ok && big.result.length === 3 * 1024 * 1024, 'server: 3MB frame round-trip');

  // Local requests are a control boundary too: reject an oversized command
  // before buffering/parsing it, then prove the live extension seat survived.
  const tooLarge = await fetch(`http://127.0.0.1:${PORT}/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'ping', padding: 'x'.repeat(2 * 1024 * 1024) }),
  });
  assert(tooLarge.status === 413, 'server: oversized command body rejected', 'got ' + tooLarge.status);
  const chunkedTooLarge = await new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: '/cmd', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    r.on('error', () => resolve(0));
    // Multiple write()s force chunked framing — a single end(body) lets Node
    // auto-set Content-Length, which would only re-test the header path above.
    r.write('{"type":"ping","padding":"');
    for (let i = 0; i < 32; i++) r.write('x'.repeat(72 * 1024)); // 2.25MB in 32 chunks
    r.end('"}');
  });
  assert(chunkedTooLarge === 413, 'server: oversized chunked command body rejected', 'got ' + chunkedTooLarge);
  h = await cli('health');
  assert(JSON.parse(h.stdout).extension === true, 'server survives oversized command body');

  const nt = await cli('note', 'example.com', 'saving', 'the', 'draft');
  assert(nt.status === 0 && nt.stdout.includes('"text":"saving the draft"'), 'cli note joins text args', nt.stdout + nt.stderr);
  const ntNoArgs = await cli('note', 'example.com');
  assert(ntNoArgs.status !== 0 && ntNoArgs.stderr.includes('usage: note'), 'cli note usage error', ntNoArgs.stdout + ntNoArgs.stderr);

  // fetch: result shape processed CLI-side — --out writes the body (base64
  // decoded for binary), text prints to stdout, binary without --out fails
  // with the hint.
  const fetchText = await cli('fetch', 'example.com', 'https://api.example.com/data');
  assert(fetchText.status === 0 && fetchText.stdout.includes('application/json') && fetchText.stdout.includes('{"a":1}'), 'cli fetch prints status + text body', fetchText.stdout + fetchText.stderr);
  const fetchOut = await cli('fetch', 'example.com', 'https://api.example.com/data', '--out', scratchFile('chrome-bridge-selftest.json'));
  assert(fetchOut.status === 0 && fs.readFileSync(scratchFile('chrome-bridge-selftest.json'), 'utf8') === '{"a":1}' && fetchOut.stdout.includes('saved'), 'cli fetch --out writes the body', fetchOut.stdout + fetchOut.stderr);
  fs.unlinkSync(scratchFile('chrome-bridge-selftest.json'));
  const fetchBin = await cli('fetch', 'example.com', 'https://binary.example/doc', '--out', scratchFile('chrome-bridge-selftest.bin'));
  assert(fetchBin.status === 0 && fs.readFileSync(scratchFile('chrome-bridge-selftest.bin')).equals(Buffer.from('PDFBYTES')), 'cli fetch --out decodes binary bodies', fetchBin.stdout + fetchBin.stderr);
  fs.unlinkSync(scratchFile('chrome-bridge-selftest.bin'));
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
  const perf = await cli('perf', 'example.com', '--dur', '2000');
  assert(perf.status === 0 && perf.stdout.includes('"type":"perf"') && perf.stdout.includes('"duration":2000'), 'cli perf sends its type + --dur', perf.stdout + perf.stderr);
  const perfCap = await cli('perf', 'example.com', '--dur', '60000');
  assert(perfCap.status !== 0 && perfCap.stderr.includes('--dur max is 30000'), 'cli perf rejects --dur above the 30s cap', perfCap.stdout + perfCap.stderr);
  const perfTypo = await cli('perf', 'example.com', '--during', '5');
  assert(perfTypo.status !== 0 && perfTypo.stderr.includes('unknown flag'), 'cli perf rejects unknown flags', perfTypo.stdout + perfTypo.stderr);

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
  const dlgTextBare = await cli('dialog', 'example.com', 'accept', '--text');
  assert(dlgTextBare.status !== 0 && dlgTextBare.stderr.includes('--text needs an answer'), 'cli dialog rejects a missing --text answer', dlgTextBare.stdout + dlgTextBare.stderr);
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
  const emuExtra = await cli('emulate', 'example.com', '375', '667', 'tablet');
  assert(emuExtra.status !== 0 && emuExtra.stderr.includes('usage: emulate'), 'cli emulate rejects an unknown mode instead of ignoring it', emuExtra.stdout + emuExtra.stderr);
  const emuDsf = await cli('emulate', 'example.com', '1280', '800', 'dsf=2');
  assert(emuDsf.status === 0 && emuDsf.stdout.includes('"dsf":2') && !emuDsf.stdout.includes('"mobile":true'), 'cli emulate dsf=N wire shape', emuDsf.stdout + emuDsf.stderr);
  const emuBadDsf = await cli('emulate', 'example.com', '1280', '800', 'dsf=abc');
  assert(emuBadDsf.status !== 0 && (emuBadDsf.stderr.includes('usage: emulate') || emuBadDsf.stderr.includes('dsf')), 'cli emulate rejects a non-numeric dsf', emuBadDsf.stdout + emuBadDsf.stderr);
  // mobile + dsf=N together (a 3x phone) — live logs showed agents refused here.
  const emuBoth = await cli('emulate', 'example.com', '390', '844', 'mobile', 'dsf=3');
  assert(emuBoth.status === 0 && emuBoth.stdout.includes('"mobile":true') && emuBoth.stdout.includes('"dsf":3'), 'cli emulate mobile dsf=N combine', emuBoth.stdout + emuBoth.stderr);
  const emuDup = await cli('emulate', 'example.com', '390', '844', 'dsf=2', 'dsf=3');
  assert(emuDup.status !== 0 && emuDup.stderr.includes('usage: emulate'), 'cli emulate rejects a repeated mode', emuDup.stdout + emuDup.stderr);
  const rszExtra = await cli('resize', 'example.com', '800', '600', 'mobile');
  assert(rszExtra.status !== 0 && rszExtra.stderr.includes('usage: resize'), 'cli resize takes no mode', rszExtra.stdout + rszExtra.stderr);
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
  const histPath = scratchFile('chrome-bridge-selftest.batch');
  const histExport = await cli('history', 'example.com', '--batch', histPath);
  const histScript = fs.readFileSync(histPath, 'utf8');
  assert(
    histExport.status === 0 &&
      histScript.includes('# secret · fill example.com @e2 --diff -- "***"') &&
      histScript.includes('# secret · dialog example.com dismiss --text "***"') &&
      histScript.includes('# secret · upload example.com @e5 "***" --diff') &&
      !histScript.includes('clipboard text') &&
      !histScript.includes('explicit paste text') &&
      !histScript.includes('no thanks') &&
      !histScript.includes(`${ROOT}package.json`) &&
      histScript.includes('eval example.com document.title'),
    'cli history --batch omits typed, pasted, dialog, clipboard, and upload-path secrets',
    histExport.stdout + '\n' + histScript
  );
  fs.unlinkSync(histPath);

  // History output is a batch file, so its quoting must round-trip hostile
  // but valid page text. The old single-regex parser broke here when a field
  // contained both quote types (and a backslash), silently changing a replay.
  const quoted = `both 'quotes' and "double" \\ slash`;
  const quoteNote = await cli('note', quoted, quoted);
  const quotePath = scratchFile('chrome-bridge-selftest-quoted.batch');
  const quoteExport = await cli('history', quoted, '--batch', quotePath);
  const quoteReplay = await cliStdin(fs.readFileSync(quotePath, 'utf8'), 'batch');
  let replayed;
  try { replayed = JSON.parse(quoteReplay.stdout); } catch {}
  assert(
    quoteNote.status === 0 && quoteExport.status === 0 && replayed?.urlMatch === quoted && replayed?.text === quoted,
    'history --batch round-trips both quote types and backslashes',
    quoteExport.stdout + '\n' + fs.readFileSync(quotePath, 'utf8') + '\n' + quoteReplay.stdout + quoteReplay.stderr
  );
  fs.unlinkSync(quotePath);

  const helpFlag = await cli('--help');
  assert(helpFlag.status === 0 && helpFlag.stdout.includes('chrome-bridge CLI'), 'cli --help prints usage, exit 0', helpFlag.stdout + helpFlag.stderr);
  const unknown = await cli('nope');
  assert(unknown.status !== 0 && unknown.stderr.includes('unknown command'), 'cli unknown command fails', unknown.stdout + unknown.stderr);

  // Stress-fix tripwires: selftest drives a FAKE extension, so the service
  // worker's own guards can't be executed here — assert them at source level.
  {
    const bg = fs.readFileSync(`${ROOT}extension/background.js`, 'utf8');
    // The CLI's grammar spans two files: cli.mjs and the shared command module.
    const cmdSrc = fs.readFileSync(`${ROOT}extension/commands.js`, 'utf8');
    const cliSrc = fs.readFileSync(`${ROOT}cli.mjs`, 'utf8') + cmdSrc;
    const serverSrc = fs.readFileSync(`${ROOT}/server.mjs`, 'utf8');
    // CDP debugger refcount: every attach/detach must route through the two
    // helpers. A raw chrome.debugger.attach/detach elsewhere races under
    // concurrent commands on one tab (stress-measured: 13% failures, 70s
    // lost-callback hangs, debugger sessions leaked onto later commands).
    assert(bg.split('chrome.debugger.attach(').length === 2, 'ext: one debugger-attach site (the refcount helper)');
    assert(bg.split('chrome.debugger.detach(').length === 2, 'ext: one debugger-detach site (the refcount helper)');
    // Every full-body attach site rides withDbg (queue + attach + try/finally
    // detach) — the hand-copied attach/try/finally detached even after a
    // FAILED attach, re-entering the refcount at 0 as a phantom doctor row.
    // Bare attachDbg/detachDbg remains only where the attach isn't the whole
    // body: withDbg itself, emulation, net, runEval's CDP fallback.
    assert(bg.split('await attachDbg(').length === 5 && bg.split('await detachDbg(').length === 6, 'ext: bare attach/detach only in withDbg + the non-full-body sites');
    assert(bg.split('withDbg(').length === 10, 'ext: all 9 full-body CDP sites ride withDbg (trustedInput, waitPixel, fetch --csrf, fetch fallback, dialog, upload --chooser, upload, shot, perf)');
    // CDP commands serialize per tab — an unemulate racing a sibling's
    // sendCommand tore the shared session mid-flight (5.5% of interleaved
    // CDP commands in stress). (Remaining bare withCdp sites: release's
    // emulation clear + leaked-refcount detach, net, emulate, unemulate.)
    assert(bg.split('withCdp(').length === 8, 'ext: CDP handlers serialize per tab (helper + withDbg wrapper + 5 bare wrap sites)');
    // open must not await the favicon/banner marking — executeScript sits
    // pending forever on an uncommitted navigation (unreachable URL), which
    // hung open past its 8s cap to the server's 70s timeout. The response
    // also needs the requested URL: a still-pending tab has url "" and could
    // never be matched.
    assert(bg.includes('url: url || msg.url') && /markTab\(tab\.id\)\.catch/.test(bg), 'ext: open fire-and-forgets marking, url falls back to the request');
    // External debugger detach must reset the refcount (infobar cancel,
    // DevTools opened) — else a stale count wedges the session until close.
    assert(bg.includes('chrome.debugger.onDetach.addListener'), 'ext: onDetach resets the CDP refcount');
    // Prerender swaps the tab id under the driven-tab state (found by the
    // v1.18.12 flow review): without the remap the new id sheds every
    // marker while the old id's state leaks.
    assert(bg.includes('chrome.tabs.onReplaced.addListener'), 'ext: prerender swap remaps tab state (onReplaced)');
    // The pill's ⏏ is the human's escape hatch — but the click must only
    // ever fire on trusted input: a hostile page can dispatchEvent a
    // synthetic click and strip its own driven markers otherwise (the one
    // signal README promises a page can't fake).
    assert(bg.includes('chrome.runtime.onMessage.addListener') && bg.includes("msg?.type === 'self-release'"), 'pill: ⏏ self-release reaches the SW via runtime messaging');
    assert(bg.includes('if (!e.isTrusted) return;'), 'pill: ⏏ ignores synthetic clicks (isTrusted guard — a page must not strip its own markers)');
    assert(bg.includes('releaseTab(sender.tab.id, { flash: true })'), 'pill: ⏏ release waits for hydration and confirms with a ✓ released fade — a cold-waking click must not be silently undone');
    assert(bg.includes("if (e.key === 'Enter' || e.key === ' ') selfRelease(e);"), 'pill: ⏏ keyboard = Enter/Space only — Tab must keep moving focus');
    assert(bg.includes('dataset.v === chrome.runtime.getManifest().version') && bg.includes('dataset.bridgeHide'), 'pill: banner rebuilds on extension reload (dead handlers) and honors a ✕ hide on the catch-up path');
    // Release = full cleanup: a marker-only release left phone-shaped tabs
    // with a debugger infobar and nothing explaining why (v1.18.13 review).
    assert(bg.includes('if (emulatedTabs.has(tabId)) await withCdp(tabId, () => clearEmulation(tabId)).catch'), 'ext: release clears device emulation, not just markers');
    // A driven tab that navigated while the SW was dead must get its markers
    // back at the next SW start — the bridge must never act on an unmarked tab.
    // (The old grep assert here matched only a comment — behavior coverage is
    // the stress suite's doctor section: extreload → boot reap.)
    // The Bridge group is per-window: a cached global groupId MOVES
    // cross-window tabs into the wrong window (chrome.tabs.group relocates,
    // it does not throw — verified against Chromium's tabs_api.cc).
    assert(bg.includes("chrome.tabGroups.query({ title: '🟣 Bridge', windowId })"), 'ext: Bridge group derived per window, never from a cached id');
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
    // The ⏏ reclaim is ENFORCED, not advisory: without the findTab gate the
    // next command in the agent's loop re-marked a ⏏-released tab within
    // seconds — visible, but not durable. And the gate is STICKY (v1.24): a
    // 60s lapse let a polling agent silently re-drive a tab the human took
    // back — only an explicit `mark` re-claims now.
    assert(
      bg.includes('humanReclaimed') && !bg.includes('RECLAIM_MS') && bg.includes("['mark', 'release'].includes(msg.type)"),
      'pill: ⏏ reclaim is enforced and sticky — findTab refuses re-driving a human-reclaimed tab until mark (no timed lapse)'
    );
    // …and it rides storage.session like tabActivity: an SW restart used to
    // wipe the veto and the agent's next command re-drove the tab the human
    // had taken back (memory-only humanReclaimed, fixed in v1.26.6).
    assert(
      bg.includes('humanReclaimed: Object.fromEntries(humanReclaimed)') && bg.includes("'humanReclaimed', 'swLogs'"),
      'pill: ⏏ reclaim persists across SW restarts (storage.session write-through + hydration)'
    );
    assert(
      bg.includes('tabOwner: Object.fromEntries(tabOwner)') && bg.includes("'tabOwner', 'humanReclaimed'") && bg.includes('tabOwner.set(Number(k), v)'),
      'links: tab ownership persists across SW restarts — a restart must not hand another link\'s tab to local (the no-owner default)'
    );
    // v1.24 review batch — the behaviors the fake extension can't execute:
    assert(
      bg.includes('pillQ') && bg.includes('function pillWrite'),
      'pill: every narration write rides a per-tab chain — a tick landing after the idle reset froze its label forever (#41)'
    );
    assert(
      bg.includes('pillBusy') && bg.includes("busy ? pillBusy.get(tabId)"),
      'pill: capture-window restores repaint the in-flight label, not a lying "AI idle"'
    );
    // (The old 'pill back between polls' grep assert here matched only a
    // comment — it asserted nothing and was deleted in the Track D cleanup.)
    assert(
      bg.includes('msg._markedByMe = true') && bg.includes('was released again (no markers left)'),
      '#37: a command that marked the tab and hit a permanent unscriptable wall releases its own fresh mark (no pill-less 🟣 group residue)'
    );
    assert(
      bg.includes("u.host === 'chromewebstore.google.com'") && bg.includes('can never be driven'),
      '#37: open/nav refuse chrome://, chrome-extension://, and Web Store targets up front — a marked tab no command can act on is the residue'
    );
    assert(
      bg.includes('humanWaits') && bg.includes('one handoff at a time'),
      'wait --human: a second concurrent handoff on one tab is refused (it would re-arm the acted flag under the first waiter)'
    );
    assert(
      bg.includes('window.__bridgeTyping = true') && bg.includes('another type is still running'),
      'trusted type honors the synthetic type overlap guard (#32 class — CDP keys + a lost synthetic loop garble the payload)'
    );
    assert(
      bg.includes('/another debugger holds|Cannot access a chrome|Cannot attach|extensions gallery/i.test(errText(e))'),
      '#61: shot rethrows the real error on a foreign debugger (a doomed fallback would steal the human\'s view) and on every permanent unscriptable wall (chrome://, Web Store — the masked fallback error missed #37\'s unmark and left a pill-less marked tab)'
    );
    assert(
      bg.includes('/No tab with id: \\d|The frame was removed/.test(s)'),
      'wrapErr matches Chrome\'s raw dead-tab error case-SENSITIVELY — an /i version ate findTab\'s curated re-copy remedy (found by single-profile CI; two local profiles route through the server probe and mask it)'
    );
    assert(
      bg.includes('cdpRefs.set(tabId, 0)'),
      'detach failure on a live tab leaves a doctor-visible refcount entry (the one residue class doctor could not see)'
    );
    assert(
      bg.includes('offlinePainted') && bg.includes('2500'),
      'pill: bridge-offline paint waits out a 2.5s grace — a reconnect blip stays calm'
    );
    assert(
      bg.includes('seat taken — another live connection holds this profile id'),
      'seat-taken loser logs to swlogs (a cloned profile dir used to bounce silently forever)'
    );
    assert(
      bg.includes('wedged (5s)'),
      'storage watchdogs: a wedged storage.session/profile-id read degrades to empty state instead of hanging every command'
    );
    // Driven tabs wear a toolbar badge too: on non-injectable pages (chrome://,
    // Web Store, PDF) pill, group and favicon ALL fail — the badge is the one
    // marker that works everywhere.
    assert(bg.includes('setBadgeText') && bg.includes("color: '#7c3aed'"), 'ext: driven tabs wear a toolbar badge (the everywhere-marker)');
    assert(bg.includes("msg.type === 'note' ? 4000 : 800"), 'pill: a note holds its label ~4s — a ~100ms note command must not flash unseen');
    assert(bg.includes("replace(/^(Error:\\s*)+/, '')"), 'pill history: doubled Error: nesting deduped (the feed fix 756df17, third surface)');
    // Tab-match confusion: a lookalike URL path (evil.com/github.com matches
    // 'github.com') must be a no-op. A driven/MRU preference is only a
    // heuristic, and returning a warning after dispatch is too late for a
    // mutating command. Keep the refusal before _tabId/marking as a source
    // tripwire; the real-browser fixture below proves neither counter moves.
    const findTabBlock = bg.slice(bg.indexOf('async function findTab'), bg.indexOf('async function cmdFetch'));
    assert(
      findTabBlock.includes('refusing to choose one') && findTabBlock.indexOf('if (matches.length > 1)') < findTabBlock.indexOf('msg._tabId = matches[0].id'),
      'ext: findTab refuses ambiguous same-profile matches before selecting a tab'
    );
    assert(!findTabBlock.includes('drivenTabs.has(b.id)'), 'ext: findTab has no driven/MRU ambiguity fallback');
    assert(findTabBlock.includes("!['release', 'mark', 'unemulate', 'activate'].includes(msg.type)"), 'ext: unique tab commands still auto-mark (activate only reorders tabs — not driving)');
    assert(bg.includes('bad relay message — reconnecting') && bg.includes("if (!msg || typeof msg !== 'object' || Array.isArray(msg))"), 'ext: malformed relay frames trigger a clean reconnect');
    assert(bg.includes('if (msg.all)') && bg.includes('closed: matches.length'), 'ext: close --all drains every match — the remedy for identical-URL tabs no <match> can separate');
    assert(serverSrc.includes("k.startsWith('_')"), 'server: /cmd strips underscore-internal fields (_tabId/_pill are extension-set only)');
    assert(cliSrc.includes("takeFlags(args, ['--all'], 1"), 'cli: close accepts --all');

    // Contract drift tripwires: the command list lives in 3 places (cli USAGE,
    // handle() dispatch, ACT_VERBS) kept in sync by hand — fail here when they
    // drift instead of shipping a command with a wrong/missing pill label.
    const handleBlock = bg.slice(bg.indexOf('async function handle(msg)'));
    const handleTypes = new Set([...handleBlock.matchAll(/msg\.type === '(\w+)'/g)].map((m) => m[1]));
    for (const m of handleBlock.matchAll(/\[([^\]]+)\]\.includes\(msg\.type\)/g))
      for (const q of m[1].matchAll(/'(\w+)'/g)) handleTypes.add(q[1]);
    const verbBlock = bg.slice(bg.indexOf('const ACT_VERBS'), bg.indexOf('};', bg.indexOf('const ACT_VERBS')));
    const verbKeys = new Set([...verbBlock.matchAll(/^  (\w+): \[/gm)].map((m) => m[1]));
    // ping/swlogs/tabs/probe never reach findTab (no pill; probe is a
    // server-internal routing query); note is special-cased in activityPhrases;
    // extreload restarts the worker — no tab, no pill.
    const NO_VERBS = ['ping', 'swlogs', 'tabs', 'note', 'probe', 'extreload', 'doctor'];
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
    const CLI_LOCAL = ['batch', 'health', 'start', 'stop', 'update', 'watch', 'history', 'profiles', 'probe'];
    const usageWire = new Set([...usageCmds].filter((c) => !CLI_LOCAL.includes(c)).map((c) => (c === 'nav' ? 'navigate' : c)));
    assert(
      [...usageWire].sort().join() === [...handleTypes].filter((t) => t !== 'ping' && t !== 'probe').sort().join(),
      'drift: cli USAGE commands vs handle() types',
      `usage: ${[...usageWire].sort()} handle: ${[...handleTypes].sort()}`
    );
    // The command registry (extension/commands.js) is what the cloud link will
    // build its tools from: same names as USAGE, and each usage line is that
    // command's USAGE synopsis (a shared 'mark|release <match>' line counts
    // for both). Loaded the way the service worker will load it: a classic
    // script in a bare global, no Node APIs.
    const sandbox = vm.createContext({});
    vm.runInContext(cmdSrc, sandbox);
    const registry = sandbox.BridgeCommands.REGISTRY;
    assert(
      registry.map((e) => e.name).sort().join() === [...usageCmds].sort().join(),
      'drift: commands.js REGISTRY names vs cli USAGE commands',
      `registry: ${registry.map((e) => e.name).sort()} usage: ${[...usageCmds].sort()}`
    );
    const synopses = new Map();
    for (const m of usageBlock.matchAll(/^  (\S.*)$/gm)) {
      const syn = m[1].split(/\s{2,}/)[0];
      const head = syn.split(' ')[0];
      for (const name of head.split('|')) synopses.set(name, name + syn.slice(head.length));
    }
    const usageDrift = registry.filter((e) => synopses.get(e.name) !== e.usage).map((e) => `${e.name}: registry '${e.usage}' vs USAGE '${synopses.get(e.name)}'`);
    assert(usageDrift.length === 0, 'drift: commands.js REGISTRY usage lines match the cli USAGE synopses', usageDrift.join('\n'));
    assert(registry.some((e) => e.aliases.includes('navigate') && e.name === 'nav'), 'commands.js: nav carries its navigate alias (the wire type)');
    // MUTATING (extension) = acts as the user or runs page code — never a read-only tool.
    const mutating = [...bg.slice(bg.indexOf('const MUTATING'), bg.indexOf(']);', bg.indexOf('const MUTATING'))).matchAll(/'(\w+)'/g)].map((m) => m[1]);
    const readOnlyMutating = mutating.filter((t) => registry.find((e) => e.name === t || e.aliases.includes(t))?.readOnly !== false);
    assert(mutating.length > 10 && readOnlyMutating.length === 0, 'drift: every MUTATING command is non-readOnly in the commands.js REGISTRY', `readOnly or missing: ${readOnlyMutating}`);
    // A link may READ a tab another link drives — nothing else. A command that
    // acts can never ride that pass: each cross-link read is a readOnly
    // browser command in the registry and never MUTATING.
    const crossReads = [...bg.slice(bg.indexOf('const CROSS_LINK_READS'), bg.indexOf(']);', bg.indexOf('const CROSS_LINK_READS'))).matchAll(/'(\w+)'/g)].map((m) => m[1]);
    const crossNotRead = crossReads.filter((t) => { const e = registry.find((r) => r.name === t); return !e || !e.readOnly || e.scope !== 'browser' || mutating.includes(t); });
    assert(crossReads.length >= 5 && crossNotRead.length === 0, 'drift: CROSS_LINK_READS (another link\'s tab) holds only readOnly browser commands, never MUTATING', `not a pure read: ${crossNotRead}`);
    // Caller JavaScript reaches the page on exactly two paths — eval's code and
    // wait --js. Both must carry pageCode (policy treats them alike) and never
    // read as readOnly; a third path fails here until the registry knows it.
    const pageCodeSites = bg.match(/runEval\(tab\.id, (?:msg\.code|waitJsSrc\(msg\))/g) || [];
    const pageCode = registry.filter((e) => e.pageCode).map((e) => e.name);
    assert(
      pageCodeSites.length === 2 && pageCode.sort().join() === 'eval,wait' && registry.filter((e) => e.pageCode && e.readOnly).length === 0,
      'drift: caller-JS commands (eval, wait --js) carry pageCode in the commands.js REGISTRY and are not readOnly',
      `runEval caller-code sites: ${pageCodeSites.length}, pageCode: ${pageCode}`
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
    assert(serverSrc.includes("msg.type === 'type') return await ask(seat, msg, Math.min(285_000, CMD_TIMEOUT_MS + (msg.value?.length || 0) * 100)"), 'server: type reply budget scales with payload length, capped at the undici wall (#29)');
    assert(serverSrc.includes("EADDRINUSE") && serverSrc.includes("server.on('error'"), 'server: a taken port exits with one clean line, not an unhandled-error stack dump');
    assert(serverSrc.includes("typeof m.code !== 'string'") && serverSrc.includes('Array.isArray(m.crop)') && serverSrc.includes('Array.isArray(msg.files)') && serverSrc.includes('Object.hasOwn(CLI_LINES'), 'server: replay formatters are total — a malformed raw /cmd field must not cost the ring its entry (logging failed for shot/eval in the live log; files/world/proto-key dispatch are the same throw class)');
    assert(bg.includes('const errText') && bg.includes('errText(e)') && bg.includes("Cannot access a chrome-extension"), 'ext: CDP protocol-error envelopes unwrap to their message; cross-extension tabs get a named error');
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
    assert(bg.includes("['text/html', 'text/plain']") && bg.includes("insertHTML") && cliSrc.includes('--html'), 'ext+cli: paste --html carries text/html with a tag-stripped text/plain fallback (#31)');
    assert(bg.includes('const clearSrc') && bg.includes('selectAllChildren') && bg.includes("execCommand('delete')") && bg.includes('replaceChildren'), 'ext: clear empties inputs and contenteditables, with a DOM-removal fallback when the editor blocks the native delete (#34)');
    assert(cliSrc.includes("case 'clear':"), 'cli: clear command routed');
    assert(cliSrc.includes("res.error.includes('no tab matching')") && cliSrc.includes('urlMatch: `id:${opened.id}`') && cliSrc.includes("'--keep'"), 'cli: fetch with no matching tab rides a scratch tab on the target origin, closing it after unless --keep (#35)');
    assert(bg.includes('persistHint') && bg.includes("!el.closest('form')") && bg.includes('confirm a save fired (net)'), 'ext: fill flags targets an app autosave may never notice — rich editors and formless text fields (#36)');
    // The bridge's own UI must not defeat the bridge's own observation: the
    // pill ticker mutates every 5s on a driven tab (settle could never go
    // quiet — every --diff ate its full 3s cap) and the pill is a role=button
    // that would mint a ref and own the snap diff.
    assert(bg.includes('BRIDGE_SEL') && bg.includes('inBridge'), 'ext: settle ignores the bridge-injected DOM (pill ticker, cursor, grid)');
    assert(bg.includes("el.id === 'bridge-banner'") && bg.includes("el.id === 'bridge-cursor'"), 'ext: snap excludes the bridge UI (the pill is not page content)');
    assert(bg.includes('Math.min(25, 15000 / text.length)'), 'ext: type caps its total inter-char sleep budget (~15s) for long text');
    assert(bg.includes("document.visibilityState === 'hidden'") && bg.includes('MessageChannel'), 'ext: type cadence on hidden tabs is an unthrottled MessageChannel hop, not a 1s-clamped setTimeout (#29/#32)');
    assert(bg.includes('__bridgeTyping') && bg.includes('another type is still running'), 'ext: overlapping type refuses while a previous loop runs (#32)');
    assert(bg.includes("closest?.('[contenteditable]')") && bg.includes('anchorNode'), 'ext: type follows the live caret when the editor rewrites the caret block mid-typing (#30)');
    assert(bg.includes('no observable page effect') && bg.includes('MutationObserver'), 'ext: click watches for an observable effect and names --trusted when the app ignored it (#23)');
    {
      // A link's navigate event fires INSIDE its click dispatch: a listener
      // armed after it misses a slow navigation and the click reads as a
      // no-op ('retry with --trusted' → double submit). Both observers.
      const armedFirst = (start, dispatch) => {
        const i = bg.indexOf(start), j = bg.indexOf("nav?.addEventListener('navigate', started)", i), k = bg.indexOf(dispatch, i);
        return i >= 0 && j > i && k > j;
      };
      assert(armedFirst('const clickSrc', 'pair(1);') && armedFirst('const pressSrc', "dispatchEvent(new KeyboardEvent('keydown'"), 'ext: click/press arm the navigate listener before dispatching (slow navigations are not no-ops)');
      assert(bg.includes('async function waitForCommit') && /— page navigating\\b\/\.test\(actionResult\) \|\| t0\?\.pendingUrl/.test(bg), 'ext: --diff waits for the commit of a started navigation instead of snapping the old page');
    }
    assert(bg.includes('cssVisualViewport.clientWidth'), 'ext: shot --full clips to at least the viewport size (no narrow-strip full shots, #24)');
    assert(bg.includes('settleFrames') && bg.split('await settleFrames(').length === 3, 'ext: captures wait two rAFs before reading the compositor (mid-redirect tiled-shot race, #25)');
    assert(bg.includes('hash-only navigation') && bg.includes("split('#')[0]"), 'ext: nav to a same-document #hash URL warns the view was not re-validated (#26)');
    assert(bg.includes("replace(/\\r\\n?/g, '\\n')") && bg.includes('ex.text.endsWith(head)'), 'ext: CDP error text is CR-normalized and never duplicates its message line (#27)');
    assert(bg.includes("trusted (CDP) input reaches only the foreground tab") && bg.includes("runEval(tab.id, 'document.visibilityState')"), 'ext: --trusted refuses on a hidden tab instead of reporting a silent success (#33)');
    assert(bg.includes("chrome.tabs.update(tab.id, { active: true })") && bg.includes('chrome.windows.update(tab.windowId, { focused: true })'), 'ext: activate brings the tab to the front AND focuses its window (#33)');
    // Shadow-piercing target resolution: document.querySelector can't reach
    // open shadow roots (Reddit's faceplate-*, LinkedIn's nested roots) —
    // every action script resolves via deepQuery (@refs/document CSS first,
    // deep walk on a miss).
    assert(
      bg.includes('const DEEPQ') && bg.includes('const mustQuery') && bg.split('mustQuery(sel').length + bg.split('deepQuery(sel').length >= 12,
      'ext: action targets pierce open shadow roots (mustQuery/deepQuery at every resolution site)',
      `resolution sites: ${bg.split('mustQuery(sel').length + bg.split('deepQuery(sel').length}`
    );
    assert(bg.includes('deepAll(') && bg.includes("[mustQuery(s)] : deepAll(s, document)"), 'ext: measure matches inside open shadow roots too (and takes @refs)');
    // Mockup comparison read border/margin/font-family through eval — measure carries them.
    assert(['margin:c.margin', 'border:c.border', 'family:c.fontFamily'].every((s) => bg.includes(s)), 'ext: measure reports margin, border and font family');
    // Long names keep their TAIL — breadcrumb siblings differ at the end.
    assert(bg.includes("s.slice(0, 40) + '…' + s.slice(-19)"), 'ext: snap names over 60 chars are cut mid-name (tail survives)');
    // A modal portaled past the cut (BBC's Sourcepoint) must still show.
    assert(bg.includes("deepAll('dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]', root)") && bg.includes('(modal layer past the cut'), 'ext: snap appends modal layers the depth cut / width fold / MAX swallowed');
    assert(bg.includes("dsf: msg.dsf || (msg.mobile ? 2 : 1)"), 'ext: emulate reply echoes the pinned dsf');
    // Stale-ref guard (#22): a ref's identity is its snap-time role+name —
    // a re-sorted virtualized list reusing the node must fail loudly. ONE
    // REFKEY_SRC feeds snap's minting AND deepQuery's click-time recheck.
    assert(
      bg.includes('const REFKEY_SRC') && bg.includes('${REFKEY_SRC}') && bg.includes('at snap time, now resolves to'),
      'ext: @ref resolution recomputes role+name against the snap-time key (stale refs fail loudly toward re-snap)',
    );
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
      bg.includes('actAndVerify'),
      'ext: verdicts diff against a pre-action baseline (not the last snap — click A used to bleed into click B --diff)'
    );
    assert(
      bg.includes('reCAPTCHA') && bg.includes('Cloudflare Turnstile') && bg.includes('DataDome'),
      'ext: the wall scan names the common bot walls (reCAPTCHA, Turnstile, DataDome, PerimeterX, Arkose)'
    );
    // Pixel diff (#16): PNGs decoded in the SW (OffscreenCanvas — zero deps),
    // per-pixel compare with an antialiasing tolerance, changed-region crop,
    // and the pixel-change poll for canvas.
    assert(
      bg.includes('OffscreenCanvas') && bg.includes('pixelDiff') && bg.includes('changedBox') && bg.includes('cropDataUrl'),
      'ext: shot --diff / wait --pixel-change decode + compare + crop PNGs in the service worker'
    );
    assert(bg.includes('shotBaselines'), 'ext: pixel diff baselines are compare-to-previous (like snap --diff), memory-only per tab');
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
    assert(spawnSync('node', ['--check', `${ROOT}extension/commands.js`]).status === 0, 'ext: commands.js parses (node --check)');
    assert(spawnSync('bash', ['-n', `${ROOT}install.sh`]).status === 0, 'install.sh parses (bash -n)');

    // The toolbar popup (copy tab reference): the manifest must point at real
    // files, and popup.js is never executed by this suite (the fake extension
    // plays the SW; nothing loads the popup) — a syntax error would ship green.
    assert(
      fs.existsSync(`${ROOT}extension/popup.html`) &&
        fs.existsSync(`${ROOT}extension/popup.js`) &&
        JSON.parse(fs.readFileSync(`${ROOT}extension/manifest.json`, 'utf8')).action?.default_popup === 'popup.html',
      'popup: manifest action points at existing popup files'
    );
    assert(spawnSync('node', ['--check', `${ROOT}extension/popup.js`]).status === 0, 'ext: popup.js parses (node --check)');
    // The onboarding prompt the popup copies: self-contained (a store user has
    // no repo), gated on health, ends by proving no residue via doctor.
    const setupPrompt = fs.existsSync(`${ROOT}extension/setup-prompt.txt`) ? fs.readFileSync(`${ROOT}extension/setup-prompt.txt`, 'utf8') : '';
    assert(
      setupPrompt.includes('cli.mjs health') && setupPrompt.includes('.claude/skills/chrome-bridge/SKILL.md') && setupPrompt.includes('cli.mjs doctor') && setupPrompt.includes('archive/refs/heads/master.tar.gz'),
      'onboarding: setup-prompt.txt covers download, health gate, manual, doctor'
    );
    const popupSrc = fs.readFileSync(`${ROOT}extension/popup.js`, 'utf8');
    assert(popupSrc.includes('setup-prompt.txt') && popupSrc.includes('/health'), 'popup: copies the setup prompt + polls /health for the status dot');
    assert(bg.includes('chrome.management') && bg.includes('&install='), 'ext: install type rides the WS handshake (getSelf, no permission)');
    // The id:<tabId> match form the popup copies — one predicate shared by
    // findTab / probe / close --all. Pin it so the branch can't silently die.
    assert(
      bg.includes('const tabMatches') && bg.includes('/^id:(\\d+)$/') && (bg.match(/tabMatches\(t, msg\.urlMatch\)/g) || []).length === 3,
      'ext: tabMatches predicate with the id: branch feeds all 3 match sites'
    );
    // The hygiene trio: lifecycle journal helper + doctor handler + boot-time
    // reap of dead-session group residue (re-deriving driven state from the
    // group stays removed — 5655484).
    assert(bg.includes("function journal(") && bg.includes("msg.type === 'doctor'"), 'ext: journal helper + doctor handler');
    assert(bg.includes("journal('reap'") && bg.includes("journal('boot'") && bg.includes("journal('mark'") && bg.includes("journal('release'"), 'ext: journal call sites (reap/boot/mark/release)');

    // The per-domain recipe convention (#19): the skill points agents at
    // recipes/<domain>.md before acting — a missing dir/file 404s the
    // convention for every agent that reads the manual.
    const SKILL_DIR = `${ROOT}.claude/skills/chrome-bridge/`;
    assert(
      fs.existsSync(`${ROOT}recipes/README.md`) && fs.readFileSync(`${SKILL_DIR}SKILL.md`, 'utf8').includes('recipes/README.md'),
      'recipes: the convention file exists and SKILL.md points at it'
    );
    // SKILL.md is the whole user-facing manual's entry point — its relative
    // links into reference/ must resolve (a symlinked install follows them).
    for (const link of fs.readFileSync(`${SKILL_DIR}SKILL.md`, 'utf8').matchAll(/\]\((reference\/[^)#]+)/g))
      assert(fs.existsSync(SKILL_DIR + link[1]), `skill: SKILL.md link ${link[1]} resolves`);
    // The agent-setup paste text is THE install interface (both READMEs embed it
    // as the quick start) — same drift logic as the commands block below: a stale copy
    // ships broken install instructions to every new user.
    const setupMd = fs.readFileSync(`${ROOT}docs/agent-setup.md`, 'utf8').trim();
    for (const f of ['README.md', 'README.zh-CN.md']) {
      assert(
        fs.readFileSync(`${ROOT}${f}`, 'utf8').includes(setupMd),
        `drift: ${f} embeds docs/agent-setup.md verbatim`,
        're-copy docs/agent-setup.md into the README quick-start block'
      );
    }

    // reference/commands.md's fenced Commands block is the agent-facing command list —
    // doc drift is a real bug class here (the --profile name landed without
    // touching any doc), so it must name exactly the cli USAGE commands.
    const commandsMd = fs.readFileSync(`${SKILL_DIR}reference/commands.md`, 'utf8');
    const cmdSec = commandsMd.slice(commandsMd.indexOf('## Commands'));
    const fenceStart = cmdSec.indexOf('```');
    const cmdFence = cmdSec.slice(fenceStart + 3, cmdSec.indexOf('```', fenceStart + 3));
    const docCmds = new Set(
      [...cmdFence.matchAll(/^(\S+)/gm)].flatMap((m) => m[1].split('|')).filter((c) => /^[a-z]+$/.test(c))
    );
    assert(
      [...usageCmds].sort().join() === [...docCmds].sort().join(),
      'drift: reference/commands.md Commands block vs cli USAGE commands',
      `usage: ${[...usageCmds].sort()} docs: ${[...docCmds].sort()}`
    );

    // SKILL.md is the quick reference agents read FIRST — and nothing checked
    // it: it shipped '--diff is its only option' for upload a full release
    // after --chooser landed (#56), found by a manual audit (v1.26.2). It is a
    // summary, not a mirror: every command must be NAMED unless an explicit
    // omission list keeps it reference-only, and a few load-bearing flags must
    // appear. A new command/flag fails here until the skill rides along (or the
    // omission is chosen deliberately).
    const skillMd = fs.readFileSync(`${SKILL_DIR}SKILL.md`, 'utf8');
    const SKILL_OMITS = ['grid', 'resize', 'stop']; // niche/rare — reference/commands.md-only by design
    const skillMissing = [...usageCmds].filter((c) => !SKILL_OMITS.includes(c) && !new RegExp(`\\b${c}\\b`).test(skillMd));
    assert(skillMissing.length === 0, 'drift: SKILL.md names every cli USAGE command (else list it in SKILL_OMITS)', `missing: ${skillMissing.sort()}`);
    for (const flag of ['--chooser', '--csrf', '--world', '--trusted', '--profile'])
      assert(skillMd.includes(flag), `drift: SKILL.md mentions ${flag}`, 'load-bearing for first-hour flows — the skill must name it');
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

  // --- lifecycle journal + doctor ------------------------------------------
  // Extension→server lifecycle events land in the journal ring (and as
  // durable [tab] lines in server.log); doctor annotates residue rows with
  // the tab's last transitions — the "why is this tab still marked" answer.
  ext.send({ type: 'event', kind: 'mark', tabId: 7, detail: 'selftest' });
  ext.send({ type: 'event', kind: 'release', tabId: 7, detail: '' });
  await new Promise((r) => setTimeout(r, 200)); // the two frames must arrive before doctor reads the ring
  const doc1 = await cli('doctor');
  assert(doc1.status === 0, 'doctor runs', doc1.stderr);
  const rows1 = JSON.parse(doc1.stdout);
  const residue = rows1.find((r) => r.id === 7);
  assert(residue && residue.grouped === true && residue.driven === false, 'doctor: residue row merged from the seat', doc1.stdout);
  assert(!rows1.some((r) => r.id === 8), "doctor: a live driven tab (another session's work) is not residue", doc1.stdout);
  assert(
    residue.last?.some((l) => l.includes('mark')) && residue.last.some((l) => l.includes('release')),
    'doctor: residue row annotated with its last journal events',
    JSON.stringify(residue)
  );
  assert(rows1.find((r) => r.staleMemory)?.pruned === false, 'doctor: stale memory reported, unpruned without --fix', doc1.stdout);
  const doc2 = await cli('doctor', '--fix');
  const rows2 = JSON.parse(doc2.stdout);
  assert(rows2.find((r) => r.id === 7)?.fixed === 'released', 'doctor --fix releases residue tabs via the release path', doc2.stdout);
  assert(rows2.find((r) => r.staleMemory)?.pruned === true, 'doctor --fix prunes stale memory', doc2.stdout);
  // history --batch must replay EVERY wire command: clear and activate were
  // missing from the server's CLI_LINES table and close dropped --all — a
  // replayed `close --all` closed ONE tab and reported ok, a replayed fill
  // sequence APPENDED where the recorded session replaced (the registry drift
  // the SEVEN-registries comment warns fails silently).
  const clearRun = await cli('clear', 'example.com', '@e2', '--diff');
  const actRun = await cli('activate', 'example.com');
  const closeAllRun = await cli('close', 'example.com', '--all');
  // Flags that landed in cli.mjs without their CLI_LINES mirror and silently
  // dropped out of replays: emulate dsf=N, paste --html, upload --chooser.
  const dsfRun = await cli('emulate', 'example.com', '1280', '800', 'dsf=2');
  const htmlRun = await cli('paste', 'example.com', '--html', '--', '<b>x</b>');
  fs.writeFileSync(scratchFile('chrome-bridge-selftest-upload.txt'), 'x');
  const chooserRun = await cli('upload', 'example.com', '@e5', '--chooser', scratchFile('chrome-bridge-selftest-upload.txt'));
  const waitJsRun = await cli('wait', 'example.com', '--js', "document.title === 'a b'", '--world', 'main');
  const replayPath = scratchFile('chrome-bridge-selftest-replay.batch');
  const replayExport = await cli('history', '--batch', replayPath);
  const replayScript = fs.readFileSync(replayPath, 'utf8');
  assert(
    clearRun.status === 0 &&
      actRun.status === 0 &&
      closeAllRun.status === 0 &&
      replayScript.includes('clear example.com @e2 --diff') &&
      replayScript.includes('activate example.com') &&
      replayScript.includes('close example.com --all'),
    'history --batch replays clear, activate, and close --all (registry drift class)',
    replayExport.stdout + '\n' + replayScript
  );
  assert(
    dsfRun.status === 0 &&
      htmlRun.status === 0 &&
      chooserRun.status === 0 &&
      replayScript.includes('emulate example.com 1280 800 dsf=2') &&
      replayScript.includes('paste example.com --html -- "***"') &&
      replayScript.includes('upload example.com @e5 "***" --chooser'),
    'history --batch replays emulate dsf=N, paste --html, upload --chooser (flag mirrors)',
    dsfRun.stderr + htmlRun.stderr + chooserRun.stderr + '\n' + replayScript
  );
  assert(
    waitJsRun.status === 0 && replayScript.includes(`wait example.com --js "document.title === 'a b'" --world main`),
    'history --batch replays wait --js with --world (flag mirror)',
    waitJsRun.stderr + '\n' + replayScript
  );
  fs.unlinkSync(replayPath);
  fs.unlinkSync(scratchFile('chrome-bridge-selftest-upload.txt'));

  // The journal must NOT leak into the command feed — watch/history stay
  // command-focused (the ring above is the only in-memory surface).
  const feedLines = (await fetch(`http://127.0.0.1:${PORT}/log`).then((r) => r.json())).lines;
  assert(!feedLines.some((l) => l.line.includes('selftest') && l.line.includes('mark tab')), 'journal stays out of the activity ring');

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

  // A seat must use RFC 6455 masked client frames. An unmasked local client
  // is discarded rather than being parsed as an extension reply, and cannot
  // take down the live bridge.
  const unmaskedWs = await new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    let handshaken = false;
    let buf = Buffer.alloc(0);
    s.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (!handshaken && buf.includes(Buffer.from('\r\n\r\n'))) {
        handshaken = true;
        s.write(Buffer.from([0x81, 0x02, 0x7b, 0x7d])); // unmasked '{}'
      }
    });
    s.on('connect', () =>
      s.write(
        `GET /ws?id=malformed-test HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      )
    );
    s.on('close', () => resolve(handshaken));
    s.on('error', () => resolve(handshaken));
    setTimeout(() => { s.destroy(); resolve(false); }, 1000);
  });
  assert(unmaskedWs, 'server: unmasked WS client frame rejected');
  h = await cli('health');
  assert(JSON.parse(h.stdout).extension === true, 'server survives malformed WS frame');

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
    const histPath2 = scratchFile('chrome-bridge-selftest2.batch');
    await cli('history', '--batch', histPath2);
    assert(
      fs.readFileSync(histPath2, 'utf8').includes('--profile beta snap sample.org'),
      'history --batch: routed commands carry --profile',
      fs.readFileSync(histPath2, 'utf8')
    );
    fs.unlinkSync(histPath2);

    // Dual install: TWO seats reporting the SAME tab id+url = one Chrome with
    // two bridge builds (store + unpacked share no storage → two profile
    // ids). tabs warns in the merged list, and routing refuses with the real
    // cause — the human's ⏏/reclaim gate covers only one install.
    const extDup = await wsClient(PORT, 'alpha-twin');
    extDup.onMessage((msg) => {
      const respond = (result) => extDup.send({ id: msg.id, ok: true, result });
      if (msg.type === 'ping') return respond('pong');
      if (msg.type === 'probe') return respond([{ id: 1, url: 'https://example.com/', lastAccessed: 1 }].filter((t) => t.url.includes(msg.urlMatch)));
      if (msg.type === 'tabs') return respond([{ id: 1, url: 'https://example.com/', title: 'Example', driven: false }]);
      return respond(msg);
    });
    await new Promise((r) => setTimeout(r, 100));
    const tabsDual = await cli('tabs');
    assert(tabsDual.stdout.includes('TWO bridge builds'), 'dual-install: merged tabs carries the loud warning row', tabsDual.stdout);
    const dualRefused = await cli('snap', 'example.com');
    assert(dualRefused.status !== 0 && dualRefused.stderr.includes('the SAME tab') && dualRefused.stderr.includes('⏏ covers only one install'), 'dual-install: routing the shared tab refuses with the real cause', dualRefused.stdout + dualRefused.stderr);
    extDup.socket.destroy();
    await new Promise((r) => setTimeout(r, 200)); // let the seat drop before later sections probe
    const tabsAfter = await cli('tabs');
    assert(!tabsAfter.stdout.includes('TWO bridge builds'), 'dual-install: warning clears when the twin seat leaves', tabsAfter.stdout);

    // PINNED tabs/doctor route through their own branches (no match to probe,
    // so the general path's profile normalize never runs) — a NAME passed via
    // --profile used to print as its 4-char id prefix in the feed ('@oak' for
    // oak-test) AND break the exported replay ('--profile oak' doesn't route).
    const pinnedTabs = await cli('tabs', '--profile', 'beta');
    const feedPinned = (await fetch(`http://127.0.0.1:${PORT}/log`).then((r) => r.json())).lines;
    const pinnedFeedLine = feedPinned.filter((a) => a.line.includes('tabs @')).slice(-1)[0]?.line || '';
    const histPath3 = scratchFile('chrome-bridge-selftest3.batch');
    await cli('history', '--batch', histPath3);
    assert(
      pinnedTabs.status === 0 && pinnedFeedLine.includes('tabs @beta') && fs.readFileSync(histPath3, 'utf8').includes('--profile beta tabs'),
      'pinned tabs: feed tag and replay carry the full profile name (route normalizes name → pid)',
      pinnedFeedLine + '\n' + fs.readFileSync(histPath3, 'utf8')
    );
    fs.unlinkSync(histPath3);

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

  // install=store on the handshake: health reports it, the stale-version
  // advice stops pointing at extreload, and extreload itself refuses a store
  // build (runtime.reload would re-fetch the same store code).
  {
    const extS = await wsClient(PORT, 'delta-store', undefined, 'store', '0.0.0-test');
    extS.onMessage((msg) => {
      if (msg.type === 'ping') return extS.send({ id: msg.id, ok: true, result: 'pong' });
      return extS.send({ id: msg.id, ok: true, result: null });
    });
    await new Promise((r) => setTimeout(r, 100));
    const hh = await cli('health');
    assert(JSON.parse(hh.stdout).profiles.find((p) => p.id === 'delta-store')?.install === 'store', 'health reports install=store from the handshake', hh.stdout);
    assert(hh.stderr.includes('is ahead of the Chrome Web Store extension 0.0.0-test') && hh.stderr.includes('cli.mjs update') && !hh.stderr.includes('extreload'), 'health: a store seat older than the checkout gets update advice (match it), not extreload', hh.stderr);
    const xr = await cli('extreload', '--profile', 'delta-store');
    assert(xr.status !== 0 && xr.stderr.includes('updates via the store'), 'extreload refuses a store-installed extension', xr.stdout + xr.stderr);
    extS.socket.destroy();
    await new Promise((r) => setTimeout(r, 100)); // let the seat drop before later sections probe
  }

  // A store build NEWER than the checkout (Chrome auto-updated it, nobody
  // pulled): health must name update, not "nothing to reload".
  {
    const extN = await wsClient(PORT, 'delta-newer', undefined, 'store', '999.0.0');
    extN.onMessage((msg) => extN.send({ id: msg.id, ok: true, result: msg.type === 'ping' ? 'pong' : null }));
    await new Promise((r) => setTimeout(r, 100));
    const hn = await cli('health');
    assert(
      hn.stderr.includes('is newer than this bridge download') && hn.stderr.includes('cli.mjs update'),
      'health: a store build newer than the checkout says to run update',
      hn.stderr
    );
    // the same warning rides a command routed to that profile — and only that one
    const tn = await cli('tabs', '--profile', 'delta-newer');
    assert(tn.stderr.includes('is newer than this bridge download'), 'drift warning rides commands on the drifted profile', tn.stderr);
    const tOther = await cli('tabs', '--profile', 'alpha-test');
    assert(!tOther.stderr.includes('999.0.0'), "another profile's drift stays out of this profile's command replies", tOther.stderr);
    extN.socket.destroy();
    await new Promise((r) => setTimeout(r, 100));
  }

  // ?boot= handshake (#63): a dev seat whose load predates the newest mtime
  // under extension/ gets a stale-code warning on health AND every /cmd reply
  // (plain snaps are where a stale build misbehaves, not health). boot=1000
  // predates any checkout deterministically; a fresh boot and store installs
  // stay quiet.
  {
    const reply = (ext) => ext.onMessage((msg) => ext.send({ id: msg.id, ok: true, result: null }));
    const extStale = await wsClient(PORT, 'stale-dev', 'stale-seat', 'dev', undefined, 1000);
    reply(extStale);
    const extFresh = await wsClient(PORT, 'fresh-dev', 'fresh-seat', 'dev', undefined, Date.now());
    reply(extFresh);
    const extStaleStore = await wsClient(PORT, 'stale-store', 'stale-store', 'store', undefined, 1000);
    reply(extStaleStore);
    await new Promise((r) => setTimeout(r, 100));
    const hw = await cli('health');
    const hjson = JSON.parse(hw.stdout);
    assert(
      Array.isArray(hjson.warn) && hjson.warn.length === 1 && hjson.warn[0].includes('stale-seat') && hjson.warn[0].includes('extreload'),
      'stale-code warning: health warn names the stale dev seat + extreload (fresh boot and store stay quiet)',
      hw.stdout + hw.stderr
    );
    assert(hw.stderr.includes('⚠ extension code on disk changed after this build loaded'), 'stale-code warning: health prints it to stderr', hw.stderr);
    const tw = await cli('tabs', '--profile', 'stale-dev');
    assert(
      tw.stderr.includes('extension code on disk changed after this build loaded') && tw.status === 0,
      'stale-code warning rides every /cmd reply (tabs still succeeds)',
      tw.stdout + tw.stderr
    );
    const tf = await cli('tabs', '--profile', 'fresh-dev');
    assert(!tf.stderr.includes('fresh-seat'), 'a fresh-boot dev seat is never the one named in the warn', tf.stderr);
    for (const e of [extStale, extFresh, extStaleStore]) e.socket.destroy();
    await new Promise((r) => setTimeout(r, 100));
    const hc = await cli('health');
    assert(!JSON.parse(hc.stdout).warn?.length && !hc.stderr.includes('stale'), 'stale-code warning clears when the seat drops', hc.stdout + hc.stderr);
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
  assert(h.status !== 0 && JSON.parse(h.stdout).extension === false, 'health: extension false after disconnect — exit 1 (a disconnected bridge must not pass a `health && …` preflight)', h.stdout + h.stderr);

  // health carries the server's own version (A): the code it runs vs disk.
  {
    const hj = JSON.parse(h.stdout);
    assert(hj.v === PKG_V && hj.disk === PKG_V, 'health reports the running server version and the checkout version', h.stdout);
  }

  // cli update against a throwaway origin: a CLI copy in a temp clone updates
  // ITS checkout (never this repo). Store seat → pinned to v<ext version>;
  // unpacked → branch; local commits / tracked edits / no extension refuse.
  {
    const tmp = fs.mkdtempSync(join(tmpdir(), 'bridge-update-'));
    const git = (cwd, ...a) => {
      const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=master', ...a], { cwd, encoding: 'utf8' });
      if (r.status) throw new Error('git ' + a.join(' ') + ': ' + r.stderr);
      return r.stdout.trim();
    };
    const work = join(tmp, 'work');
    fs.mkdirSync(join(work, 'extension'), { recursive: true });
    for (const f of ['cli.mjs', 'drift.mjs', 'extension/commands.js']) fs.copyFileSync(join(ROOT, f), join(work, f));
    const setV = (dir, v) => {
      fs.writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: v, type: 'module' }));
      fs.writeFileSync(join(dir, 'extension', 'manifest.json'), JSON.stringify({ version: v }));
    };
    setV(work, '1.0.0');
    git(work, 'init', '-q');
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', 'v1.0.0');
    git(work, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
    setV(work, '1.0.1');
    git(work, 'commit', '-qam', 'v1.0.1');
    git(tmp, 'clone', '-q', '--bare', work, join(tmp, 'origin.git'));
    const clone = join(tmp, 'clone');
    git(tmp, 'clone', '-q', join(tmp, 'origin.git'), clone);
    const cloneV = () => JSON.parse(fs.readFileSync(join(clone, 'package.json'), 'utf8')).version;
    const upd = (...a) =>
      new Promise((resolve) => {
        const p = spawn('node', [join(clone, 'cli.mjs'), 'update', ...a], { env });
        let stdout = '', stderr = '';
        p.stdout.on('data', (c) => (stdout += c));
        p.stderr.on('data', (c) => (stderr += c));
        p.on('close', (status) => resolve({ status, stdout, stderr }));
      });
    const seat = async (id, install, v) => {
      const e = await wsClient(PORT, id, id, install, v);
      e.onMessage((msg) => e.send({ id: msg.id, ok: true, result: msg.type === 'ping' ? 'pong' : null }));
      await new Promise((r) => setTimeout(r, 100));
      return e;
    };
    try {
      const none = await upd();
      assert(none.status !== 0 && none.stderr.includes('no extension connected'), 'update refuses with no extension connected (nothing to match)', none.stdout + none.stderr);

      let s = await seat('upd-store', 'store', '1.0.0');
      const plan = await upd('--check');
      assert(
        plan.status === 0 && plan.stdout.includes('"target":"v1.0.0"') && plan.stdout.includes('git reset --keep v1.0.0') && plan.stdout.includes('it runs from') && cloneV() === '1.0.1',
        'update --check: a store seat pins to its release tag, prints the plan, changes nothing',
        plan.stdout + plan.stderr
      );
      const pin = await upd();
      assert(
        pin.status === 0 && cloneV() === '1.0.0' && pin.stdout.includes('checkout moved to v1.0.0') && pin.stdout.includes('server not restarted'),
        'update: a clone ahead of the store release moves back to it (all newer commits upstream); a foreign server is not restarted',
        pin.stdout + pin.stderr
      );
      s.socket.destroy();

      s = await seat('upd-dev', 'dev', '1.0.1');
      const pull = await upd();
      assert(pull.status === 0 && cloneV() === '1.0.1' && pull.stdout.includes('checkout moved to the branch'), 'update: an unpacked seat follows the branch (ff-only pull)', pull.stdout + pull.stderr);
      s.socket.destroy();

      s = await seat('upd-store2', 'store', '1.0.0');
      fs.writeFileSync(join(clone, 'recipe.md'), 'mine');
      git(clone, 'add', 'recipe.md');
      git(clone, 'commit', '-qm', 'my recipe');
      const mine = await upd();
      assert(mine.status !== 0 && mine.stderr.includes('local commit(s) not on origin') && fs.existsSync(join(clone, 'recipe.md')), 'update refuses to move local commits (recipes stay)', mine.stdout + mine.stderr);
      fs.appendFileSync(join(clone, 'drift.mjs'), '\n// local edit\n');
      const dirty = await upd();
      assert(dirty.status !== 0 && dirty.stderr.includes('local edits to tracked files'), 'update refuses with local edits to tracked files', dirty.stdout + dirty.stderr);
      s.socket.destroy();
      await new Promise((r) => setTimeout(r, 100));

      // Shallow clones (the npm launcher clones --depth 1): after one pin,
      // the next store release must still apply — the old release commit is
      // tag-reachable, not a "local commit" (review catch: stuck for good).
      const shallow = join(tmp, 'shallow');
      git(tmp, 'clone', '-q', '--depth', '1', 'file://' + join(tmp, 'origin.git'), shallow);
      const updIn = (dir) =>
        new Promise((resolve) => {
          const p = spawn('node', [join(dir, 'cli.mjs'), 'update'], { env });
          let stdout = '', stderr = '';
          p.stdout.on('data', (c) => (stdout += c));
          p.stderr.on('data', (c) => (stderr += c));
          p.on('close', (status) => resolve({ status, stdout, stderr }));
        });
      const shallowV = () => JSON.parse(fs.readFileSync(join(shallow, 'package.json'), 'utf8')).version;
      s = await seat('upd-store-shallow', 'store', '1.0.0');
      const first = await updIn(shallow);
      assert(first.status === 0 && shallowV() === '1.0.0', 'update: a shallow clone pins to the store release', first.stdout + first.stderr);
      s.socket.destroy();
      setV(work, '1.0.2');
      git(work, 'commit', '-qam', 'v1.0.2');
      git(work, 'tag', '-a', 'v1.0.2', '-m', 'v1.0.2');
      git(work, 'push', '-q', join(tmp, 'origin.git'), 'master', 'v1.0.2');
      s = await seat('upd-store3', 'store', '1.0.2');
      const second = await updIn(shallow);
      assert(second.status === 0 && shallowV() === '1.0.2', 'update: the next store release applies to a shallow clone pinned before', second.stdout + second.stderr);
      s.socket.destroy();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

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
  assert(
    start.status === 0 && start.stdout.includes('server ready; extension not connected yet'),
    'cli start waits through reconnect grace, then names a genuinely absent extension',
    start.stdout + start.stderr
  );
  const hUp = await cli('health');
  // Server back up, extension still absent (the fake one disconnected above):
  // the JSON says ok, the EXIT CODE stays 1 — a disconnected bridge must not
  // pass a `health && …` preflight, which is the whole point of the exit code.
  assert(hUp.status !== 0 && JSON.parse(hUp.stdout).ok === true && JSON.parse(hUp.stdout).extension === false, 'health ok after start — but exit 1 while the extension is absent', hUp.stdout + hUp.stderr);
  await cli('stop'); // leave no detached server behind

  console.log(`\n${passed} checks passed`);
} finally {
  server.kill();
  fs.rmSync(diagnosticDirectory, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(0);
