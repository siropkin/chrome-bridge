import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const evalSource = source.slice(source.indexOf('async function runEval('), source.indexOf('// --- --diff on actions:'));

test('application EvalError never replays an eval payload', async () => {
  let executions = 0;
  const context = vm.createContext({
    attachDbg: async () => {},
    detachDbg: async () => {},
    chrome: {
      scripting: { executeScript: async ({ func, args }) => [{ result: await func(...args) }] },
      debugger: { sendCommand: async () => { throw new Error('unexpected CDP fallback'); } },
    },
    mutate: () => { executions++; },
  });
  vm.runInContext(evalSource, context);
  await assert.rejects(context.runEval(7, 'mutate(); throw new EvalError("application failure")'), /application failure/);
  assert.equal(executions, 1);
});

const listenerSource = source.slice(source.indexOf('chrome.runtime.onMessage.addListener('), source.indexOf('// --- CDP debugger refcount'));

function popupListener({ failedTab, ready = Promise.resolve(), owners = new Map() } = {}) {
  let listener;
  const drivenTabs = new Set([7, 8]);
  const humanReclaimed = new Map();
  const diagnostics = [];
  const events = [];
  const storage = {};
  const connects = [];
  const localLink = { id: 'local', closed: 0, socket: { close() { localLink.closed++; } } };
  const sender = { id: 'bridge', url: 'chrome-extension://bridge/popup.html' };
  const context = {
    chrome: { runtime: { id: 'bridge', getURL: (path) => 'chrome-extension://bridge/' + path, onMessage: { addListener: (handler) => { listener = handler; } } }, storage: { local: { set: async (o) => Object.assign(storage, o) } } },
    localOn: true, localLoaded: true, localReady: Promise.resolve(), links: new Map([['local', localLink]]), connect: (link) => connects.push(link.id),
    ready, idReady: Promise.resolve(), cloudReady: Promise.resolve(), cloudState: () => ({ paired: false }), PROFILE_NAME: 'poplar', drivenTabs, humanReclaimed,
    linkOpen: (id) => id === 'local',
    linkSend: (id, data) => { events.push([id, JSON.parse(data)]); return true; },
    ownerOf: (tabId) => (drivenTabs.has(tabId) ? owners.get(tabId) || 'local' : null),
    logLine() {},
    requestDiagnostics: async (message) => { diagnostics.push(message); return { ok: true, result: { enabled: false } }; },
    releaseTab: async (tabId) => {
      if (tabId === failedTab) throw new Error('release unavailable');
      drivenTabs.delete(tabId);
    },
    persist() {},
  };
  vm.runInNewContext(listenerSource, context);
  const send = async (message, origin = sender) => {
    let response;
    let open = true;
    let replied = false;
    const keepAlive = listener(message, origin, (value) => {
      assert.equal(open, true, 'callback-only runtime closed the response channel');
      response = value;
      replied = true;
    });
    open = keepAlive === true;
    if (!replied) assert.equal(keepAlive, true, 'asynchronous replies must return literal true');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(replied, true, 'listener must reply through sendResponse');
    return response;
  };
  return { send, drivenTabs, humanReclaimed, diagnostics, events, context, storage, connects, localLink, raw: (message, origin) => listener(message, origin, () => {}) };
}

test('popup: switching local off hangs up BEFORE releasing, and sweeps again for a tab marked mid-release (review finding)', async () => {
  const order = [];
  const { send, drivenTabs, context, localLink } = popupListener();
  localLink.socket.close = () => order.push('close');
  context.linkSend = (id, data) => { order.push(JSON.parse(data).kind); return true; };
  let first = true;
  context.releaseTab = async (tabId) => {
    order.push('release ' + tabId);
    drivenTabs.delete(tabId);
    if (first) { first = false; drivenTabs.add(9); } // a command that marked mid-sweep
  };
  const off = await send({ type: 'local-toggle', enabled: false });
  assert.deepEqual(order, ['local-off', 'close', 'release 7', 'release 8', 'release 9']);
  assert.equal(off.released, 3);
  assert.equal(drivenTabs.size, 0);
});

test('popup: Local AI agents off releases only local tabs, tells the server, hangs up; on dials again', async () => {
  const { send, drivenTabs, events, context, storage, connects, localLink } = popupListener({ owners: new Map([[8, 'cloud']]) });
  assert.equal((await send({ type: 'bridge-state', tabId: 7 })).local, true, 'on by default');
  const off = await send({ type: 'local-toggle', enabled: false });
  assert.deepEqual(JSON.parse(JSON.stringify(off)), { ok: true, local: false, released: 1 });
  assert.equal(context.localOn, false);
  assert.equal(storage.localAgents, false, 'the switch survives a restart');
  assert.deepEqual([...drivenTabs], [8], 'the cloud-driven tab stays driven');
  assert.deepEqual(events.at(-1), ['local', { type: 'event', kind: 'local-off' }], 'the server learns why this profile left');
  assert.equal(localLink.closed, 1);
  assert.equal((await send({ type: 'bridge-state', tabId: 7 })).local, false);
  const on = await send({ type: 'local-toggle', enabled: true });
  assert.equal(on.local, true);
  assert.equal(storage.localAgents, true);
  assert.deepEqual(connects, [], 'already open: no second dial');
  context.linkOpen = () => false;
  await send({ type: 'local-toggle', enabled: true });
  assert.deepEqual(connects, ['local']);
});

test('popup listener supports callback-only Chrome runtime for every async request', async () => {
  const { send } = popupListener();
  for (const action of ['status', 'configure', 'clear']) {
    assert.equal((await send({ type: 'diagnostics', action })).ok, true);
  }
  const initial = await send({ type: 'bridge-state', tabId: 7 });
  assert.equal(initial.count, 2);
  assert.equal(initial.active, true);
  assert.equal(initial.connected, true);
  assert.equal(initial.profile, 'poplar', 'the popup shows the profile name and puts it in the copied reference');
  assert.equal((await send({ type: 'release-active', tabId: 7 })).count, 1);
  assert.equal((await send({ type: 'bridge-state', tabId: 7 })).active, false);
  assert.equal((await send({ type: 'release-active', tabId: 8 })).count, 0);
  assert.equal((await send({ type: 'bridge-state' })).count, 0);
});

test('popup listener rejects unauthorized senders without mutations', async () => {
  const { send, drivenTabs, diagnostics, humanReclaimed } = popupListener();
  for (const sender of [
    { id: 'other', url: 'chrome-extension://bridge/popup.html' },
    { id: 'bridge', url: 'https://example.test/' },
    { id: 'bridge', url: 'chrome-extension://bridge/popup.html', tab: { id: 7 } },
  ]) {
    for (const type of ['diagnostics', 'bridge-state', 'release-active', 'local-toggle']) {
      assert.match((await send({ type, tabId: 7, action: 'configure', enabled: true }, sender)).error, /restricted/);
    }
  }
  assert.equal(drivenTabs.size, 2);
  assert.equal(diagnostics.length, 0);
  assert.equal(humanReclaimed.size, 0);
});

test('popup listener reports release failures and preserves failed tabs', async () => {
  const { send, drivenTabs, humanReclaimed } = popupListener({ failedTab: 7 });
  assert.match((await send({ type: 'release-active', tabId: 7 })).error, /release unavailable/);
  assert.equal((await send({ type: 'release-active', tabId: 8 })).count, 1, 'another tab still releases');
  assert.equal(drivenTabs.has(7), true);
  assert.equal(drivenTabs.has(8), false);
  assert.equal(humanReclaimed.has(7), false);
  assert.equal(humanReclaimed.has(8), true);
});

test('popup listener returns hydration failures through the callback', async () => {
  for (const type of ['bridge-state', 'release-active']) {
    const { send } = popupListener({ ready: Promise.reject(new Error('hydration unavailable')) });
    assert.match((await send({ type, tabId: 7 })).error, /hydration unavailable/);
  }
});

test('pill ⏏ self-release is announced on the link that drove the tab', async () => {
  const { raw, events, humanReclaimed } = popupListener({ owners: new Map([[8, 'cloud']]) });
  const pill = (id) => ({ id: 'bridge', url: 'https://example.test/', tab: { id, url: 'https://example.test/' + id } });
  for (const tabId of [7, 8, 9]) raw({ type: 'self-release' }, pill(tabId));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map(([link, e]) => [link, e.kind, e.tabId]), [['local', 'self-release', 7], ['cloud', 'self-release', 8], ['local', 'self-release', 9]],
    'owner read before releaseTab forgets it; a never-driven tab still reports to local');
  assert.deepEqual([...humanReclaimed.keys()], [7, 8, 9]);
});

