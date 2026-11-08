import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const evalSource = source.slice(source.indexOf('async function runEval('), source.indexOf('// --- --diff on actions:'));

test('application EvalError never replays an eval payload', async () => {
  let executions = 0;
  const context = vm.createContext({
    worldCache: new Map(),
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
  const sender = { id: 'bridge', url: 'chrome-extension://bridge/popup.html' };
  vm.runInNewContext(listenerSource, {
    chrome: { runtime: { id: 'bridge', getURL: (path) => 'chrome-extension://bridge/' + path, onMessage: { addListener: (handler) => { listener = handler; } } } },
    ready, idReady: Promise.resolve(), PROFILE_NAME: 'poplar', drivenTabs, humanReclaimed,
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
  });
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
  return { send, drivenTabs, humanReclaimed, diagnostics, events, raw: (message, origin) => listener(message, origin, () => {}) };
}

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
  assert.equal((await send({ type: 'release-all' })).count, 1);
  assert.equal((await send({ type: 'bridge-state' })).count, 0);
});

test('popup listener rejects unauthorized senders without mutations', async () => {
  const { send, drivenTabs, diagnostics, humanReclaimed } = popupListener();
  for (const sender of [
    { id: 'other', url: 'chrome-extension://bridge/popup.html' },
    { id: 'bridge', url: 'https://example.test/' },
    { id: 'bridge', url: 'chrome-extension://bridge/popup.html', tab: { id: 7 } },
  ]) {
    for (const type of ['diagnostics', 'bridge-state', 'release-active', 'release-all']) {
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
  assert.match((await send({ type: 'release-all' })).error, /release unavailable/);
  assert.equal(drivenTabs.has(7), true);
  assert.equal(drivenTabs.has(8), false);
  assert.equal(humanReclaimed.has(7), false);
  assert.equal(humanReclaimed.has(8), true);
});

test('popup listener returns hydration failures through the callback', async () => {
  for (const type of ['bridge-state', 'release-active', 'release-all']) {
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
const uploadSource = source.slice(source.indexOf('async function cmdUpload('), source.indexOf('const shotFallbackQ ='));
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
    mutations: () => commands.filter(({ method }) => method.startsWith('Input.') || method === 'DOM.setFileInputFiles'),
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
    tabStatus: new Map(), worldCache: new Map(), pillInject, injectBanner,
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

function evalHarness({ blocked = [], cached } = {}) {
  const attempts = [];
  let executions = 0;
  let attached = 0;
  const pages = Object.fromEntries(['ISOLATED', 'MAIN'].map((world) => {
    const page = vm.createContext({ mutate: () => { executions++; } });
    if (blocked.includes(world)) vm.runInContext('eval = () => { throw new EvalError("Refused to evaluate a string as JavaScript because CSP blocks unsafe-eval"); }', page);
    return [world, page];
  }));
  const context = vm.createContext({
    worldCache: new Map(cached ? [[7, cached]] : []),
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
    for (const cached of [undefined, 'MAIN']) {
      const harness = evalHarness({ cached });
      await assert.rejects(harness.context.runEval(7, code), /Refused to evaluate/);
      assert.equal(harness.executions(), 1);
      assert.deepEqual(harness.attempts, [cached || 'ISOLATED']);
      assert.equal(harness.attached(), 0);
    }
  }
});

test('real eval capability refusal falls back without executing payload in blocked worlds', async () => {
  for (const blocked of [['ISOLATED'], ['ISOLATED', 'MAIN']]) {
    const harness = evalHarness({ blocked });
    assert.equal(await harness.context.runEval(7, 'mutate(); 42'), 42);
    assert.equal(harness.executions(), 1);
    assert.deepEqual(harness.attempts, blocked.length === 1 ? ['ISOLATED', 'MAIN'] : ['ISOLATED', 'MAIN', 'CDP']);
    assert.equal(harness.attached(), 0);
  }
});

test('explicit ISOLATED eval never uses MAIN or CDP when capability is blocked', async () => {
  const harness = evalHarness({ blocked: ['ISOLATED'], cached: 'MAIN' });
  await assert.rejects(harness.context.runEval(7, 'mutate()', 'ISOLATED'), /--world isolated can't run caller code: Chrome \(MV3\) forbids eval.*refusing a main-world fallback/);
  assert.equal(harness.executions(), 0);
  assert.deepEqual(harness.attempts, ['ISOLATED']);
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
    chrome: { ...context.chrome, action: { setBadgeText: async () => {} } },
  });
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

function linksHarness({ owners = new Map(), driven = [], idReady = Promise.resolve() } = {}) {
  const sockets = [];
  const logs = [];
  const timers = [];
  const handled = [];
  const painted = [];
  let alarm;
  class FakeWS {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    // A browser fires onclose asynchronously — by then connect() has moved link.socket on.
    close() { this.readyState = 3; setImmediate(() => this.onclose?.()); }
    open() { this.readyState = 1; this.onopen(); }
    drop() { this.readyState = 3; this.onclose(); }
    recv(obj) { return this.onmessage({ data: JSON.stringify(obj) }); }
  }
  const drivenTabs = new Set(driven);
  const context = vm.createContext({
    WS_URL: 'ws://127.0.0.1:9333/ws', BOOT_TS_P: Promise.resolve(123), PROFILE_ID: 'pid', PROFILE_NAME: 'oak', INSTALL_TYPE: 'dev',
    idReady, installReady: Promise.resolve(), WebSocket: FakeWS, crypto: { randomUUID: () => 'req-1' },
    setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout() {},
    chrome: { runtime: { getManifest: () => ({ version: '9.9.9' }) }, alarms: { create() {}, onAlarm: { addListener: (fn) => { alarm = fn; } } } },
    logLine: (line) => logs.push(line), drivenTabs, ownerOf: (tabId) => (drivenTabs.has(tabId) ? owners.get(tabId) || 'local' : null),
    inflight: new Map(), pillBusy: new Map(), tabActivity: new Map(), idleLabel: () => 'AI idle',
    pillWrite: (tabId, [label]) => painted.push([tabId, label]),
    handle: async (msg) => { handled.push({ ...msg }); return 'ok'; },
    pageErrorsFor: async () => null, currentActivity: () => false,
  });
  vm.runInContext(linksSource + '\nthis.links = links; this.linkOpen = linkOpen;', context);
  const flush = () => new Promise((r) => setImmediate(r));
  const fire = (ms) => timers.splice(0).filter((t) => t.ms === ms || (timers.push(t), false)).forEach((t) => t.fn());
  return { context, sockets, timers, handled, painted, logs, flush, fire, alarm: () => alarm() };
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
    persist() {}, setFavicon: async () => {}, recordActivity: (tabId) => recorded.push(tabId),
    markTab: async (tabId) => { context.drivenTabs.add(tabId); marked.push(tabId); },
    chrome: { tabs: { query: async () => tabs } },
  });
  const findTabSource = source.slice(source.indexOf('const CROSS_LINK_READS'), source.indexOf('async function cmdFetch('));
  vm.runInContext(findTabSource, context);
  return { context, marked, recorded };
}

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