test('close --all validates every reclaim before removing any tab without marking', async () => {
  const closeSource = source.slice(source.indexOf("  if (msg.type === 'close') {"), source.indexOf('  // Agent → human narration:'));
  const removed = [];
  const context = vm.createContext({
    humanReclaimed: new Map([[8, Date.now()]]),
    drivenTabs: new Set(), tabOwner: new Map(), links: new Map(),
    tabMatches: () => true,
    chrome: { tabs: { query: async () => [{ id: 7 }, { id: 8 }, { id: 9 }], remove: async (ids) => removed.push(...ids) } },
  });
  const guard = source.includes('function assertNotReclaimed(')
    ? source.slice(source.indexOf('function assertNotReclaimed('), source.indexOf('async function findTab(')) : '';
  vm.runInContext(guard + '\nasync function close(msg) {' + closeSource + '}', context);
  await assert.rejects(context.close({ type: 'close', all: true, urlMatch: 'example', _link: 'local' }), /human released/);
  assert.deepEqual(removed, []);
  context.humanReclaimed.clear();
  // Tab 9 is driven through another link: skipped and reported, never closed.
  context.drivenTabs.add(7).add(9);
  context.tabOwner.set(7, 'local').set(9, 'cloud');
  const result = await context.close({ type: 'close', all: true, urlMatch: 'example', _link: 'local' });
  assert.equal(result.closed, 2);
  assert.equal(result.skipped, 1);
  assert.match(result.note, /another link were left open/);
  assert.deepEqual(removed, [7, 8]);
  // Nothing of this link's left among the matches → refused, nothing closed.
  removed.length = 0;
  context.chrome.tabs.query = async () => [{ id: 9 }];
  await assert.rejects(context.close({ type: 'close', all: true, urlMatch: 'example', _link: 'local' }), /driven through another link — close --all only closes this link's tabs; nothing was closed/);
  assert.deepEqual(removed, []);
  // The owning link closes it like before.
  assert.deepEqual({ ...(await context.close({ type: 'close', all: true, urlMatch: 'example', _link: 'cloud' })) }, { closed: 1 });
  assert.deepEqual(removed, [9]);
});

const queueSource = source.slice(source.indexOf('const snapQ ='), source.indexOf('// Bounded wait for a tab'));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function actionQueue({ baseline = async () => {} } = {}) {
  const context = vm.createContext({
    ownershipSeq: new Map(), drivenTabs: new Set([7]), humanReclaimed: new Map(),
    chrome: { tabs: { get: async () => ({ url: 'https://example.test/' }) } },
    runEval: baseline, SNAP_SRC: () => '', observeDiff: async (_tabId, result) => result,
  });
  vm.runInContext(queueSource, context);
  return context;
}

test('queued actions refuse expired deadlines and release then re-mark, but observers still run', async () => {
  for (const reason of ['expired', 'released']) {
    const context = actionQueue();
    const blocker = deferred();
    const predecessor = context.withSnap(7, () => blocker.promise);
    let actions = 0;
    const msg = { diff: true, deadlineAt: Date.now() + 285_000 };
    const following = context.actAndVerify(7, msg, async () => { actions++; });
    if (reason === 'expired') msg.deadlineAt = Date.now() - 1;
    else {
      context.ownershipSeq.set(7, 1);
      context.humanReclaimed.set(7, Date.now());
      context.drivenTabs.delete(7);
      context.humanReclaimed.clear();
      context.drivenTabs.add(7);
    }
    const refused = assert.rejects(following, /queued action.*(?:expired|cancelled)/);
    const observer = context.withSnap(7, () => 'observed');
    blocker.resolve();
    await predecessor;
    await refused;
    assert.equal(actions, 0);
    assert.equal(await observer, 'observed');
  }
});

test('queued action checks again after baseline and never retroactively cancels in-flight work', async () => {
  const baseline = deferred();
  const entered = deferred();
  const context = actionQueue({ baseline: () => { entered.resolve(); return baseline.promise; } });
  let actions = 0;
  const pending = context.actAndVerify(7, { diff: true, deadlineAt: Date.now() + 285_000 }, () => { actions++; });
  await entered.promise;
  context.ownershipSeq.set(7, 1);
  const refused = assert.rejects(pending, /cancelled/);
  baseline.resolve();
  await refused;
  assert.equal(actions, 0);

  const running = deferred();
  const started = deferred();
  const active = context.actAndVerify(7, { diff: true, deadlineAt: Date.now() + 285_000 }, () => { started.resolve(); return running.promise; });
  await started.promise;
  context.ownershipSeq.set(7, 2);
  running.resolve('completed');
  assert.equal(await active, 'completed');
});

const trustedInputSource = source.slice(source.indexOf('async function trustedInput('), source.indexOf('// Key press on the focused element'));
const uploadSource = source.slice(source.indexOf('// Files are local paths (the CLI)'), source.indexOf('const shotFallbackQ ='));
const trustedRouteSource = source.slice(source.indexOf("  if (msg.trusted && ['click', 'press', 'type', 'hover', 'drag'].includes(msg.type))"), source.indexOf("  if (['click', 'fill', 'clear', 'type', 'press', 'hover'].includes(msg.type))"));

function cdpActionHarness({ pause = 'queue' } = {}) {
  const context = actionQueue();
  const entered = deferred();
  const gate = deferred();
  const commands = [];
  const resolutions = [];
  const state = { tagged: false, typing: false, suppressed: false, restored: 0, intercept: false, observed: 0 };
  const block = async (stage) => {
    if (pause !== stage) return;
    entered.resolve();
    await gate.promise;
  };
  const sendCommand = async (_target, method, params) => {
    commands.push({ method, params });
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') {
      await block('resolution');
      return { nodeId: 2 };
    }
    if (method === 'Page.setInterceptFileChooserDialog') state.intercept = params.enabled;
    if (method === 'Input.dispatchMouseEvent') {
      context.chooserWaiters.get(7)?.resolve({ backendNodeId: 3, mode: 'selectSingle' });
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-' + (params.nodeId ?? 'b' + params.backendNodeId) } };
    return {};
  };
  Object.assign(context, {
    withDbg: async (tabId, run) => {
      assert.equal(tabId, 7);
      await block('queue');
      return await run();
    },
    findTab: async () => ({ id: 7 }), awaitMark: async () => {},
    trustedPointSrc: (target) => 'point:' + target,
    trustedFocusSrc: (target) => 'focus:' + target,
    MODAL_COUNT_SRC: 'modal-count', modalNoteSrc: () => 'modal-note', DEEPQ: '',
    chooserWaiters: new Map(), setTimeout, clearTimeout,
    removeBannerForCapture: async () => { state.suppressed = true; return false; },
    restoreBanner: async () => { state.suppressed = false; state.restored++; },
    cdpMouseClick: async (tabId) => sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed' }),
    cdpDrag: async (tabId) => sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed' }),
    cdpKeyEvent: async (tabId) => sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown' }),
    observeDiff: async (_tabId, result) => { state.observed++; return result; },
    chrome: { ...context.chrome, debugger: { sendCommand } },
    runEval: async (_tabId, payload) => {
      if (payload === '') return '';
      if (payload === 'document.visibilityState + "|" + document.hasFocus()') return 'visible|true';
      if (payload.startsWith('point:') || payload.startsWith('focus:')) {
        resolutions.push(payload);
        if (payload !== 'point:#from') await block('resolution');
        return payload.startsWith('point:') ? JSON.stringify({ cx: 10, cy: 20, inBanner: false }) : '#target';
      }
      if (payload === 'modal-count') return 0;
      if (payload === 'modal-note') return '';
      if (payload === '!!window.__bridgeTyping') return state.typing;
      if (payload === 'window.__bridgeTyping = true') { state.typing = true; return true; }
      if (payload === 'window.__bridgeTyping = false') { state.typing = false; return false; }
      if (payload.includes('input.setAttribute(')) { state.tagged = true; return 'single'; }
      if (payload.includes("removeAttribute('data-bridge-upload')")) { state.tagged = false; return; }
      throw new Error('unexpected eval: ' + payload);
    },
  });
  vm.runInContext(trustedInputSource + '\n' + uploadSource + '\nasync function routeTrusted(msg) {\n' + trustedRouteSource + '\n}', context);
  return {
    context, entered, gate, commands, resolutions, state,
    mutations: () => commands.filter(({ method }) => method.startsWith('Input.') || method === 'DOM.setFileInputFiles' || method === 'Runtime.callFunctionOn'),
  };
}

const cdpActions = ['click', 'hover', 'drag', 'press', 'type', 'upload', 'chooser'];
function cdpActionMessage(action, diff = true) {
  return {
    type: action === 'chooser' ? 'upload' : action,
    trusted: true, diff, chooser: action === 'chooser', deadlineAt: Date.now() + 70_000,
    target: '#target', from: '#from', to: '#to', key: 'Enter', value: 'x', files: ['/tmp/fixture.txt'],
  };
}

function runCdpAction(context, msg) {
  return msg.type === 'upload' ? context.cmdUpload({ id: 7 }, msg) : context.routeTrusted(msg);
}

function invalidateCdpAction(context, msg, reason) {
  if (reason === 'expired') {
    msg.deadlineAt = Date.now() - 1;
    return;
  }
  context.ownershipSeq.set(7, (context.ownershipSeq.get(7) || 0) + 1);
  context.drivenTabs.delete(7);
  context.humanReclaimed.set(7, Date.now());
  if (reason === 'remarked') {
    context.humanReclaimed.clear();
    context.drivenTabs.add(7);
  }
}

function assertCdpCleanup(harness) {
  assert.equal(harness.state.tagged, false, 'upload marker must be removed');
  assert.equal(harness.state.typing, false, 'typing flag must be cleared');
  assert.equal(harness.state.suppressed, false, 'banner suppression must be cleared');
  assert.equal(harness.state.intercept, false, 'chooser interception must be disabled');
  assert.equal(harness.context.chooserWaiters.size, 0, 'chooser waiter must be removed');
}

for (const action of cdpActions) {
  for (const reason of ['remarked', 'expired']) {
    test(`${action} --diff refuses ${reason} work after the blocked CDP queue`, async () => {
      const harness = cdpActionHarness();
      const msg = cdpActionMessage(action);
      const pending = runCdpAction(harness.context, msg);
      await harness.entered.promise;
      assert.equal(harness.state.tagged, action === 'upload');
      invalidateCdpAction(harness.context, msg, reason);
      const refused = assert.rejects(pending, reason === 'expired' ? /queued action expired/ : /queued action cancelled/);
      harness.gate.resolve();
      await refused;
      assert.deepEqual(harness.commands, [], 'queue guard must run before any CDP command');
      assert.deepEqual(harness.resolutions, [], 'queue guard must run before point/focus resolution');
      assert.equal(harness.state.observed, 0);
      assertCdpCleanup(harness);
    });
  }

  test(`${action} --diff refuses release during point, focus, or DOM resolution`, async () => {
    const harness = cdpActionHarness({ pause: 'resolution' });
    const msg = cdpActionMessage(action);
    const pending = runCdpAction(harness.context, msg);
    await harness.entered.promise;
    assert.equal(harness.state.typing, action === 'type');
    assert.equal(harness.state.intercept, action === 'chooser');
    invalidateCdpAction(harness.context, msg, 'released');
    const refused = assert.rejects(pending, /queued action cancelled/);
    harness.gate.resolve();
    await refused;
    assert.deepEqual(harness.mutations(), [], 'no first input event or file mutation may escape');
    assert.equal(harness.state.observed, 0);
    assert.equal(harness.state.restored, ['click', 'hover', 'drag', 'chooser'].includes(action) ? 1 : 0);
    if (action === 'chooser') {
      assert.deepEqual(harness.commands.filter(({ method }) => method === 'Page.setInterceptFileChooserDialog').map(({ params }) => params.enabled), [true, false]);
    }
    assertCdpCleanup(harness);
  });

  test(`${action} without --diff preserves dispatch after expiry and release then re-mark`, async () => {
    const harness = cdpActionHarness();
    const msg = cdpActionMessage(action, false);
    const pending = runCdpAction(harness.context, msg);
    await harness.entered.promise;
    invalidateCdpAction(harness.context, msg, 'expired');
    invalidateCdpAction(harness.context, msg, 'remarked');
    harness.gate.resolve();
    assert.match(await pending, /trusted|uploaded/);
    assert.ok(harness.mutations().length > 0);
    assert.equal(harness.state.observed, 0);
    assertCdpCleanup(harness);
  });

  test(`${action} --diff dispatches and observes when CDP queue ownership stays valid`, async () => {
    const harness = cdpActionHarness();
    const pending = runCdpAction(harness.context, cdpActionMessage(action));
    await harness.entered.promise;
    harness.gate.resolve();
    assert.match(await pending, /trusted|uploaded/);
    assert.ok(harness.mutations().length > 0);
    assert.equal(harness.state.observed, 1);
    assertCdpCleanup(harness);
  });
}

// Cloud Bridge has no disk: its upload files arrive as bytes and are set
// through a DataTransfer on the same node setFileInputFiles would have used.
for (const action of ['upload', 'chooser']) {
  test(`${action} with byte files sets them in the page on the resolved input, never via paths`, async () => {
    const harness = cdpActionHarness({ pause: 'none' });
    const msg = { ...cdpActionMessage(action, false), files: [{ name: 'a.txt', mimeType: 'text/plain', data: 'aGk=' }] };
    assert.equal(await runCdpAction(harness.context, msg), action === 'chooser' ? 'uploaded 1 file(s) via the file chooser on #target: a.txt' : 'uploaded 1 file(s) to #target: a.txt');
    const methods = harness.commands.map((c) => c.method);
    assert.ok(!methods.includes('DOM.setFileInputFiles'), 'byte files never go through the path API');
    const resolve = harness.commands.find((c) => c.method === 'DOM.resolveNode');
    assert.deepEqual(plain(resolve.params), action === 'chooser' ? { backendNodeId: 3 } : { nodeId: 2 });
    const call = harness.commands.find((c) => c.method === 'Runtime.callFunctionOn');
    assert.equal(call.params.objectId, action === 'chooser' ? 'obj-b3' : 'obj-2');
    assert.deepEqual(plain(call.params.arguments), [{ value: [{ name: 'a.txt', mimeType: 'text/plain', data: 'aGk=' }] }]);
    assert.match(call.params.functionDeclaration, /new DataTransfer\(\)[\s\S]*this\.files = dt\.files[\s\S]*new Event\('change'/);
    assert.ok(methods.includes('Runtime.releaseObject'));
    assertCdpCleanup(harness);
  });
}

test('upload refuses a mix of paths and byte files, and the page function builds real Files', async () => {
  const harness = cdpActionHarness({ pause: 'none' });
  const msg = { ...cdpActionMessage('upload', false), files: ['/tmp/a.txt', { name: 'b.txt', data: 'aGk=' }] };
  await assert.rejects(runCdpAction(harness.context, msg), /must all be paths, or all \{ name, mimeType, data/);
  assertCdpCleanup(harness);
  // The page-side function, run against a fake input in a vm with the browser's File/DataTransfer shapes.
  const fnSrc = source.slice(source.indexOf('const SET_FILE_BYTES = `') + 'const SET_FILE_BYTES = `'.length, source.indexOf('}`;', source.indexOf('const SET_FILE_BYTES')) + 1);
  const events = [];
  const page = vm.createContext({
    atob: (s) => Buffer.from(s, 'base64').toString('latin1'), Uint8Array,
    File: class { constructor(parts, name, o) { this.name = name; this.type = o.type; this.size = parts[0].length; this.text = Buffer.from(parts[0]).toString(); } },
    DataTransfer: class { constructor() { const list = []; this.items = { add: (f) => list.push(f) }; this.files = list; } },
    Event: class { constructor(type, o) { this.type = type; this.bubbles = o.bubbles; } },
  });
  const input = { dispatchEvent: (e) => events.push(e.type) };
  vm.runInContext('(' + fnSrc + ')', page).call(input, [{ name: 'hi.txt', mimeType: 'text/plain', data: 'aGVsbG8=' }]);
  assert.deepEqual(input.files.map((f) => [f.name, f.type, f.size, f.text]), [['hi.txt', 'text/plain', 5, 'hello']]);
  assert.deepEqual(events, ['input', 'change']);
});

test('dispatch deadline is server-owned and retains the actual timeout budget', async () => {
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const askSource = server.slice(server.indexOf('function ask('), server.indexOf('const idShort'));
  let wire;
  const seat = { pid: 'test', nextId: 1, pending: new Map(), socket: { write: (frame) => { wire = JSON.parse(frame); } } };
  const context = vm.createContext({ seats: new Map([['test', seat]]), CMD_TIMEOUT_MS: 70_000, encodeFrame: (frame) => frame, setTimeout, clearTimeout });
  vm.runInContext(askSource, context);
  const before = Date.now();
  const reply = context.ask(seat, { type: 'type', deadlineAt: Number.MAX_SAFE_INTEGER }, 285_000);
  const after = Date.now();
  seat.pending.get(wire.id)({ ok: true });
  await reply;
  assert.ok(wire.deadlineAt >= before + 285_000 && wire.deadlineAt <= after + 285_000);
});

const fetchSource = source.slice(source.indexOf('async function cmdFetch('), source.indexOf('// A JS dialog (alert/confirm/prompt)'));
function fetchHarness({ chunks = [], cap = 8, origin = 'https://example.test', onCookies, redirect = false } = {}) {
  const calls = [];
  const requests = [];
  const page = vm.createContext({
    location: { origin }, URL, Uint8Array, TextEncoder, TextDecoder, btoa,
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (redirect && options.redirect === 'error') throw new TypeError('redirect refused');
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    },
  });
  const context = vm.createContext({
    BODY_CAP: cap, URL, Uint8Array, TextEncoder, TextDecoder, atob, btoa,
    withDbg: async (_tabId, fn) => fn(),
    fetchSrc: (url, headers) => JSON.stringify({ url, headers }),
    runEval: async (_tabId, payload) => { calls.push(['eval', payload]); throw new Error('in-page blocked'); },
    chrome: {
      scripting: { executeScript: async (injection) => {
        calls.push(['inject', injection]);
        assert.equal(injection.world, 'ISOLATED');
        if (injection.target.documentIds && page.location.origin !== origin) throw new Error('document gone');
        page.args = injection.args || [];
        const result = await vm.runInContext('(' + injection.func.toString() + ')(...args)', page);
        return [{ result, documentId: 'document-7', frameId: 0 }];
      } },
      debugger: { sendCommand: async (_target, method) => {
        calls.push([method]);
        if (method === 'Network.getCookies') {
          onCookies?.(page);
          return { cookies: [{ name: 'JSESSIONID', value: '"private-token"' }] };
        }
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-7' } } };
        if (method === 'Network.loadNetworkResource') return { resource: { success: true, stream: 'body', mime: 'application/octet-stream' } };
        if (method === 'IO.read') return chunks.shift();
        if (method === 'IO.close') return {};
        throw new Error('unexpected debugger call: ' + method);
      } },
    },
  });
  vm.runInContext(fetchSource, context);
  return { context, calls, requests, page };
}

test('fetch IO stream preserves padded base64 and mixed chunks in byte order', async () => {
  const { context } = fetchHarness({ chunks: [
    { base64Encoded: true, data: 'AA==', eof: false },
    { data: 'é', eof: false },
    { base64Encoded: true, data: '/w==', eof: true },
  ] });
  const result = await context.cmdFetch({ id: 7 }, { url: 'https://example.test/file' });
  assert.equal(result.binary, true);
  assert.deepEqual(Buffer.from(result.body, 'base64'), Buffer.from([0, 0xc3, 0xa9, 0xff]));
  assert.equal(result.truncated, false);
});

test('fetch IO stream caps bytes even when an oversized final chunk has EOF', async () => {
  for (const chunk of [
    { base64Encoded: true, data: Buffer.alloc(20, 255).toString('base64'), eof: true },
    { data: 'é'.repeat(10), eof: true },
  ]) {
    const { context, calls } = fetchHarness({ chunks: [chunk] });
    const result = await context.cmdFetch({ id: 7 }, { url: 'https://example.test/file' });
    const bytes = Buffer.from(result.body, result.binary ? 'base64' : 'utf8');
    assert.equal(bytes.length, 8);
    assert.equal(result.truncated, true);
    assert.ok(calls.some(([method]) => method === 'IO.close'));
  }
});

test('csrf refuses a wrong-origin tab before reading or injecting its token', async () => {
  const { context, calls } = fetchHarness({ origin: 'https://wrong.test' });
  await assert.rejects(context.cmdFetch({ id: 7, url: 'https://wrong.test/' }, { url: 'https://example.test/api', csrf: true }), /csrf.*origin/i);
  assert.equal(calls.some(([method]) => method === 'Network.getCookies' || method === 'eval'), false);
});

test('csrf uses a fixed isolated function bound to the validated document', async () => {
  const { context, calls, requests } = fetchHarness();
  const result = await context.cmdFetch({ id: 7, url: 'https://example.test/' }, { url: 'https://example.test/api', csrf: true, headers: { accept: 'application/json' } });
  assert.equal(result.body, 'ok');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers['csrf-token'], 'private-token');
  assert.equal(requests[0].options.headers.accept, 'application/json');
  assert.equal(requests[0].options.redirect, 'error');
  const injection = calls.find(([method, injection]) => method === 'inject' && injection.args?.some((arg) => arg?.['csrf-token']));
  assert.deepEqual(Array.from(injection[1].target.documentIds), ['document-7']);
  assert.equal(calls.some(([method]) => method === 'eval' || method === 'Network.loadNetworkResource'), false);
});

test('csrf never falls back after document replacement or redirect refusal', async () => {
  for (const options of [{ onCookies: (page) => { page.location.origin = 'https://wrong.test'; } }, { redirect: true }]) {
    const { context, calls, requests } = fetchHarness(options);
    await assert.rejects(context.cmdFetch({ id: 7, url: 'https://example.test/' }, { url: 'https://example.test/api', csrf: true }), /document gone|redirect refused/);
    assert.equal(calls.some(([method]) => method === 'eval' || method === 'Network.loadNetworkResource'), false);
    assert.ok(requests.length <= 1);
  }
});

function pillHarness({ pause, gone = false } = {}) {
  const entered = deferred();
  const gate = deferred();
  const writes = [];
  let documentId = 'old-document';
  let onUpdated;
  let paused = false;
  const pillInject = () => {};
  const injectBanner = () => {};
  const context = vm.createContext({
    navSeq: new Map(), ownershipSeq: new Map(), drivenTabs: new Set([7]),
    tabActivity: new Map([[7, ['old-origin secret']]]), pillBusy: new Map([[7, 'old note']]),
    shotBaselines: new Map(), bannerSuppressed: new Set(), cdpRefs: new Map(), dbgSince: new Map(),
    tabStatus: new Map(), pillInject, injectBanner,
    persist() {}, stopTick() {},
    chrome: {
      tabs: { onUpdated: { addListener: (handler) => { onUpdated = handler; } } },
      scripting: { executeScript: async ({ target, func, args }) => {
        const selected = target.documentIds?.[0];
        if (func !== pillInject && func !== injectBanner) return [{ documentId }];
        if (!paused && (pause === 'pill' && func === pillInject || pause === 'revive' && func === injectBanner)) {
          paused = true;
          entered.resolve();
          await gate.promise;
        }
        if (selected && selected !== documentId) throw new Error('document gone');
        if (func === pillInject) {
          writes.push({ documentId, args });
          return [{ result: gone ? 'gone' : 'ok' }];
        }
        return [{}];
      } },
    },
  });
  const queue = source.slice(source.indexOf('const pillQ ='), source.indexOf('// tabId -> consecutive failures'));
  const revive = source.slice(source.indexOf('async function revivePill('), source.indexOf('function recordActivity('));
  const updated = source.slice(source.indexOf('chrome.tabs.onUpdated.addListener((tabId, info)'), source.indexOf('chrome.tabs.onRemoved.addListener('));
  vm.runInContext('const failedSinceOk = new Map();\n' + queue + revive + updated, context);
  return {
    context, writes, entered, gate,
    navigate: () => { documentId = 'new-document'; onUpdated(7, { url: 'https://other.test/', status: 'loading' }); },
  };
}

test('navigation clears history and queued or pending pill writes cannot reach a new document', async () => {
  const { context, writes, entered, gate, navigate } = pillHarness({ pause: 'pill' });
  const first = context.pillWrite(7, ['old note', ['old-origin secret']]);
  await entered.promise;
  const following = context.pillWrite(7, ['queued old note', ['old-origin secret']]);
  navigate();
  assert.equal(context.tabActivity.has(7), false);
  assert.equal(context.pillBusy.has(7), false);
  gate.resolve();
  await Promise.all([first, following]);
  assert.equal(writes.length, 0);
  await context.pillWrite(7, ['new note', ['new-origin history']]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].documentId, 'new-document');
});

test('pill revival cannot replay old narration after navigation or release and re-mark', async () => {
  for (const reason of ['navigation', 'release']) {
    const { context, writes, entered, gate, navigate } = pillHarness({ pause: 'revive', gone: true });
    const pending = context.pillWrite(7, ['old note', ['old-origin secret']]);
    await entered.promise;
    if (reason === 'navigation') navigate();
    else context.ownershipSeq.set(7, 1);
    gate.resolve();
    await pending;
    assert.equal(writes.length, 1);
    assert.equal(writes[0].documentId, 'old-document');
  }
});

test('old command completions cannot narrate into a new document or ownership generation', () => {
  const { context, navigate } = pillHarness();
  const msg = { _pill: true, _pillNav: 0, _pillOwnership: 0 };
  assert.equal(context.currentActivity(7, msg), true);
  navigate();
  assert.equal(context.currentActivity(7, msg), false);
  msg._pillNav = 1;
  context.ownershipSeq.set(7, 1);
  assert.equal(context.currentActivity(7, msg), false);
});

function evalHarness({ blocked = ['ISOLATED'] } = {}) {
  const attempts = [];
  let executions = 0;
  let attached = 0;
  const pages = Object.fromEntries(['ISOLATED', 'MAIN'].map((world) => {
    const page = vm.createContext({ mutate: () => { executions++; } });
    if (blocked.includes(world)) vm.runInContext('eval = () => { throw new EvalError("Refused to evaluate a string as JavaScript because CSP blocks unsafe-eval"); }', page);
    return [world, page];
  }));
  const context = vm.createContext({
    attachDbg: async () => { attached++; }, detachDbg: async () => { attached--; },
    chrome: {
      scripting: { executeScript: async ({ world, func, args }) => {
        attempts.push(world);
        pages[world].args = args;
        return [{ result: await vm.runInContext('(' + func.toString() + ')(...args)', pages[world]) }];
      } },
      debugger: { sendCommand: async (_target, method, params) => {
        assert.equal(method, 'Runtime.evaluate');
        attempts.push('CDP');
        return { result: { value: await vm.runInNewContext(params.expression, { mutate: () => { executions++; } }) } };
      } },
    },
  });
  vm.runInContext(evalSource, context);
  return { context, attempts, executions: () => executions, attached: () => attached };
}

test('CSP-like application EvalErrors and async EvalErrors execute exactly once', async () => {
  for (const code of [
    'mutate(); throw new EvalError("Refused to evaluate because Content Security Policy blocks unsafe-eval")',
    '(async () => { mutate(); throw new EvalError("Refused to evaluate because CSP blocks unsafe-eval"); })()',
  ]) {
    {
      const harness = evalHarness();
      await assert.rejects(harness.context.runEval(7, code), /Refused to evaluate/);
      assert.equal(harness.executions(), 1);
      assert.deepEqual(harness.attempts, ['MAIN']);
      assert.equal(harness.attached(), 0);
    }
  }
});

test('real eval capability refusal falls back without executing payload in blocked worlds', async () => {
  for (const blocked of [['ISOLATED'], ['ISOLATED', 'MAIN']]) {
    const harness = evalHarness({ blocked });
    assert.equal(await harness.context.runEval(7, 'mutate(); 42'), 42);
    assert.equal(harness.executions(), 1);
    assert.deepEqual(harness.attempts, blocked.length === 1 ? ['MAIN'] : ['MAIN', 'CDP']);
    assert.equal(harness.attached(), 0);
  }
});

test('a raw world other than auto/MAIN is refused before any injection (/cmd bypasses the grammar)', async () => {
  for (const world of ['ISOLATED', 'FOO']) {
    const harness = evalHarness();
    await assert.rejects(harness.context.runEval(7, 'mutate()', world), /is not supported: caller code runs in the page's main world/);
    assert.equal(harness.executions(), 0);
    assert.deepEqual(harness.attempts, []);
  }
  for (const world of [undefined, 'auto', 'MAIN']) {
    const harness = evalHarness();
    assert.equal(await harness.context.runEval(7, 'mutate(); 1', world), 1);
  }
});

test('caller code never tries the ISOLATED world (MV3 forbids eval there on every page)', async () => {
  {
    const harness = evalHarness();
    assert.equal(await harness.context.runEval(7, 'mutate(); 7'), 7);
    assert.equal(harness.executions(), 1);
    assert.deepEqual(harness.attempts, ['MAIN']);
  }
});

test('real release invalidates queued work before asynchronous cleanup completes', async () => {
  const context = actionQueue();
  const blocker = deferred();
  const cleanup = deferred();
  Object.assign(context, {
    netCollectors: new Map(), tabActivity: new Map(), shotBaselines: new Map(), tabOwner: new Map([[7, 'local']]),
    failedSinceOk: new Map(), emulatedTabs: new Set([7]), cdpRefs: new Map(),
    stopTick() {}, clearEmulation() {},
    withCdp: () => cleanup.promise,
    chrome: { ...context.chrome, action: { setBadgeText: async (o) => { badges.push(o); } } },
  });
  const badges = [];
  const release = source.slice(source.indexOf('async function releaseTab('), source.indexOf('// Re-banner a driven tab'));
  vm.runInContext(release, context);
  const predecessor = context.withSnap(7, () => blocker.promise);
  let executions = 0;
  const following = context.actAndVerify(7, { diff: true, deadlineAt: Date.now() + 70_000 }, () => { executions++; });
  const released = context.releaseTab(7, { flash: true });
  assert.equal(context.ownershipSeq.get(7), 1);
  assert.equal(context.drivenTabs.has(7), false);
  assert.equal(context.tabOwner.has(7), false, 'release drops the link ownership with the driven state');
  assert.equal(context.humanReclaimed.has(7), true);
  // null, not '': an empty per-tab value hid the global pairing-code badge on released tabs (review).
  assert.deepEqual(JSON.parse(JSON.stringify(badges)), [{ tabId: 7, text: null }]);
  context.humanReclaimed.clear();
  context.drivenTabs.add(7);
  const refused = assert.rejects(following, /cancelled/);
  blocker.resolve();
  await predecessor;
  await refused;
  assert.equal(executions, 0);
  cleanup.resolve();
  await released;
});

test('dispatch deadline subtracts reconnect delay instead of resetting the timeout', async () => {
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const askSource = server.slice(server.indexOf('function ask('), server.indexOf('const idShort'));
  let now = 1000;
  let wire;
  const timers = [];
  const seat = { pid: 'test', nextId: 1, pending: new Map() };
  const context = vm.createContext({
    seats: new Map([['test', seat]]), CMD_TIMEOUT_MS: 70_000,
    Date: { now: () => now }, encodeFrame: (frame) => frame,
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }, clearTimeout() {},
  });
  vm.runInContext(askSource, context);
  const reply = context.ask(seat, { type: 'click', deadlineAt: 1 });
  now += 250;
  seat.socket = { write: (frame) => { wire = JSON.parse(frame); } };
  timers[0].callback();
  assert.equal(wire.deadlineAt, 71_000);
  assert.equal(timers[1].delay, 69_750);
  seat.pending.get(wire.id)({ ok: true });
  await reply;
});

test('csrf rejects an origin mismatch in the fixed function even if document targeting is faulty', async () => {
  const { context, calls, requests, page } = fetchHarness({ onCookies: (page) => { page.location.origin = 'https://other.test'; } });
  const inject = context.chrome.scripting.executeScript;
  context.chrome.scripting.executeScript = async (injection) => {
    if (!injection.target.documentIds) return inject(injection);
    assert.equal(injection.world, 'ISOLATED');
    page.args = injection.args;
    return [{ result: await vm.runInContext('(' + injection.func.toString() + ')(...args)', page) }];
  };
  await assert.rejects(context.cmdFetch({ id: 7, url: 'https://example.test/' }, { url: 'https://example.test/api', csrf: true }), /origin must match/);
  assert.equal(requests.length, 0);
  assert.equal(calls.some(([method]) => method === 'eval' || method === 'Network.loadNetworkResource'), false);
});

test('csrf refuses missing document IDs and isolated injection failures without fallback', async () => {
  for (const failure of ['missing-id', 'blocked']) {
    const { context, calls } = fetchHarness();
    context.chrome.scripting.executeScript = async () => {
      if (failure === 'blocked') throw new Error('injection refused');
      return [{ result: 'https://example.test' }];
    };
    await assert.rejects(context.cmdFetch({ id: 7, url: 'https://example.test/' }, { url: 'https://example.test/api', csrf: true }), /origin changed|injection refused/);
    assert.equal(calls.length, 0);
  }
});

test('fetch keeps custom-header failures in-page and detects exact-cap streams correctly', async () => {
  const headers = fetchHarness();
  await assert.rejects(headers.context.cmdFetch({ id: 7 }, { url: 'https://example.test/api', headers: { accept: 'application/json' } }), /custom headers ride only/);
  assert.equal(headers.calls.some(([method]) => method === 'Network.loadNetworkResource'), false);
  const { context } = fetchHarness({ chunks: [{ data: '12345678' }, { data: '', eof: true }] });
  const result = await context.cmdFetch({ id: 7 }, { url: 'https://example.test/api' });
  assert.equal(result.body, '12345678');
  assert.equal(result.truncated, false);
});

test('screenshot fallback never switches tabs and rejects inactive or changed targets', async () => {
  const shotSource = source.slice(source.indexOf('const shotFallbackQ ='), source.indexOf('// Adding a command?', source.indexOf('async function cmdShot(')));
  for (const scenario of ['inactive', 'active', 'changed', 'foreign-debugger']) {
    let queries = 0;
    let captures = 0;
    const context = vm.createContext({
      awaitMark: async () => {},
      withDbg: async () => { throw new Error(scenario === 'foreign-debugger' ? 'another debugger holds this tab' : 'capture unavailable'); },
      errText: (error) => error.message,
      chrome: { tabs: {
        query: async () => [{ id: scenario === 'inactive' || scenario === 'changed' && queries++ > 0 ? 8 : 7 }],
        update: async () => { assert.fail('screenshot must never activate a tab'); },
        captureVisibleTab: async () => { captures++; return 'data:image/png;base64,fixture'; },
      } },
    });
    vm.runInContext(shotSource, context);
    const pending = context.cmdShot({ id: 7, windowId: 2 }, { diff: true });
    if (scenario === 'active') {
      const result = await pending;
      assert.match(result.note, /diff skipped.*baseline is unchanged/);
      assert.equal(result.data, 'data:image/png;base64,fixture');
    } else await assert.rejects(pending, scenario === 'inactive' ? /no focus changed.*activate/ : scenario === 'changed' ? /capture discarded/ : /another debugger holds/);
    assert.equal(captures, ['active', 'changed'].includes(scenario) ? 1 : 0);
  }
});

const errorTapSource = source.slice(source.indexOf('function pageErrorTap('), source.indexOf('// Commands that read the log themselves'));

test('page-error tap reports only errors new since the previous drain', () => {
  const listeners = {};
  const page = vm.createContext({ console: { error() {} }, Error, addEventListener: (type, fn) => { listeners[type] = fn; } });
  page.window = page;
  vm.runInContext(errorTapSource, page);
  assert.equal(page.pageErrorTap(true), null, 'first call only installs');
  page.console.error('boom', { a: 1 });
  listeners.error({ message: 'TypeError: x is undefined' });
  listeners.error({ message: '' });
  listeners.unhandledrejection({ reason: new Error('nope') });
  const first = page.pageErrorTap(true);
  assert.equal(first.count, 3);
  assert.deepEqual([...first.lines], ['error boom {"a":1}', 'pageerror TypeError: x is undefined', 'unhandledrejection Error: nope']);
  assert.equal(page.pageErrorTap(true), null, 'a drained error is never reported twice');
  for (let i = 0; i < 30; i++) page.console.error('e' + i);
  page.pageErrorTap(false);
  const burst = page.pageErrorTap(true);
  assert.equal(burst.count, 30);
  assert.deepEqual([...burst.lines], ['error e25', 'error e26', 'error e27', 'error e28', 'error e29']);
});

const waitJsSrc = vm.runInNewContext(source.slice(source.indexOf('const waitJsSrc ='), source.indexOf('// Post-action settle')) + '; waitJsSrc');

function waitPage() {
  const observers = [];
  const page = vm.createContext({
    setInterval, clearInterval, setTimeout, clearTimeout,
    document: { documentElement: {} },
    MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() { this.off = true; } },
    Element: class {},
  });
  return { page, mutate: () => observers.forEach((o) => !o.off && o.cb([])) };
}

test('wait --js resolves on the mutation that makes the expression truthy, with its value', async () => {
  const { page, mutate } = waitPage();
  page.count = 0;
  const pending = vm.runInContext(waitJsSrc({ js: 'count >= 2 && count', timeout: 5000 }), page);
  page.count = 1;
  mutate();
  await new Promise((r) => setImmediate(r));
  page.count = 2;
  mutate();
  assert.equal(await pending, 2);
  assert.equal(await vm.runInContext(waitJsSrc({ js: 'true', timeout: 100 }), page), 'condition met');
  vm.runInContext('el = new Element(); el.tagName = "DIV"', page);
  assert.equal(await vm.runInContext(waitJsSrc({ js: 'await Promise.resolve(el)', timeout: 100 }), page), 'found <div>');
});

test('wait --js timeout names the last value or the last error', async () => {
  const { page } = waitPage();
  await assert.rejects(vm.runInContext(waitJsSrc({ js: 'missing.prop', timeout: 50 }), page), /timeout after 50ms waiting for the --js condition — it last threw: missing is not defined/);
  page.n = 0;
  await assert.rejects(vm.runInContext(waitJsSrc({ js: 'n', timeout: 50 }), page), /\(last value: 0\)/);
});

// --- Links (A2): the real Links section in a vm with a fake WebSocket.
const linksSource = source.slice(source.indexOf('// --- Links ---'), source.indexOf('// --- Driven-tab marking'));

const commandsSource = fs.readFileSync(new URL('../extension/commands.js', import.meta.url), 'utf8');

function linksHarness({ owners = new Map(), driven = [], idReady = Promise.resolve(), cloud, localAgents, localRead, handle, fetchImpl } = {}) {
  const sockets = [];
  const logs = [];
  const timers = [];
  const handled = [];
  const painted = [];
  let alarm;
  class FakeWS {
    static OPEN = 1;
    constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(data === 'ping' ? data : JSON.parse(data)); }
    // A browser fires onclose asynchronously — by then connect() has moved link.socket on.
    close() { this.readyState = 3; setImmediate(() => this.onclose?.({ code: 1000, reason: '' })); }
    open() { this.readyState = 1; this.onopen(); }
    drop(code = 1006, reason = '') { this.readyState = 3; this.onclose({ code, reason }); }
    recv(obj) { return this.onmessage({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }); }
  }
  const drivenTabs = new Set(driven);
  const storage = { cloud, localAgents };
  const created = [];
  const badge = [];
  const intervals = [];
  const context = vm.createContext({
    WS_URL: 'ws://127.0.0.1:9333/ws', BOOT_TS_P: Promise.resolve(123), PROFILE_ID: 'pid', PROFILE_NAME: 'oak', INSTALL_TYPE: 'dev',
    idReady, installReady: Promise.resolve(), WebSocket: FakeWS, crypto: { randomUUID: () => 'req-1' },
    setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout() {},
    setInterval: (fn, ms) => intervals.push({ fn, ms }) && intervals.length, clearInterval() {},
    URL, fetch: fetchImpl, AbortSignal, btoa, TextEncoder,
    chrome: {
      runtime: { getManifest: () => ({ version: '9.9.9' }) }, alarms: { create() {}, onAlarm: { addListener: (fn) => { alarm = fn; } } },
      storage: { local: { get: async (k) => (k === 'localAgents' && localRead ? { localAgents: await localRead } : { [k]: storage[k] }), set: async (o) => Object.assign(storage, structuredClone(o)) } },
      tabs: { create: async (o) => created.push(o) },
      action: { setBadgeText: async (o) => badge.push(['text', o.text]), setBadgeBackgroundColor: async () => {}, setTitle: async (o) => badge.push(['title', o.title]) },
    },
    logLine: (line) => logs.push(line), drivenTabs, ownerOf: (tabId) => (drivenTabs.has(tabId) ? owners.get(tabId) || 'local' : null),
    inflight: new Map(), pillBusy: new Map(), tabActivity: new Map(), idleLabel: () => 'AI idle',
    pillWrite: (tabId, [label]) => painted.push([tabId, label]),
    handle: async (msg) => { handled.push({ ...msg }); return handle ? handle(msg) : 'ok'; },
    wrapErr: (e) => String(e?.message ?? e), errText: (e) => String(e?.message ?? e),
    pageErrorsFor: async () => null, currentActivity: () => false,
  });
  vm.runInContext(commandsSource, context); // the worker's importScripts('commands.js')
  vm.runInContext(linksSource + '\nthis.links = links; this.linkOpen = linkOpen; this.cloudState = cloudState; this.cloudPair = cloudPair; this.cloudSignOut = cloudSignOut; this.cloudHeartbeatCheck = cloudHeartbeatCheck; this.connect = connect; this.setLocal = (on) => { localOn = on; };', context);
  const flush = () => new Promise((r) => setImmediate(r));
  const fire = (ms) => timers.splice(0).filter((t) => t.ms === ms || (timers.push(t), false)).forEach((t) => t.fn());
  return { context, sockets, timers, handled, painted, logs, flush, fire, alarm: () => alarm(), storage, created, intervals, badge };
}

test('links: boot dials local with its handshake query, journal queues until open', async () => {
  const h = linksHarness();
  await h.flush();
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].url, 'ws://127.0.0.1:9333/ws?v=9.9.9&id=pid&name=oak&install=dev&boot=123');
  h.context.journal('boot', null, 'v9.9.9');
  assert.deepEqual(h.sockets[0].sent, [], 'not open yet — queued, not lost');
  h.sockets[0].open();
  assert.deepEqual(h.sockets[0].sent.map((e) => e.kind), ['boot']);
  assert.equal(h.context.linkOpen('local'), true);
});

test('links: the boot watchdog logs a wedge only when the profile-id read lost the race', async () => {
  const healthy = linksHarness();
  await healthy.flush();
  healthy.fire(5000);
  await healthy.flush();
  assert.deepEqual(healthy.logs, [], 'a healthy boot never claims a wedge (the timer used to log unconditionally)');
  assert.equal(healthy.sockets.length, 1);
  const wedged = linksHarness({ idReady: new Promise(() => {}) });
  await wedged.flush();
  assert.equal(wedged.sockets.length, 0, 'the first dial waits for the profile id');
  wedged.fire(5000);
  await wedged.flush();
  assert.deepEqual(wedged.logs, ['profile-id storage read wedged (5s) — connecting without a stable id']);
  assert.equal(wedged.sockets.length, 1, 'a wedged read connects idless instead of staying offline');
});

test('links: every link strips caller _fields, tags _link and replies on the receiving socket', async () => {
  const h = linksHarness();
  await h.flush();
  const local = h.sockets[0];
  local.open();
  await local.recv({ id: 1, type: 'snap', urlMatch: 'x', _tabId: 99, _pill: true, _markedByMe: true, _warn: 'forged', _link: 'cloud' });
  assert.deepEqual(h.handled[0], { id: 1, type: 'snap', urlMatch: 'x', _link: 'local' });
  assert.deepEqual(local.sent, [{ id: 1, ok: true, result: 'ok' }], 'a forged _warn never reaches the reply');
  // A second link runs at the same time and keeps its own replies.
  h.context.addLink({ id: 'cloud', label: 'cloud', url: 'wss://hub.test/arm', retry: [1000, 30000], dial: async () => 'wss://hub.test/arm' });
  h.context.connect(h.context.links.get('cloud'));
  await h.flush();
  const cloud = h.sockets[1];
  cloud.open();
  await cloud.recv({ id: 2, type: 'click', urlMatch: 'y', _link: 'local' });
  assert.equal(h.handled[1]._link, 'cloud', 'a peer cannot claim to be another link');
  assert.deepEqual(cloud.sent, [{ id: 2, ok: true, result: 'ok' }]);
  assert.equal(local.sent.length, 1, 'the cloud reply never lands on the local socket');
  // Journal and diagnostics are local-only.
  h.context.journal('mark', 7);
  assert.equal(cloud.sent.length, 1);
  assert.equal(local.sent.at(-1).kind, 'mark');
  const pending = h.context.requestDiagnostics({ action: 'status' });
  assert.equal(local.sent.at(-1).type, 'diagnostics');
  await cloud.recv({ type: 'diagnostics-result', requestId: 'req-1', ok: true, result: 'from the hub' });
  await local.recv({ type: 'diagnostics-result', requestId: 'req-1', ok: true, result: 'from local' });
  assert.equal((await pending).result, 'from local', 'a remote link cannot answer the local settings request');
});

test('links: a drop reconnects that link with its backoff, paints only its tabs, and the alarm re-dials only dead links', async () => {
  const h = linksHarness({ driven: [7, 8], owners: new Map([[8, 'cloud']]) });
  await h.flush();
  const local = h.sockets[0];
  local.open();
  h.context.addLink({ id: 'cloud', label: 'cloud', url: 'wss://hub.test/arm', retry: [1000, 4000], dial: async () => 'wss://hub.test/arm' });
  h.context.connect(h.context.links.get('cloud'));
  await h.flush();
  const cloud = h.sockets[1];
  cloud.open();
  h.timers.length = 0;
  cloud.drop();
  assert.equal(h.context.linkOpen('cloud'), false);
  assert.equal(h.context.linkOpen('local'), true, 'one link down leaves the other up');
  assert.deepEqual(h.timers.map((t) => t.ms).sort((a, b) => a - b), [1000, 2500]);
  assert.equal(h.context.links.get('cloud').backoff, 2000, 'backoff doubles per drop');
  h.fire(2500);
  assert.deepEqual(h.painted, [[8, '⚠ bridge offline — reconnecting…']], 'only the dropped link\'s tab shows offline');
  h.fire(1000);
  await h.flush();
  assert.equal(h.sockets.length, 3);
  assert.equal(h.sockets[2].url, 'wss://hub.test/arm');
  h.sockets[2].open();
  assert.equal(h.context.links.get('cloud').backoff, 1000, 'an open resets the backoff');
  assert.deepEqual(h.painted.at(-1), [8, 'AI idle'], 'reconnect repaints the tabs that showed offline');
  // Local keeps its flat 500ms; the keepalive alarm re-dials only dead links.
  h.timers.length = 0;
  local.drop();
  assert.ok(h.timers.some((t) => t.ms === 500));
  assert.equal(h.context.links.get('local').backoff, 500);
  h.alarm();
  await h.flush();
  assert.equal(h.sockets.length, 4, 'one re-dial: local (cloud is open)');
  assert.match(h.sockets[3].url, /^ws:\/\/127\.0\.0\.1:9333\/ws\?v=/);
});

test('links: Local AI agents off — no dial at boot, on the alarm or after a drop, and no offline paint', async () => {
  const off = linksHarness({ localAgents: false });
  await off.flush();
  off.alarm();
  await off.flush();
  assert.equal(off.sockets.length, 0, 'switched off in storage: this profile never reaches the local server');
  const h = linksHarness({ driven: [7] });
  await h.flush();
  h.sockets[0].open();
  h.timers.length = 0;
  h.context.setLocal(false);
  h.sockets[0].drop();
  h.fire(2500);
  h.fire(500);
  h.alarm();
  await h.flush();
  assert.equal(h.sockets.length, 1, 'switched off live: the reconnect and the alarm stand down');
  assert.deepEqual(h.painted, [], 'off on purpose is not an outage');
});

test('links: an alarm that wakes the worker before the stored switch loads never dials a switched-off profile (review finding)', async () => {
  const h = linksHarness({ localAgents: false });
  h.alarm(); // same tick as the script load: the storage read hasn't landed
  await h.flush();
  h.alarm();
  await h.flush();
  assert.equal(h.sockets.length, 0);
});

test('links: a dial still awaiting when Local AI agents goes off opens no socket; a command on a closing socket runs nothing (review finding)', async () => {
  const h = linksHarness();
  await h.flush();
  h.sockets[0].drop();
  h.context.connect(h.context.links.get('local')); // passes the entry check…
  h.context.setLocal(false); // …then the switch flips while dial() awaits
  await h.flush();
  assert.equal(h.sockets.length, 1, 'the post-dial recheck stands down: no second socket');
  const live = linksHarness();
  await live.flush();
  live.sockets[0].open();
  live.context.setLocal(false);
  await live.sockets[0].recv({ id: 4, type: 'click', urlMatch: 'x' });
  assert.deepEqual(live.handled, [], 'nothing ran');
  assert.equal(live.sockets[0].sent[0].ok, false);
  assert.match(live.sockets[0].sent[0].error, /Local AI agents was switched off.*⚙ Settings/);
});

test('links: a stored "off" read slower than the boot watchdog hangs up the socket the watchdog opened (review finding)', async () => {
  let finishRead;
  const h = linksHarness({ localRead: new Promise((r) => { finishRead = r; }) });
  await h.flush();
  h.fire(5000); // the watchdog gives up on the read and connects with the default (on)
  await h.flush();
  h.sockets[0].open();
  finishRead(false);
  await h.flush();
  assert.equal(h.context.linkOpen('local'), false);
  assert.ok(h.sockets[0].sent.some((e) => e.kind === 'local-off'), 'the server learns why');
  h.alarm();
  await h.flush();
  assert.equal(h.sockets.length, 1, 'and it stays down');
});

test('links: a seat-taken loser stands down without a hot reconnect', async () => {
  const h = linksHarness();
  await h.flush();
  const local = h.sockets[0];
  local.open();
  h.context.journal('boot');
  h.timers.length = 0;
  await local.recv({ type: 'seat-taken' });
  assert.equal(h.context.links.get('local').socket, null);
  local.drop();
  assert.deepEqual(h.timers, [], 'the keepalive alarm re-probes instead');
  assert.equal(h.handled.length, 0);
});

// --- Tab ownership per link (A2): findTab's gate, in a vm.
function ownershipHarness({ driven = [], owners = [], reclaimed = [] } = {}) {
  const marked = [];
  const recorded = [];
  const tabs = [{ id: 7, url: 'https://a.test/x', title: 'A' }, { id: 8, url: 'https://b.test/', title: 'B' }, { id: 9, url: 'https://c.test/', title: 'C' }];
  const context = vm.createContext({
    drivenTabs: new Set(driven), tabOwner: new Map(owners), humanReclaimed: new Map(reclaimed.map((id) => [id, Date.now()])),
    links: new Map([['local', { label: 'local' }], ['cloud', { label: 'cloud' }]]),
    localOn: true, LOCAL_OFF_ERROR: 'Local AI agents was switched off',
    persist() {}, setFavicon: async () => {}, recordActivity: (tabId) => recorded.push(tabId),
    markTab: async (tabId) => { context.drivenTabs.add(tabId); marked.push(tabId); },
    chrome: { tabs: { query: async () => tabs } },
  });
  const findTabSource = source.slice(source.indexOf('const CROSS_LINK_READS'), source.indexOf('async function cmdFetch('));
  vm.runInContext(findTabSource, context);
  return { context, marked, recorded };
}

test('ownership: with Local AI agents off, an in-flight local command cannot claim a tab; cloud still can (review finding)', async () => {
  const { context, marked } = ownershipHarness();
  context.localOn = false;
  await assert.rejects(context.findTab({ type: 'click', urlMatch: 'a.test', _link: 'local' }), /Local AI agents was switched off/);
  assert.deepEqual(marked, [], 'nothing claimed after the switch handed the tabs back');
  assert.equal((await context.findTab({ type: 'click', urlMatch: 'a.test', _link: 'cloud' })).id, 7);
  assert.equal(context.tabOwner.get(7), 'cloud');
});

test('ownership: another link may only read a driven tab — every other command is refused before it marks or records', async () => {
  const { context, marked, recorded } = ownershipHarness({ driven: [7], owners: [[7, 'cloud']] });
  for (const type of ['click', 'fill', 'eval', 'wait', 'navigate', 'close', 'note', 'mark', 'release', 'activate', 'emulate', 'unemulate', 'grid', 'scroll', 'fetch', 'dialog', 'upload']) {
    await assert.rejects(
      context.findTab({ type, urlMatch: 'a.test', _link: 'local' }),
      /driven through the cloud link — from local you can only read it \(snap, shot, measure, console, ask, perf, net\), nothing ran\. To act on that page, open your own tab/,
      type
    );
  }
  assert.deepEqual(marked, []);
  assert.deepEqual(recorded, []);
  for (const type of ['snap', 'shot', 'measure', 'console', 'ask', 'perf', 'net']) {
    assert.equal((await context.findTab({ type, urlMatch: 'a.test', _link: 'local' })).id, 7, type);
  }
  assert.equal(context.tabOwner.get(7), 'cloud', 'a read never moves ownership');
  assert.deepEqual(marked, [], 'a read on a driven tab never re-marks it');
  // The owner drives as before.
  assert.equal((await context.findTab({ type: 'click', urlMatch: 'a.test', _link: 'cloud' })).id, 7);
});

test('ownership: the first command claims an undriven tab for its link; legacy driven tabs are local', async () => {
  const { context, marked } = ownershipHarness({ driven: [9] }); // 9: driven, no recorded owner (pre-links state)
  const msg = { type: 'click', urlMatch: 'b.test', _link: 'local' };
  await context.findTab(msg);
  assert.equal(context.tabOwner.get(8), 'local');
  assert.equal(msg._markedByMe, true);
  assert.deepEqual(marked, [8]);
  // The cloud link may read the local tab but not act on it.
  await context.findTab({ type: 'snap', urlMatch: 'b.test', _link: 'cloud' });
  await assert.rejects(context.findTab({ type: 'click', urlMatch: 'b.test', _link: 'cloud' }), /driven through the local link — from cloud/);
  await assert.rejects(context.findTab({ type: 'click', urlMatch: 'c.test', _link: 'cloud' }), /driven through the local link/);
  // A foreign read on an UNdriven tab claims it for the reader (every command marks).
  await context.findTab({ type: 'snap', urlMatch: 'a.test', _link: 'cloud' });
  assert.equal(context.tabOwner.get(7), 'cloud');
});

test('ownership: a foreign mark cannot launder the human\'s ⏏ reclaim', async () => {
  const { context } = ownershipHarness({ driven: [7], owners: [[7, 'cloud']], reclaimed: [8] });
  context.drivenTabs.add(8);
  context.tabOwner.set(8, 'cloud');
  await assert.rejects(context.findTab({ type: 'mark', urlMatch: 'b.test', _link: 'local' }), /driven through the cloud link/);
  assert.equal(context.humanReclaimed.has(8), true);
});

// --- Cloud arm: the hub link speaks MCP over the same commands ---------------
const plain = (v) => JSON.parse(JSON.stringify(v)); // vm-realm objects fail deepStrictEqual's prototype check
const PAIRED = { hub: 'http://localhost:8787', token: 'cba_dGVzdA.' + 'x'.repeat(43), enabled: true };
async function cloudArm(opts = {}) {
  const h = linksHarness({ cloud: PAIRED, ...opts });
  await h.flush();
  const ws = h.sockets.find((s) => s.url.includes('/arm'));
  ws.open();
  let n = 0;
  const call = async (name, args) => {
    const id = ++n;
    await ws.recv({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    await h.flush();
    const reply = ws.sent.find((m) => m.id === id);
    assert.ok(reply, 'tools/call must be answered');
    return reply.result;
  };
  const text = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { ...h, ws, call, text };
}

test('cloud: dormant until paired — no hub, no token, no dial (boot or alarm)', async () => {
  const h = linksHarness();
  await h.flush();
  h.alarm();
  await h.flush();
  assert.equal(h.sockets.filter((s) => s.url.includes('/arm')).length, 0);
  assert.equal(h.context.cloudState().paired, false);
});

test('cloud: a paired profile dials /arm with its token as a subprotocol, says hello and heartbeats', async () => {
  const { ws, intervals } = await cloudArm();
  assert.equal(ws.url, 'ws://localhost:8787/arm');
  assert.deepEqual(plain(ws.protocols), ['cloud-bridge.v1', 'cbtoken.' + PAIRED.token]);
  assert.equal(ws.sent[0].method, 'arm/hello');
  assert.deepEqual({ ...ws.sent[0].params, offlineHint: undefined }, { kind: 'chrome', name: 'oak', version: '9.9.9', selector: 'profile', offlineHint: undefined });
  assert.match(ws.sent[0].params.offlineHint, /profile chrome-bridge calls "oak".*Cloud AI apps is on in the chrome-bridge popup's ⚙ Settings/);
  assert.equal(intervals[0].ms, 20000);
  intervals[0].fn();
  assert.equal(ws.sent.at(-1), 'ping');
});

test('cloud: tools/list offers chrome, chrome_batch and the typed tools, minus the ones turned Off', async () => {
  const { ws, flush } = await cloudArm();
  await ws.recv({ jsonrpc: '2.0', id: 'l1', method: 'tools/list' });
  await flush();
  const tools = ws.sent.find((m) => m.id === 'l1').result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['chrome', 'chrome_batch', 'chrome_tabs', 'chrome_snap', 'chrome_shot', 'chrome_measure', 'chrome_wait', 'chrome_release', 'chrome_open', 'chrome_nav', 'chrome_click', 'chrome_fill', 'chrome_press', 'chrome_upload', 'chrome_close']);
  assert.match(tools[0].description, /Commands: .*\bsnap\b.*\bclick\b/);
  assert.doesNotMatch(tools[0].description, /\bextreload\b|\bstart\b/, 'local-only commands are not advertised');
  assert.ok(tools.every((t) => !('command' in t) && t.annotations && t.inputSchema.type === 'object'), 'the registry link (command) stays internal; every tool is annotated');
  await ws.recv({ jsonrpc: '2.0', method: 'arm/policy', params: { commands: { click: 'off', eval: 'off' } } });
  await ws.recv({ jsonrpc: '2.0', id: 'l2', method: 'tools/list' });
  await flush();
  const names = ws.sent.find((m) => m.id === 'l2').result.tools.map((t) => t.name);
  assert.ok(!names.includes('chrome_click') && names.includes('chrome') && names.includes('chrome_fill'), 'an Off command loses its typed tool; chrome stays');
});

test('cloud: typed tools build the command line and run it through the same grammar and policy', async () => {
  const { call, handled, text, ws, flush } = await cloudArm();
  assert.equal(text(await call('chrome_snap', { tab: 'github', skeleton: true, find: 'the search box' })), 'ok');
  assert.deepEqual({ ...plain(handled.at(-1)), deadlineAt: undefined }, { deadlineAt: undefined, type: 'snap', urlMatch: 'github', scope: null, diff: false, href: false, skeleton: true, find: 'the search box', _link: 'cloud' });
  await call('chrome_fill', { tab: 'github', target: '@e5', value: '--not a flag' });
  assert.deepEqual([handled.at(-1).type, handled.at(-1).value, handled.at(-1).diff], ['fill', '--not a flag', true], 'the value rides after --, actions observe with --diff');
  await call('chrome_press', { tab: 'github', key: 'Enter', target: '@e5' });
  assert.deepEqual([handled.at(-1).key, handled.at(-1).target], ['Enter', '@e5']);
  await call('chrome_wait', { tab: 'github', text: 'Saved changes', timeout: 5000 });
  assert.deepEqual([handled.at(-1).text, handled.at(-1).timeout], ['Saved changes', 5000]);
  const missing = await call('chrome_click', { tab: 'github' });
  assert.equal(missing.isError, true);
  assert.equal(text(missing), 'chrome_click needs target: an @eN ref from chrome_snap (e.g. "@e12"), or a CSS selector.');
  assert.match(text(await call('chrome_shot', { tab: 'x', max: 'big' })), /^chrome_shot's max must be a number$/);
  assert.match(text(await call('chrome_nope', {})), /^Unknown tool chrome_nope: this Chrome offers chrome, chrome_batch, chrome_tabs, .*Call tools\/list to refresh\.$/);
  await ws.recv({ jsonrpc: '2.0', method: 'arm/policy', params: { commands: { fill: 'off' } } });
  await flush();
  const n = handled.length;
  assert.match(text(await call('chrome_fill', { tab: 'github', target: '@e5', value: 'x' })), /^fill is turned off for Cloud Bridge/, 'a cached typed tool is still refused');
  assert.equal(handled.length, n);
});

test('cloud: shot needs no file name, and its typed tool returns the image', async () => {
  const { call, handled } = await cloudArm({ handle: () => 'data:image/jpeg;base64,/9j/' });
  for (const r of [await call('chrome', { command: 'shot github' }), await call('chrome', { command: 'shot github --max 800' }), await call('chrome_shot', { tab: 'github', max: 800, format: 'jpeg' })])
    assert.deepEqual(plain(r), { content: [{ type: 'image', data: '/9j/', mimeType: 'image/jpeg' }], isError: false });
  assert.deepEqual(handled.map((m) => [m.type, m.max, m.format]), [['shot', undefined, undefined], ['shot', 800, undefined], ['shot', 800, 'jpeg']]);
});

test('cloud: upload takes data: URLs, and public URLs downloaded by the hub — never the browser, never the disk', async () => {
  const fetched = [];
  const fetchImpl = async (url) => fetched.push(url); // the browser must not download anything (review: LAN reachable from here)
  const h = await cloudArm({ fetchImpl });
  const { call, handled, text, ws } = h;
  const asked = [];
  const send = ws.send.bind(ws);
  ws.send = (data) => {
    send(data);
    const m = typeof data === 'string' && data !== 'ping' ? JSON.parse(data) : null;
    if (m?.method !== 'arm/download') return;
    asked.push(m.params.url);
    const answers = {
      'https://files.test/docs/report%201.pdf': { result: { name: 'report 1.pdf', mimeType: 'application/pdf', data: 'JVBERg==' } },
      'https://files.test/huge': { result: { name: 'h', mimeType: 'x', data: 'A'.repeat(15 * 1048576) } },
      'http://localhost./x': { error: { code: -32000, message: 'localhost. is a private-network address; Cloud Bridge only downloads upload files from public addresses — send the file as base64 instead' } },
      'https://old.hub/x': { error: { code: -32601, message: 'Method not found: arm/download' } },
    };
    if (m.params.url === 'https://never.answers/x') return;
    setImmediate(() => ws.recv({ jsonrpc: '2.0', id: m.id, ...answers[m.params.url] }));
  };
  await call('chrome', { command: 'upload github @e3 https://files.test/docs/report%201.pdf data:text/plain,hi%20there#notes.txt' });
  assert.deepEqual(plain(handled.at(-1).files), [
    { name: 'report 1.pdf', mimeType: 'application/pdf', data: 'JVBERg==' },
    { name: 'notes.txt', mimeType: 'text/plain', data: 'aGkgdGhlcmU=' },
  ]);
  assert.deepEqual(asked, ['https://files.test/docs/report%201.pdf'], 'the hub downloads the URL');
  await call('chrome_upload', { tab: 'github', target: '#file', files: [{ name: 'a.png', base64: 'iVBORw0KGgo=', mimeType: 'image/png' }], chooser: true });
  assert.deepEqual({ ...plain(handled.at(-1)), deadlineAt: undefined }, { deadlineAt: undefined, type: 'upload', urlMatch: 'github', target: '#file', files: [{ name: 'a.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' }], chooser: true, _link: 'cloud' });
  const n = handled.length;
  const refusals = [
    ['upload github @e1 a.png', /^a\.png is not a URL\. Cloud Bridge can't read files on the user's computer: give a public http\(s\) URL/],
    ['upload github @e1 /Users/me/a.png', /is not a URL/],
    ['upload github @e1 file:///etc/passwd', /is not a URL/],
    ['upload github @e1 http://localhost./x', /^localhost\. is a private-network address/],
    ['upload github @e1 https://files.test/huge', /11\.3 MB — Cloud Bridge uploads take up to 10 MB/],
    ['upload github @e1 https://old.hub/x', /^this Cloud Bridge can't download files for uploads yet \(an older hub\) — send the file as base64 instead$/],
    ['upload github @e1 data:text/plain;base64,a-b_#x', /base64 for x has characters/],
    ['upload github @e1 data:text/plain,%E0%A4%A#x', /broken %-escape/],
  ];
  for (const [command, want] of refusals) {
    const r = await call('chrome', { command });
    assert.equal(r.isError, true, command + " → " + text(r).slice(0, 200));
    assert.match(text(r), want, command + " → " + text(r).slice(0, 200));
  }
  assert.equal(handled.length, n, 'nothing ran for a refused file');
  assert.deepEqual(fetched, [], 'the browser never fetched a URL itself');
  assert.match(text(await call('chrome_upload', { tab: 'github', target: '#f', files: [{ name: 'x' }] })), /files\[0\] must be \{url\} or \{name, base64, mimeType\}/);
  // The link drops while the hub downloads: the call fails with the reason instead of hanging.
  const pending = ws.recv({ jsonrpc: '2.0', id: 'up', method: 'tools/call', params: { name: 'chrome', arguments: { command: 'upload github @e1 https://never.answers/x' } } });
  await h.flush();
  ws.drop();
  await pending;
  await h.flush();
  assert.match(ws.sent.find((m) => m.id === 'up').result.content[0].text, /^the connection to Cloud Bridge dropped before it answered$/);
});

test('cloud: every command carries a dispatch deadline like the local server\'s (--diff actions refused without one, found live)', async () => {
  const { call, handled } = await cloudArm();
  const t0 = Date.now();
  await call('chrome_click', { tab: 'github', target: '@e1' });
  await call('chrome', { command: 'wait github --human' });
  const [click, human] = handled;
  assert.ok(click.diff && Number.isFinite(click.deadlineAt), 'actAndVerify refuses a --diff action without a finite deadlineAt');
  assert.ok(click.deadlineAt >= t0 + 60000 && click.deadlineAt <= Date.now() + 70000, 'about the server\'s 70s, inside the hub\'s 120s');
  assert.ok(human.deadlineAt >= t0 + 120000, 'a human hand-off gets its own timeout');
});

test('cloud: a command line runs through the CLI grammar, tagged with the cloud link', async () => {
  const { call, handled, text } = await cloudArm();
  const r = await call('chrome', { command: 'snap github' });
  assert.equal(r.isError, false);
  assert.equal(text(r), 'ok');
  assert.equal(handled[0].type, 'snap');
  assert.equal(handled[0].urlMatch, 'github');
  assert.equal(handled[0]._link, 'cloud');
});

test('cloud: refusals name the next step and run nothing', async () => {
  const { call, handled, text, ws, flush } = await cloudArm();
  assert.match(text(await call('chrome', { command: 'start' })), /^start manages the user's local chrome-bridge install; it isn't available through Cloud Bridge\.$/);
  assert.match(text(await call('chrome', { command: 'frobnicate x' })), /^Unknown command: frobnicate\. Commands: tabs, /);
  assert.match(text(await call('chrome', { command: '--profile elm tabs' })), /--profile elm is not this Chrome \("oak"\)/);
  assert.match(text(await call('chrome', { command: '--profile --x tabs' })), /^--profile needs an id or name: pick the Chrome with the tool's profile argument instead$/, 'no cli.mjs in cloud errors');
  assert.match(text(await call('chrome', { command: 'fetch github https://github.com/x --out f.json' })), /fetch --out writes a file on the user's machine/);
  await ws.recv({ jsonrpc: '2.0', method: 'arm/policy', params: { commands: { click: 'off', eval: 'ask' } } });
  await flush();
  const off = await call('chrome', { command: 'click github @e1' });
  assert.equal(off.isError, true);
  assert.match(text(off), /^click is turned off for Cloud Bridge in the user's settings, nothing ran\./);
  assert.match(text(await call('chrome', { command: 'wait github --js "1"' })), /^eval needs the user's confirmation/, 'wait --js runs page code: eval\'s rule covers it');
  assert.equal(text(await call('chrome', { command: 'wait github --text Saved' })), 'ok', 'wait without --js is not page code');
  assert.deepEqual(handled.map((m) => m.type), ['wait']);
});

test('cloud: chrome_batch runs in order and stops at the first failure', async () => {
  const { call, handled, text } = await cloudArm();
  const r = await call('chrome_batch', { lines: ['tabs', '# a comment', 'start', 'tabs'] });
  assert.equal(r.isError, true);
  assert.deepEqual(handled.map((m) => m.type), ['tabs']);
  assert.match(text(r), /^\$ tabs\nok\n\$ start\nstart manages .*\nstopped here: the 1 line\(s\) after it did not run$/s);
});

test('cloud: a failing command, an empty snap and a thrown handle come back as tool errors', async () => {
  const { call, text } = await cloudArm({ handle: (msg) => { if (msg.type === 'click') throw new Error('no tab matching "x"'); return ''; } });
  const failed = await call('chrome', { command: 'click x @e1' });
  assert.equal(failed.isError, true);
  assert.equal(text(failed), 'no tab matching "x"');
  const empty = await call('chrome', { command: 'snap x' });
  assert.equal(empty.isError, true);
  assert.match(text(empty), /^empty tree — the page is likely still loading/);
});

test('cloud: shot comes back as MCP image content', async () => {
  const { call } = await cloudArm({ handle: () => 'data:image/png;base64,iVBORw0KGgo=' });
  const r = await call('chrome', { command: 'shot github page.png' });
  assert.deepEqual(plain(r), { content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }], isError: false });
});

test('cloud: fetch with no matching tab rides a scratch tab on the target origin, then closes it (cli.mjs #35)', async () => {
  let fetches = 0;
  const handle = (msg) => {
    if (msg.type === 'fetch' && fetches++ === 0) throw new Error('no tab matching "api.example.com"');
    if (msg.type === 'open') return { id: 5 };
    if (msg.type === 'fetch') return { status: 200, ct: 'application/json', body: '{"a":1}' };
    return 'ok';
  };
  const { call, handled, text } = await cloudArm({ handle });
  const r = await call('chrome', { command: 'fetch api.example.com https://api.example.com/v1' });
  assert.deepEqual(handled.map((m) => [m.type, m.urlMatch ?? m.url]), [['fetch', 'api.example.com'], ['open', 'https://api.example.com/v1'], ['fetch', 'id:5'], ['close', 'id:5']]);
  assert.equal(text(r), 'no tab matching "api.example.com" — opened a scratch tab on api.example.com for this fetch\n200 application/json\n{"a":1}');
});

test('cloud: pong and unreadable frames are ignored without dropping the link', async () => {
  const { ws, flush, logs } = await cloudArm();
  await ws.recv('pong');
  await ws.recv('{not json');
  await flush();
  assert.equal(ws.readyState, 1);
  assert.deepEqual(logs, ['cloud: unreadable hub frame ignored']);
});

test('cloud: a 4401 close unpairs the profile and stops redialing', async () => {
  const { ws, storage, sockets, timers, flush, alarm, context } = await cloudArm();
  ws.drop(4401, 'unknown or revoked arm token: pair this arm again');
  await flush();
  assert.equal(storage.cloud.token, '');
  assert.equal(storage.cloud.enabled, false);
  assert.match(storage.cloud.notice, /Pair it again/);
  timers.splice(0).forEach((t) => t.fn());
  alarm();
  await flush();
  assert.equal(sockets.filter((s) => s.url.includes('/arm')).length, 1, 'no redial after an unpair');
  assert.equal(context.cloudState().paired, false);
});

test('cloud: pairing starts a device code, opens the approval tab, polls, then dials with the token', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push([path, JSON.parse(init.body)]);
    const body = path === '/pair/start'
      ? { code: 'ABCD-EFGH', pollToken: 'pt', verificationUri: 'http://localhost:8787/pair?code=ABCD-EFGH', interval: 3, expiresIn: 600 }
      : calls.filter((c) => c[0] === '/pair/poll').length === 1 ? { status: 'pending' } : { status: 'approved', armToken: 'cba_new.' + 'y'.repeat(43), armUrl: 'ws://localhost:8787/arm' };
    return { status: 200, json: async () => body };
  };
  const h = linksHarness({ fetchImpl });
  await h.flush();
  assert.deepEqual(plain(await h.context.cloudPair('ftp://nope')), { ok: false, error: 'Enter the Cloud Bridge hub URL, e.g. https://cloud-bridge.<you>.workers.dev' });
  const started = await h.context.cloudPair('http://localhost:8787/some/path');
  assert.equal(started.ok, true);
  assert.deepEqual(started.pairing.code, 'ABCD-EFGH');
  assert.deepEqual(calls[0], ['/pair/start', { kind: 'chrome', name: 'oak' }]);
  assert.deepEqual(plain(h.created), [{ url: 'http://localhost:8787/pair?code=ABCD-EFGH' }]);
  // The confirm page compares against the toolbar icon: the popup closes when that page opens.
  assert.deepEqual(h.badge.slice(-2), [['text', 'ABCD'], ['title', 'chrome-bridge — Cloud Bridge code ABCD-EFGH']]);
  for (let i = 0; i < 2; i++) {
    h.fire(3000);
    await h.flush();
    await h.flush();
  }
  assert.deepEqual(calls.slice(1).map((c) => c[1]), [{ code: 'ABCD-EFGH', pollToken: 'pt' }, { code: 'ABCD-EFGH', pollToken: 'pt' }]);
  assert.equal(h.storage.cloud.hub, 'http://localhost:8787');
  assert.equal(h.storage.cloud.enabled, true);
  assert.equal(h.storage.cloud.pairing, null);
  assert.deepEqual(h.badge.slice(-2), [['text', ''], ['title', 'chrome-bridge']], 'paired: the code badge goes');
  await h.flush();
  const arm = h.sockets.find((s) => s.url.includes('/arm'));
  assert.deepEqual(plain(arm?.protocols), ['cloud-bridge.v1', 'cbtoken.cba_new.' + 'y'.repeat(43)]);
});

test('cloud: doctor flattens the extension reply like server.mjs, and --fix releases residue (review finding)', async () => {
  const handle = (msg) => (msg.type === 'doctor' ? { rows: [{ id: 3, url: 'https://a/', grouped: true }, { id: 4, url: 'https://b/', driven: true }], stale: [99] } : 'ok');
  const { call, handled, text } = await cloudArm({ handle });
  const r = await call('chrome', { command: 'doctor --fix' });
  assert.equal(r.isError, false, text(r));
  assert.deepEqual(handled.map((m) => [m.type, m.urlMatch]), [['doctor', undefined], ['release', 'id:3']]);
  assert.deepEqual(JSON.parse(text(r)), [{ id: 3, url: 'https://a/', grouped: true, fixed: 'released' }, { staleMemory: [99], pruned: true }]);
});

test('cloud: the open/close/release the arm runs itself obey the policy too (review finding)', async () => {
  const handle = (msg) => {
    if (msg.type === 'fetch') throw new Error('no tab matching "zzz"');
    if (msg.type === 'doctor') return { rows: [{ id: 3, url: 'https://a/', grouped: true }], stale: [] };
    return 'ok';
  };
  const { call, handled, text, ws, flush } = await cloudArm({ handle });
  await ws.recv({ jsonrpc: '2.0', method: 'arm/policy', params: { commands: { open: 'off', release: 'off' } } });
  await flush();
  const f = await call('chrome', { command: 'fetch zzz https://evil.example/x' });
  assert.equal(f.isError, true);
  assert.match(text(f), /^no tab matching "zzz"\nA scratch tab on evil\.example would need it: open is turned off/);
  const d = await call('chrome', { command: 'doctor --fix' });
  assert.match(text(d), /"fixed":"release failed: release is turned off/);
  assert.deepEqual(handled.map((m) => m.type), ['fetch', 'doctor'], 'no open, no release ran');
});

test('cloud: an empty address never falls back to the stored hub (review finding)', async () => {
  const calls = [];
  const h = linksHarness({ cloud: { hub: 'https://cloud-bridge.ivan-seredkin.workers.dev', token: '', enabled: false, pairing: null, notice: '' }, fetchImpl: async (url) => { calls.push(url); return { status: 200, json: async () => ({}) }; } });
  await h.flush();
  assert.equal((await h.context.cloudPair('')).ok, false);
  assert.deepEqual(calls, [], 'no /pair/start to a hub the user didn\'t type');
  assert.equal(h.created.length, 0, 'no confirm tab');
});

test('cloud: a failed re-pair keeps the paired hub (review finding)', async () => {
  const fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
  const h = linksHarness({ cloud: PAIRED, fetchImpl });
  await h.flush();
  await assert.rejects(h.context.cloudPair('http://typo.example'), /Failed to fetch/);
  assert.equal(h.context.cloudState().hub, 'http://localhost:8787');
  h.context.connect(h.context.links.get('cloud'));
  await h.flush();
  assert.equal(h.sockets.at(-1).url, 'ws://localhost:8787/arm', 'the token still goes to the hub that issued it');
});

test('cloud: switching off signs out at the hub too, and the hub\'s own 4401 for that socket shows no "forgot you" notice', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push([new URL(url).pathname, init.method, init.headers.Authorization]); return { ok: true, status: 200, json: async () => ({ ok: true, revoked: true }) }; };
  const { context, ws, storage, flush, sockets } = await cloudArm({ fetchImpl });
  const r = await context.cloudSignOut();
  assert.equal(r.ok, true);
  assert.equal(r.notice, '');
  assert.deepEqual(calls, [['/arm/revoke', 'POST', 'Bearer ' + PAIRED.token]]);
  assert.equal(storage.cloud.token, '');
  assert.equal(storage.cloud.enabled, false);
  ws.drop(4401, 'signed out of Cloud Bridge'); // the hub closing the socket we just left
  await flush();
  assert.equal(storage.cloud.notice, '', 'leaving is not "the hub no longer knows this profile"');
  assert.equal(sockets.filter((s) => s.url.includes('/arm')).length, 1, 'no redial');
});

test('cloud: signing out with the hub unreachable signs out here and retries there on the keepalive alarm until it answers', async () => {
  let up = false;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.headers.Authorization]);
    if (!up) throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, json: async () => ({ ok: true, revoked: true }) };
  };
  const { context, storage, logs, alarm, flush } = await cloudArm({ fetchImpl });
  const r = await context.cloudSignOut();
  assert.equal(r.ok, true);
  assert.equal(storage.cloud.token, '');
  assert.match(r.notice, /^Signed out here\. Cloud Bridge couldn't be reached, so AI apps may list this profile until it can be; chrome-bridge keeps trying\.$/);
  assert.ok(logs.some((l) => l.includes('was unreachable')));
  assert.deepEqual(plain(storage.cloud.unrevoked), [{ hub: PAIRED.hub, token: PAIRED.token }], 'kept only to retry the sign-out');
  alarm();
  await flush();
  await flush();
  assert.equal(storage.cloud.unrevoked.length, 1, 'still down: still pending');
  up = true;
  alarm();
  await flush();
  await flush();
  assert.deepEqual(plain(storage.cloud.unrevoked), [], 'the hub answered: the token is gone for good');
  assert.deepEqual(calls.map((c) => c[1]), Array(3).fill('Bearer ' + PAIRED.token));
});

test('cloud: pairing again revokes the old token at its hub', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push([url, init.headers.Authorization ?? null]);
    if (path === '/pair/start') return { ok: true, status: 200, json: async () => ({ code: 'ABCD-EFGH', pollToken: 'pt', verificationUri: 'https://hub.example/pair?code=ABCD-EFGH', interval: 3, expiresIn: 600 }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, revoked: true }) };
  };
  const { context, ws, storage, flush } = await cloudArm({ fetchImpl });
  await context.cloudPair('https://hub.example');
  await flush();
  assert.deepEqual(calls.map((c) => c[0]), ['https://hub.example/pair/start', 'http://localhost:8787/arm/revoke'], 'the old token goes to the hub that issued it');
  assert.equal(calls[1][1], 'Bearer ' + PAIRED.token);
  ws.drop(4401, 'signed out of Cloud Bridge');
  await flush();
  assert.equal(storage.cloud.notice, '');
  assert.equal(storage.cloud.pairing.code, 'ABCD-EFGH', 'the new pairing survives the old socket closing');
});

test('cloud: a token signed out while a retry pass is in flight is kept for the next pass (review finding)', async () => {
  const OLD = { hub: 'http://localhost:8787', token: 'cba_b2xk.' + 'o'.repeat(43) };
  let release;
  const gate = new Promise((r) => (release = r));
  // The pass's fetch (OLD) hangs until released; the sign-out's fails at once, so it lands mid-pass.
  const fetchImpl = async (url, init) => { if (init.headers.Authorization.includes(OLD.token)) await gate; throw new TypeError('Failed to fetch'); };
  const { context, storage, alarm, flush } = await cloudArm({ fetchImpl, cloud: { ...PAIRED, unrevoked: [OLD] } });
  alarm(); // a pass over [OLD] starts and waits on the hub
  await flush();
  await context.cloudSignOut(); // fails too: adds the current token while the pass waits
  assert.equal(storage.cloud.unrevoked.length, 2);
  release();
  for (let i = 0; i < 4; i++) await flush();
  assert.deepEqual(plain(storage.cloud.unrevoked).map((t) => t.token), [OLD.token, PAIRED.token]);
});

test('cloud: no pong for 70s closes the socket so it redials; pongs keep it (a dead-but-open socket hung calls 120s, found live)', async () => {
  const { context, ws, logs, flush, sockets } = await cloudArm();
  const t0 = ws._lastPong;
  assert.ok(t0, 'the clock starts at open');
  context.cloudHeartbeatCheck(t0 + 60000);
  assert.equal(ws.readyState, 1, 'within the window: stays');
  ws._lastPong = t0 - 1e6; // long silent…
  await ws.recv('pong'); // …until a pong
  assert.ok(ws._lastPong >= t0, 'a pong restarts the window');
  context.cloudHeartbeatCheck(ws._lastPong + 60000);
  assert.equal(ws.readyState, 1);
  context.cloudHeartbeatCheck(ws._lastPong + 71000);
  assert.equal(ws.readyState, 3);
  assert.ok(logs.some((l) => /no heartbeat from the hub for 71s — reconnecting/.test(l)));
  await flush();
  await flush();
  assert.equal(sockets.filter((s) => s.url.includes('/arm')).length, 1, 'onclose schedules the redial (backoff timer)');
});
