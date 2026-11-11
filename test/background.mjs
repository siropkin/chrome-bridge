import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { mac, nonce } from '../localauth.mjs';

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
    ready, idReady: Promise.resolve(), cloudReady: Promise.resolve(), cloudState: () => ({ paired: false }), PROFILE_NAME: 'poplar', drivenTabs, humanReclaimed, localAuth: { state: 'ok' },
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
  // Asked first (D3b): only the tabs the person allowed closing, never one that matched since.
  removed.length = 0;
  context.drivenTabs.clear();
  context.chrome.tabs.query = async () => [{ id: 7 }, { id: 8 }, { id: 9 }];
  assert.deepEqual({ ...(await context.close({ type: 'close', all: true, urlMatch: 'example', _link: 'cloud', _askTabs: [7, 9] })) }, { closed: 2 });
  assert.deepEqual(removed, [7, 9]);
  await assert.rejects(context.close({ type: 'close', all: true, urlMatch: 'example', _link: 'cloud', _askTabs: [] }), /^Error: no tab matching "example" — already closed\?/);
  assert.deepEqual(removed, [7, 9]);
});

test('cloud links reach public web pages only: no localhost, LAN, *.local or file: (S1, decision cloud-private-net)', () => {
  const offSource = source.slice(source.indexOf('function privateHost('), source.indexOf('// --- end off-limits'));
  const context = vm.createContext({ URL });
  vm.runInContext(offSource, context);
  const run = (type, url, link = 'cloud') => context.refuseOffLimits({ type, url, urlMatch: 'x', _link: link });
  for (const url of [
    'http://127.0.0.1:9333/log', // the local agent's command feed
    'http://localhost:3000/', 'http://app.localhost/', 'http://[::1]:9333/health', 'http://192.168.1.1/admin', 'http://10.0.0.5/',
    'http://172.20.1.1/', 'http://169.254.169.254/latest/meta-data', 'http://100.64.0.1/', 'http://printer.local./', 'http://0/',
    'http://0x7f.1/', 'http://2130706433/', 'http://[::ffff:127.0.0.1]/', 'http://[fd00::1]/', 'http://[fe80::1]/',
    'file:///etc/passwd', 'view-source:http://127.0.0.1:9333/log', 'data:text/html,<b>x</b>', 'about:settings',
  ]) {
    for (const type of ['open', 'navigate', 'fetch']) assert.throws(() => run(type, url), /is on this computer or its local network — Cloud AI apps reach public web pages only .*nothing ran\. Ask the user to do this with an AI agent on their computer/, `${type} ${url}`);
  }
  for (const url of ['https://example.com/', 'http://8.8.8.8/', 'about:blank', 'https://172.15.0.1/', 'https://localhost.example.com/']) assert.doesNotThrow(() => run('open', url), url);
  // Local agents keep their reach; other commands aren't URL commands.
  assert.doesNotThrow(() => run('open', 'http://127.0.0.1:9333/log', 'local'));
  assert.doesNotThrow(() => context.refuseOffLimits({ type: 'click', urlMatch: '192.168.1.1', _link: 'cloud' }));
  // Tripwire: handle() applies it before any command branch runs.
  const handleHead = source.slice(source.indexOf('async function handle(msg) {'), source.indexOf("if (msg.type === 'ping')"));
  assert.match(handleHead, /refuseOffLimits\(msg\);/);
});

test('cloud links neither act on nor read a tab that ended up off-limits, whatever took it there (review: eval, a click, a redirect)', async () => {
  const offSource = source.slice(source.indexOf('function privateHost('), source.indexOf('// --- end off-limits'));
  const tabs = new Map([[7, { id: 7, url: 'http://192.168.1.1/admin' }], [8, { id: 8, url: 'https://example.com/', pendingUrl: 'http://localhost:8080/' }], [9, { id: 9, url: 'https://example.com/' }]]);
  const context = vm.createContext({ URL, drivenTabs: new Set([7, 8, 9]), tabOwner: new Map([[7, 'cloud'], [8, 'cloud'], [9, 'local']]), chrome: { tabs: { get: async (id) => tabs.get(id) } } });
  vm.runInContext(offSource + '\nconst ownerOf = (tabId) => (drivenTabs.has(tabId) ? tabOwner.get(tabId) || "local" : null);', context);
  // blob: pages count as their origin; an uncommitted tab has nothing to judge.
  assert.equal(context.offLimitsUrl('blob:https://example.com/0f1e'), null);
  assert.equal(context.offLimitsUrl('blob:http://192.168.1.1/0f1e'), '192.168.1.1');
  assert.equal(context.offLimitsUrl(''), null);
  for (const type of ['snap', 'eval', 'shot', 'click', 'net', 'fetch', 'mark'])
    assert.throws(() => context.refuseOffLimitsTab(tabs.get(7), { type, _link: 'cloud' }), /^Error: this tab is on 192\.168\.1\.1, which is on this computer or its local network — .*nothing ran/, type);
  assert.throws(() => context.refuseOffLimitsTab(tabs.get(8), { type: 'snap', _link: 'cloud' }), /this tab is on localhost:8080/, 'a pending navigation counts');
  // Still showing the router while a public navigation pends: reads would run in the router page (review).
  assert.throws(() => context.refuseOffLimitsTab({ id: 10, url: 'http://192.168.1.1/', pendingUrl: 'https://attacker.example/hang' }, { type: 'snap', _link: 'cloud' }), /this tab is on 192\.168\.1\.1/);
  // Backing out stays possible: nav's own target is checked by refuseOffLimits.
  for (const type of ['release', 'close', 'unemulate', 'navigate']) assert.doesNotThrow(() => context.refuseOffLimitsTab(tabs.get(7), { type, _link: 'cloud' }), type);
  assert.doesNotThrow(() => context.refuseOffLimitsTab(tabs.get(7), { type: 'snap', _link: 'local' }));
  // After an action navigated: a cloud-driven tab's snapshot is withheld; a local one's isn't.
  assert.match(await context.offLimitsLanding(7), /^192\.168\.1\.1 — on this computer or its local network, so Cloud AI apps get no snapshot of it\. Go back/);
  assert.equal(await context.offLimitsLanding(9), null);
  tabs.set(9, { id: 9, url: 'http://10.0.0.1/' });
  assert.equal(await context.offLimitsLanding(9), null, 'the local link keeps its reach');
  // Tripwires: every place that resolves a tab or snaps a page it navigated to.
  const findTabSrc = source.slice(source.indexOf('async function findTab(msg) {'), source.indexOf('async function cmdFetch('));
  assert.match(findTabSrc, /assertLinkMayDrive\(tab\.id, msg\);\n\s*refuseOffLimitsTab\(tab, msg\);/);
  const landings = source.match(/const offLimits = await offLimitsLanding\(tabI?d?\.?i?d?\);\n\s*if \(offLimits\) return [^\n]+\n\s*const (wall|snap) = await runEval/g) || [];
  assert.equal(landings.length, 3, 'the --diff verdict, nav --diff and wait --human check before reading the page');
  const fetchSrcCode = source.slice(source.indexOf('async function cmdFetch('), source.indexOf("Network.loadNetworkResource', {"));
  assert.match(fetchSrcCode, /offLimitsUrl\(landed\)[\s\S]*catch \(e\) \{\n\s*if \(e\?\.offLimits\) throw e;/, 'a redirect off-limits is refused, not retried through the browser-network fallback');
});

test('cloud blocked websites (D3): no open, read or act there, subdomains included, listed without address — the local link untouched', async () => {
  const offSource = source.slice(source.indexOf('function privateHost('), source.indexOf('// --- end off-limits'));
  const tabs = new Map([[7, { id: 7, url: 'https://secure.chase.com/accounts' }], [9, { id: 9, url: 'https://example.com/' }]]);
  const context = vm.createContext({ URL, drivenTabs: new Set([7, 9]), tabOwner: new Map([[7, 'cloud'], [9, 'cloud']]), chrome: { tabs: { get: async (id) => tabs.get(id) } } });
  vm.runInContext(offSource + '\nconst ownerOf = (tabId) => (drivenTabs.has(tabId) ? tabOwner.get(tabId) || "local" : null);\ncloudBlocked = ["chase.com", "mail.example.org"];\nthis.withheld = withheld;', context);
  const blocked = "www.chase.com is a website the user blocked for Cloud AI apps in their Cloud Bridge settings; nothing ran. Do the task without it, or ask the user to do this part themselves";
  for (const type of ['open', 'navigate', 'fetch']) assert.throws(() => context.refuseOffLimits({ type, url: 'https://www.chase.com/login', _link: 'cloud' }), (e) => e.message === blocked && e.offLimits, type);
  assert.throws(() => context.refuseOffLimits({ type: 'open', url: 'https://MAIL.Example.org./inbox', _link: 'cloud' }), /^Error: MAIL\.Example\.org\.|^Error: mail\.example\.org\. is a website the user blocked/, 'any case, a trailing dot');
  assert.throws(() => context.refuseOffLimits({ type: 'open', url: 'https://chase.com:8443/', _link: 'cloud' }), /^Error: chase\.com:8443 is a website the user blocked/, 'any port');
  for (const url of ['https://notchase.com/', 'https://chase.com.evil.example/', 'https://example.org/']) assert.doesNotThrow(() => context.refuseOffLimits({ type: 'open', url, _link: 'cloud' }), url);
  assert.doesNotThrow(() => context.refuseOffLimits({ type: 'open', url: 'https://chase.com/', _link: 'local' }), 'local agents keep their reach');
  // A tab there is neither read nor acted on; backing out stays possible.
  for (const type of ['snap', 'shot', 'click', 'eval', 'net'])
    assert.throws(() => context.refuseOffLimitsTab(tabs.get(7), { type, _link: 'cloud' }), /^Error: this tab is on secure\.chase\.com, which is a website the user blocked for Cloud AI apps in their Cloud Bridge settings; nothing ran\./, type);
  for (const type of ['release', 'close', 'unemulate', 'navigate']) assert.doesNotThrow(() => context.refuseOffLimitsTab(tabs.get(7), { type, _link: 'cloud' }), type);
  assert.doesNotThrow(() => context.refuseOffLimitsTab(tabs.get(7), { type: 'snap', _link: 'local' }));
  const row = (t) => ({ id: t.id, url: t.url, title: 'Chase' });
  assert.deepEqual(JSON.parse(JSON.stringify(context.tabRowFor('cloud', tabs.get(7), row(tabs.get(7))))), { id: 7, url: '', title: '', offLimits: "secure.chase.com: a website the user blocked for Cloud AI apps, so they can't read or use this tab" });
  assert.deepEqual(JSON.parse(JSON.stringify(context.tabRowFor('local', tabs.get(7), row(tabs.get(7))))), row(tabs.get(7)));
  // A cloud action that lands there, or a command whose tab moved there, gets nothing back.
  assert.equal(await context.offLimitsLanding(7), 'secure.chase.com — a website the user blocked for Cloud AI apps, so they get no snapshot of it. Go back (nav <match> <another url>) or close it');
  assert.equal(context.withheld('secure.chase.com', 'ran'), 'this tab is now on secure.chase.com, a website the user blocked for Cloud AI apps, so they get nothing back from it (the command ran). Go back (nav <match> <another url>) or close it');
  assert.match(context.withheld('192.168.1.1', 'ran'), /^this tab is now on 192\.168\.1\.1, on this computer or its local network/, 'the local-network wording is unchanged');
  // An allowed page's requests to a blocked site carry its cookies: left out of a cloud net capture.
  assert.equal(context.netOffLimits('https://api.chase.com/v1/balance'), true);
  assert.equal(context.netOffLimits('wss://live.chase.com/'), true);
  assert.equal(context.netOffLimits('https://example.com/api'), false);
  // A fetch redirect and a capture whose tab went there name it the same way.
  assert.match(context.offLimitsError('the request was redirected to chase.com, which', 'its answer is withheld', 'chase.com').message, /^the request was redirected to chase\.com, which is a website the user blocked for Cloud AI apps in their Cloud Bridge settings; its answer is withheld\./);
  vm.runInContext('cloudBlocked = []', context);
  assert.doesNotThrow(() => context.refuseOffLimits({ type: 'open', url: 'https://www.chase.com/', _link: 'cloud' }), 'unblocked: allowed again');
});

test('cloud policy (D3): arm/policy sets the rules, the blocked websites and the settings link; anything malformed counts as nothing set', async () => {
  const { ws, flush, context } = await cloudArm();
  const policy = () => JSON.parse(JSON.stringify(context.links.get('cloud').policy));
  await ws.recv({ jsonrpc: '2.0', method: 'arm/policy', params: { commands: { eval: 'off' }, blockedDomains: [' Chase.COM. ', 7, '', 'mail.example.org'], settingsUrl: 'https://hub.example/app/settings?profile=a1' } });
  await flush();
  assert.deepEqual(policy(), { commands: { eval: 'off' }, blockedDomains: ['chase.com', 'mail.example.org'], settingsUrl: 'https://hub.example/app/settings?profile=a1' });
  assert.equal(context.blockedSite('www.chase.com'), 'chase.com', 'the off-limits checks see the new list at once');
  assert.equal(context.blockedSite('example.org'), null);
  await ws.recv({ jsonrpc: '2.0', method: 'arm/policy', params: { commands: ['off'], blockedDomains: 'chase.com', settingsUrl: 'javascript:alert(1)' } });
  await flush();
  assert.deepEqual(policy(), { commands: {}, blockedDomains: [], settingsUrl: '' });
  assert.equal(context.blockedSite('www.chase.com'), null, 'a malformed list blocks nothing (the hub sends the whole policy every time)');
});

function netHarness({ tabUrl = 'https://example.com/', mainFrame, blocked = [] } = {}) {
  const netSource = source.slice(source.indexOf('// --- Network capture (CDP)'), source.indexOf('// --- Page-side scripts'));
  const offSource = source.slice(source.indexOf('function privateHost('), source.indexOf('// --- end off-limits'));
  let listener;
  const bodies = [];
  const context = vm.createContext({
    URL, setTimeout,
    attachDbg: async () => {}, detachDbg: async () => {},
    chrome: {
      debugger: { onEvent: { addListener: (fn) => (listener = fn) }, sendCommand: async (_src, method, params) => { if (method === 'Network.getResponseBody') { bodies.push(params.requestId); return { body: 'BODY-' + params.requestId, base64Encoded: false }; } if (method === 'Page.getFrameTree' && mainFrame) return { frameTree: { frame: { id: mainFrame } } }; return {}; } },
      tabs: { get: async () => ({ id: 7, url: tabUrl }) },
      runtime: { getManifest: () => ({ version: 'test' }) },
    },
  });
  vm.runInContext(offSource + '\n' + netSource + '\ncloudBlocked = ' + JSON.stringify(blocked) + ';', context);
  const request = (id, url, type = 'XHR', frameId = mainFrame) => {
    listener({ tabId: 7 }, 'Network.requestWillBeSent', { requestId: id, wallTime: 1, type, frameId, request: { url, method: 'GET', headers: {} }, initiator: { type: 'other' } });
    listener({ tabId: 7 }, 'Network.responseReceived', { requestId: id, response: { status: 200, mimeType: 'application/json', headers: {} } });
    listener({ tabId: 7 }, 'Network.loadingFinished', { requestId: id, encodedDataLength: 10 });
  };
  // Starts a capture, lets it attach, plays the requests, returns its result.
  const capture = async (publicOnly, play) => {
    const run = context.captureNetwork(7, 60, undefined, '/', true, false, publicOnly);
    await new Promise((r) => setTimeout(r, 10));
    play(request);
    return run;
  };
  return { capture, bodies };
}

test('cloud net with blocked websites: an iframe there loses only its own requests; the tab itself going there withholds the capture (D3 review: reCAPTCHA/YouTube embeds failed every capture)', async () => {
  const embed = (request) => {
    request('1', 'https://example.com/api/items');
    request('2', 'https://www.google.com/recaptcha/api2/anchor', 'Document', 'child-frame');
    request('3', 'https://www.google.com/recaptcha/api2/reload');
  };
  {
    const { capture, bodies } = netHarness({ mainFrame: 'main', blocked: ['google.com'] });
    const out = await capture(true, embed);
    assert.match(out.lines, /GET 200 \/api\/items/);
    assert.doesNotMatch(out.lines, /recaptcha/);
    assert.deepEqual(bodies, ['1'], 'no body is read from the blocked site');
  }
  {
    const { capture } = netHarness({ mainFrame: 'main', blocked: ['google.com'] });
    await assert.rejects(capture(true, (request) => request('9', 'https://accounts.google.com/signin', 'Document', 'main')), /^Error: the tab went to accounts\.google\.com during the capture, which is a website the user blocked for Cloud AI apps in their Cloud Bridge settings; nothing from the capture comes back\./);
  }
  {
    // The main frame unknown: every document load counts, as before.
    const { capture } = netHarness({ blocked: ['google.com'] });
    await assert.rejects(capture(true, embed), /the tab went to www\.google\.com during the capture/);
  }
});

test('cloud net: requests to localhost/LAN are left out, bodies never fetched, and a page that went there withholds the capture (review)', async () => {
  const lan = (request) => {
    request('1', 'https://example.com/api/items');
    request('2', 'http://192.168.1.1/cgi-bin/status.json');
    request('3', 'http://localhost:9333/log');
  };
  {
    const { capture, bodies } = netHarness();
    const out = await capture(true, lan);
    assert.match(out.lines, /GET 200 \/api\/items/);
    assert.doesNotMatch(out.lines, /cgi-bin|9333|\/log/);
    assert.deepEqual([...out.har.log.entries.map((e) => e.request.url)], ['https://example.com/api/items']);
    assert.deepEqual(bodies, ['1'], 'no body is read from a LAN response');
  }
  {
    // The local link sees everything, as before.
    const { capture, bodies } = netHarness();
    const out = await capture(false, lan);
    assert.match(out.lines, /cgi-bin\/status\.json/);
    assert.deepEqual(bodies, ['1', '2', '3']);
  }
  {
    const { capture } = netHarness();
    await assert.rejects(capture(true, (request) => { request('1', 'https://example.com/api/items'); request('9', 'http://192.168.1.1/', 'Document'); }), /^Error: the tab went to 192\.168\.1\.1 during the capture, which is on this computer or its local network — .*nothing from the capture comes back\./);
  }
  {
    const { capture } = netHarness({ tabUrl: 'http://10.0.0.1/' });
    await assert.rejects(capture(true, () => {}), /the tab went to 10\.0\.0\.1 during the capture/);
  }
});

test('open: a URL that only downloads (Chrome closes its tab) says so, not "re-find it" (found live)', async () => {
  const openedSource = source.slice(source.indexOf('async function openedTabUrl('), source.indexOf('// Bounded wait for a tab'));
  const tabs = new Map([[5, { url: '' }], [6, { url: 'https://example.test/x' }]]);
  const context = vm.createContext({ chrome: { tabs: { get: async (id) => { if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`); return tabs.get(id); } } } });
  vm.runInContext(openedSource, context);
  assert.equal(await context.openedTabUrl(6, 'https://example.test/'), 'https://example.test/x');
  assert.equal(await context.openedTabUrl(5, 'https://example.test/'), 'https://example.test/', 'a pending tab still gets a usable <match>');
  await assert.rejects(context.openedTabUrl(7, 'https://hub.test/files/x/data.json'), (err) => {
    assert.equal(err.message, "the new tab closed before a page loaded — https://hub.test/files/x/data.json most likely started a download (Chrome closes a tab that only downloads a file; the file is in the browser's downloads), or someone closed the tab. There is no tab to drive");
    assert.doesNotMatch(err.message, /No tab with id/, 'the generic mapping would turn it into "run tabs to re-find it"');
    return true;
  });
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
function fetchHarness({ chunks = [], cap = 8, origin = 'https://example.test', onCookies, redirect = false, blocked = [] } = {}) {
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
    cloudLink: (link) => !!link && link !== 'local', cloudBlocked: blocked,
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

test('cloud fetch while the profile blocks websites: no retry outside the page, which follows redirects unseen (D3 review: a redirector reached a blocked site)', async () => {
  const chunks = () => [{ data: 'body', eof: true }];
  {
    const { context, calls } = fetchHarness({ blocked: ['mail.google.com'], chunks: chunks() });
    await assert.rejects(
      context.cmdFetch({ id: 7 }, { url: 'https://redirect.example/to?u=https://mail.google.com/feed', _link: 'cloud' }),
      (e) => e.message === "in-page blocked — the page refused the request, and Cloud AI apps get no retry outside the page while the user blocks websites in this Chrome profile (it can't see where a redirect lands). Fetch it from a tab on https://redirect.example: open https://redirect.example/, then fetch that tab"
    );
    assert.ok(!calls.some(([m]) => m === 'Network.loadNetworkResource'), 'the browser-network read never ran');
  }
  // Nothing blocked, or the local link: the fallback runs as before.
  for (const [blocked, link] of [[[], 'cloud'], [['mail.google.com'], 'local']]) {
    const { context, calls } = fetchHarness({ blocked, chunks: chunks() });
    assert.equal((await context.cmdFetch({ id: 7 }, { url: 'https://example.test/file', _link: link })).body, 'body');
    assert.ok(calls.some(([m]) => m === 'Network.loadNetworkResource'), `${link} with ${blocked.length} blocked`);
  }
});

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

// --- Ask (D3b): the question window, with fake chrome.windows and the page's messages.
const askSource = source.slice(source.indexOf('// --- Ask: the person'), source.indexOf('// --- Commands ---'));
function askFakes({ create } = {}) {
  const windows = [];
  const removed = [];
  const updated = [];
  let nextId = 100;
  let onRemoved = () => {};
  let onMessage = () => {};
  const chrome = {
    windows: {
      getLastFocused: async () => ({ id: 1, left: 100, top: 50, width: 1200, height: 800 }),
      create: async (o) => {
        if (create) await create(o);
        const w = { id: nextId++, ...o };
        windows.push(w);
        return w;
      },
      update: async (id, o) => updated.push([id, o]),
      remove: async (id) => removed.push(id),
      onRemoved: { addListener: (fn) => { onRemoved = fn; } },
    },
    runtime: { id: 'ext', getURL: (p) => 'chrome-extension://ext/' + p, onMessage: { addListener: (fn) => { onMessage = fn; } } },
  };
  // A message from the page in window w (or from any sender), answered like Chrome does.
  const send = (msg, sender) => new Promise((resolve) => { onMessage(msg, sender, resolve); });
  const page = (w, msg) => send({ ...msg, id: msg.id ?? w.url.split('#')[1] }, { id: 'ext', url: w.url, tab: { windowId: w.id } });
  return { chrome, windows, removed, updated, send, page, raw: (msg, sender, cb) => onMessage(msg, sender, cb), close: (id) => onRemoved(id) };
}

function askHarness(opts) {
  const fakes = askFakes(opts);
  const timers = [];
  const logs = [];
  const tabsRemoved = [];
  let n = 0;
  const leftover = [{ id: 40, url: 'chrome-extension://ext/ask.html#gone' }, { id: 41, url: 'https://example.com/' }];
  const context = vm.createContext({
    chrome: { ...fakes.chrome, tabs: { query: async () => leftover, remove: async (id) => tabsRemoved.push(id) } },
    crypto: { randomUUID: () => 'q' + ++n },
    setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout() {},
    logLine: (line) => logs.push(line), errMsg: (e) => String(e?.message ?? e),
  });
  vm.runInContext(askSource, context);
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  return { ...fakes, context, timers, logs, tabsRemoved, flush };
}
const ASKED = { app: 'Claude', command: 'eval', title: 'Run its own code in a page, including while waiting', site: 'github.com', line: 'eval github "document.title"', settingsUrl: 'https://hub.example/app/settings?profile=a1' };

test('ask window (D3b): one question at a time, in front over the window last used; its page reads it and answers once, then the window closes', { timeout: 10_000 }, async () => {
  const h = askHarness();
  const first = h.context.askUser({ ...ASKED, socket: { readyState: 1 } });
  const second = h.context.askUser({ ...ASKED, command: 'click', title: 'Click', site: null, line: 'click github @e5' });
  await h.flush();
  assert.equal(h.windows.length, 1, 'one window at a time');
  const [w] = h.windows;
  assert.deepEqual(plain(w), { id: 100, url: 'chrome-extension://ext/ask.html#q1', type: 'popup', focused: true, width: 460, height: 360, left: 470, top: 197 });
  assert.deepEqual(plain(h.updated), [[100, { drawAttention: true }]]);
  const view = plain(await h.page(w, { type: 'ask-get' }));
  assert.ok(view.expires > Date.now() + 40000 && view.expires <= Date.now() + 45000, '45 seconds to answer: inside an AI app\'s 60s call, with time left for the step');
  assert.deepEqual(view, { ok: true, ...ASKED, expires: view.expires }, 'everything the window shows, and never the hub connection');
  assert.deepEqual(plain(await h.page(w, { type: 'ask-answer', answer: 'once' })), { ok: true });
  assert.equal(await first, 'once');
  await h.flush();
  assert.deepEqual(h.removed, [100]);
  assert.deepEqual(plain(await h.page(w, { type: 'ask-answer', answer: 'once' })), { ok: false }, 'answered once only');
  assert.equal(h.windows.length, 2, 'the next question shows once the first is answered');
  assert.equal((await h.page(h.windows[1], { type: 'ask-get' })).site, null);
  await h.page(h.windows[1], { type: 'ask-answer', answer: 'deny' });
  assert.equal(await second, 'deny');
});

test('ask window (D3b): no answer within its 45 seconds, a closed window or a dropped hub connection is a no; a sixth question waiting is refused at once', { timeout: 10_000 }, async () => {
  const h = askHarness();
  const [s1, s2] = [{ readyState: 1 }, { readyState: 1 }];
  const asked = [s1, s2, s1, s2, s2].map((socket) => h.context.askUser({ ...ASKED, socket }));
  assert.equal(await h.context.askUser({ ...ASKED, socket: s2 }), 'busy');
  await h.flush();
  assert.deepEqual(h.timers.map((t) => t.ms), [45000, 45000, 45000, 45000, 45000], 'each its own 45 seconds, from when it was asked');
  h.timers[1].fn(); // the second runs out while it waits, unseen
  assert.equal(await asked[1], 'timeout');
  h.context.askCancel(s1); // its hub connection dropped: the shown one and the third go
  assert.deepEqual([await asked[0], await asked[2]], ['gone', 'gone']);
  await h.flush();
  assert.deepEqual(h.removed, [100]);
  assert.deepEqual(h.windows.map((w) => w.url.split('#')[1]), ['q1', 'q4'], 'no window flashed up for a question that went with it');
  h.close(101);
  assert.equal(await asked[3], 'closed');
  await h.flush();
  h.timers[4].fn(); // the last runs out while shown: its window goes
  assert.equal(await asked[4], 'timeout');
  await h.flush();
  assert.deepEqual(h.removed, [100, 101, 102]);
  assert.equal(h.windows.length, 3);
});

test('ask window (D3b): a question belongs to its call — none on a closed hub connection, none with under 5 seconds of the call\'s time left, otherwise only the time left (review: a batch asked after its AI app gave up)', { timeout: 10_000 }, async () => {
  const h = askHarness();
  assert.equal(await h.context.askUser({ ...ASKED, socket: { readyState: 3 } }), 'gone', 'the AI app was already told the call failed');
  assert.equal(await h.context.askUser({ ...ASKED, socket: { readyState: 1 }, deadline: Date.now() + 4000 }), 'late');
  const pending = h.context.askUser({ ...ASKED, socket: { readyState: 1 }, deadline: Date.now() + 20_000 });
  await h.flush();
  assert.equal(h.windows.length, 1, 'only the call with time left got a window');
  assert.ok(h.timers[0].ms > 19_000 && h.timers[0].ms <= 20_000, `the call's time left, not 45s (${h.timers[0].ms})`);
  const view = await h.page(h.windows[0], { type: 'ask-get' });
  assert.ok(view.expires <= Date.now() + 20_000, 'the window counts down the same time');
  h.timers[0].fn();
  assert.equal(await pending, 'timeout');
});

test('ask window (D3b): only the question\'s own page, in the window shown for it, can read or answer it', { timeout: 10_000 }, async () => {
  const h = askHarness();
  const pending = h.context.askUser(ASKED);
  await h.flush();
  const [w] = h.windows;
  const page = { id: 'ext', url: w.url, tab: { windowId: w.id } };
  for (const [msg, sender, why] of [
    [{ type: 'ask-answer', id: 'q1', answer: 'once' }, { ...page, url: 'https://github.com/' }, "a content script (its sender.url is its page's)"],
    [{ type: 'ask-get', id: 'q1' }, { ...page, url: 'https://github.com/' }, 'a content script reading it'],
    [{ type: 'ask-answer', id: 'q1', answer: 'once' }, { ...page, id: 'another-extension' }, 'another extension'],
    [{ type: 'ask-answer', id: 'q1', answer: 'once' }, { ...page, tab: { windowId: 999 } }, 'the page opened in another window'],
    [{ type: 'ask-answer', id: 'q1', answer: 'once' }, { id: 'ext', url: 'chrome-extension://ext/popup.html' }, 'the toolbar popup'],
    [{ type: 'ask-answer', id: 'q1', answer: 'always' }, page, 'not an answer this window offers'],
    [{ type: 'ask-answer', id: 'q9', answer: 'once' }, page, 'another question'],
  ])
    assert.deepEqual(plain(await h.send(msg, sender)), { ok: false }, why);
  // The popup's own messages are its listener's: this one neither answers nor holds them.
  let responded = false;
  assert.equal(h.raw({ type: 'bridge-state' }, { id: 'ext', url: 'chrome-extension://ext/popup.html' }, () => { responded = true; }), undefined);
  assert.equal(responded, false);
  await h.page(w, { type: 'ask-answer', answer: 'deny' });
  assert.equal(await pending, 'deny', 'still waiting for its own page');
});

test('ask window (D3b): a window Chrome can\'t open is a no, named in the log; a restarted worker closes windows whose questions it lost; each no tells the AI app what happened and what next', { timeout: 10_000 }, async () => {
  const h = askHarness({ create: async () => { throw new Error('No current window'); } });
  await h.flush();
  assert.deepEqual(h.tabsRemoved, [40], 'only the old question windows');
  assert.equal(await h.context.askUser(ASKED), 'failed');
  assert.match(h.logs.join('\n'), /ask: the question window did not open — No current window/);
  const { context } = h;
  assert.equal(context.askRefusal(ASKED, 'deny'), "The user said no when Chrome asked them to allow eval on github.com, so nothing ran. Don't run it again; do the task another way, or ask the user in the chat.");
  assert.equal(context.askRefusal(ASKED, 'timeout'), "eval is set to Ask in the user's Cloud Bridge settings: Chrome asked the user to allow eval on github.com, and no answer came in time (Chrome waits up to 45 seconds), so nothing ran. Ask the user in the chat to watch for the chrome-bridge window in Chrome and answer it, then try again.");
  assert.equal(context.askRefusal(ASKED, 'late'), "eval is set to Ask in the user's Cloud Bridge settings, and this call already spent its time waiting for the user's answers in Chrome, so eval on github.com didn't run. Run it, and anything after it, in a new call.");
  assert.equal(context.askRefusal({ ...ASKED, site: null }, 'closed'), "The user closed Chrome's question about eval without answering, so nothing ran. Ask the user in the chat before trying again.");
  assert.equal(context.askRefusal(ASKED, 'busy'), "5 questions are already waiting for the user's answer in Chrome, so nothing ran. Wait for those answers, call one step at a time, then try again.");
  assert.equal(context.askRefusal(ASKED, 'failed'), "eval is set to Ask in the user's Cloud Bridge settings, but Chrome couldn't show the user its question, so nothing ran. Ask the user to try again, or to allow eval there (https://hub.example/app/settings?profile=a1).");
});

// --- Links (A2): the real Links section in a vm with a fake WebSocket.
const linksSource = source.slice(source.indexOf('// --- Links ---'), source.indexOf('// --- Driven-tab marking'));

const commandsSource = fs.readFileSync(new URL('../extension/commands.js', import.meta.url), 'utf8');

// The key the fake native host hands out, and the server's half of the local
// handshake (the real one: server.mjs + localauth.mjs).
const LOCAL_KEY = 'k'.repeat(43);
const serverAuth = (url, key = LOCAL_KEY) => {
  const s = nonce();
  return { type: 'auth', s, p: mac(key, 'server', new URL(url).searchParams.get('c'), s) };
};
function linksHarness({ profileId = 'pid', owners = new Map(), driven = [], idReady = Promise.resolve(), cloud, localAgents, localRead, handle, fetchImpl, tabsGet = async () => null, nativeHost } = {}) {
  const sockets = [];
  const logs = [];
  const timers = [];
  const handled = [];
  const painted = [];
  let alarm;
  class FakeWS {
    static OPEN = 1;
    constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) {
      const m = data === 'ping' ? data : JSON.parse(data);
      if (m?.type === 'auth') this.auth = m; // the local handshake, kept apart from what the link sends
      else this.sent.push(m);
    }
    // A browser fires onclose asynchronously — by then connect() has moved link.socket on.
    close() { this.readyState = 3; setImmediate(() => this.onclose?.({ code: 1000, reason: '' })); }
    // Local sockets: the server proves itself first (await it); open(false) leaves that to the test.
    open(auth = true) {
      this.readyState = 1;
      this.onopen();
      if (auth && this.url.startsWith('ws://127.0.0.1')) return this.recv(serverAuth(this.url));
    }
    drop(code = 1006, reason = '') { this.readyState = 3; this.onclose({ code, reason }); }
    recv(obj) { return this.onmessage({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }); }
  }
  const drivenTabs = new Set(driven);
  const storage = { cloud, localAgents };
  const created = [];
  const badge = [];
  const intervals = [];
  const ask = askFakes();
  const context = vm.createContext({
    WS_URL: 'ws://127.0.0.1:9333/ws', BOOT_TS_P: Promise.resolve(123), PROFILE_ID: profileId, PROFILE_NAME: profileId ? 'oak' : '', INSTALL_TYPE: 'dev',
    idReady, installReady: Promise.resolve(), WebSocket: FakeWS, crypto: { randomUUID: () => 'req-1', getRandomValues: (a) => webcrypto.getRandomValues(a), subtle: webcrypto.subtle }, atob,
    setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout() {},
    setInterval: (fn, ms) => intervals.push({ fn, ms }) && intervals.length, clearInterval() {},
    URL, fetch: fetchImpl, AbortSignal, btoa, TextEncoder,
    chrome: {
      runtime: { ...ask.chrome.runtime, getManifest: () => ({ version: '9.9.9' }), sendNativeMessage: async (host, msg) => (nativeHost ? nativeHost(host, msg) : { k: LOCAL_KEY }) }, alarms: { create() {}, onAlarm: { addListener: (fn) => { alarm = fn; } } },
      storage: { local: { get: async (k) => (k === 'localAgents' && localRead ? { localAgents: await localRead } : { [k]: storage[k] }), set: async (o) => Object.assign(storage, structuredClone(o)) } },
      tabs: { create: async (o) => created.push(o), get: tabsGet, query: async () => [] },
      windows: ask.chrome.windows,
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
  vm.runInContext(source.slice(source.indexOf('const NAME_WORDS'), source.indexOf('const idReady')), context); // setProfileId
  // runCommand withholds replies from cloud tabs now on localhost/LAN (the off-limits helpers).
  vm.runInContext(source.slice(source.indexOf('function privateHost('), source.indexOf('// --- end off-limits')), context);
  vm.runInContext(askSource, context); // the cloud arm asks the person before a step set to Ask
  vm.runInContext(linksSource + '\nthis.links = links; this.linkOpen = linkOpen; this.cloudState = cloudState; this.cloudPair = cloudPair; this.cloudSignOut = cloudSignOut; this.cloudHeartbeatCheck = cloudHeartbeatCheck; this.connect = connect; this.setLocal = (on) => { localOn = on; }; this.localAuthState = () => localAuth;', context);
  const flush = () => new Promise((r) => setImmediate(r));
  const fire = (ms) => timers.splice(0).filter((t) => t.ms === ms || (timers.push(t), false)).forEach((t) => t.fn());
  return { context, sockets, timers, handled, painted, logs, flush, fire, alarm: () => alarm(), storage, created, intervals, badge, ask };
}

test('a web-page tab Chrome refuses as "another extension\'s page" is named a stuck tab with its remedy, not sent hunting for an extension (found live, 2026-11-10)', async () => {
  const tabs = new Map([[7, { id: 7, url: 'http://localhost:8787/app' }], [8, { id: 8, url: 'chrome-extension://abcdefghijklmnop/page.html' }]]);
  const raw = 'Cannot access a chrome-extension:// URL of different extension';
  const h = linksHarness({ tabsGet: async (id) => tabs.get(id), handle: async (msg) => { msg._tabId = Number(msg.urlMatch); throw new Error(raw); } });
  const stuck = await h.context.runCommand({ id: 'local' }, { type: 'snap', urlMatch: '7' });
  assert.equal(stuck.ok, false);
  assert.equal(stuck.error, "Chrome refuses scripts on this tab as if it showed another extension's page, though it shows a web page (a stuck tab, e.g. after a debugger session ended) — reload it (nav <match> <its url>); if it's still refused, close it and open the page in a new tab");
  // A tab really ON another extension's page keeps Chrome's own error (wrapErr names it).
  const real = await h.context.runCommand({ id: 'local' }, { type: 'snap', urlMatch: '8' });
  assert.equal(real.error, raw);
});

test('cloud tabs/doctor rows: a tab on this computer or its network is listed without its address or title (a localhost OAuth callback code leaked, 2026-11-10)', () => {
  const h = linksHarness();
  const row = (t) => ({ id: 1, url: t.url, title: t.title, active: true });
  const rowFor = (link, t) => JSON.parse(JSON.stringify(h.context.tabRowFor(link, t, row(t))));
  const local = { url: 'http://127.0.0.1:8790/callback?code=gh-1:abc', title: '127.0.0.1:8790/callback?code=gh-1:abc' };
  assert.deepEqual(rowFor('cloud', local), { id: 1, url: '', title: '', active: true, offLimits: "127.0.0.1:8790: on this computer or its local network, so Cloud AI apps can't read or use this tab" });
  assert.equal(rowFor('cloud', { url: 'file:///Users/me/secret.pdf', title: 'secret.pdf' }).offLimits, "file: pages: on this computer or its local network, so Cloud AI apps can't read or use this tab");
  assert.equal(rowFor('cloud', { url: 'https://example.com/', pendingUrl: 'http://192.168.1.1/', title: 'x' }).url, '', 'a tab on its way there counts too');
  assert.deepEqual(rowFor('local', local), row(local), 'the local link sees everything');
  const pub = { url: 'https://github.com/x', title: 'GitHub' };
  assert.deepEqual(rowFor('cloud', pub), row(pub));
  // The <match> resolver uses the same line (tabMatches skips such a tab for a cloud substring): nothing to probe the hidden URL with.
  assert.equal(Boolean(h.context.hiddenFrom('cloud', local)), true);
  assert.equal(h.context.hiddenFrom('local', local), null);
  assert.equal(h.context.hiddenFrom('cloud', pub), null);
});

test('cloud replies: nothing comes back from a tab that is now on localhost/LAN — not the result, not its page errors (review)', async () => {
  const tabs = new Map([[7, { id: 7, url: 'http://localhost:3000/' }]]);
  const h = linksHarness({
    tabsGet: async (id) => tabs.get(id),
    handle: async (msg) => {
      msg._tabId = 7;
      if (msg.type === 'navigate') return { id: 7, loaded: false };
      if (msg.type === 'open') return { id: 7, url: 'http://localhost:3000/', loaded: true };
      if (msg.type === 'eval') throw new Error('TypeError: token=router-secret');
      if (msg.type === 'click') throw Object.assign(new Error('this tab is on localhost:3000, which is on this computer or its local network — …'), { offLimits: true });
      return 'secret page text';
    },
  });
  let drained = 0;
  h.context.pageErrorsFor = async () => (drained++, { count: 1, lines: ['Error: dev server secret'] });
  const run = (link, msg) => h.context.runCommand({ id: link }, msg);
  const snap = await run('cloud', { type: 'snap', urlMatch: 'x' });
  assert.equal(snap.ok, false, 'an error every renderer handles (shot would have made the text an image)');
  assert.match(snap.error, /^this tab is now on localhost:3000, on this computer or its local network, so Cloud AI apps get nothing back from it \(the command ran\)\. Go back/);
  assert.equal(snap.pageErrors, undefined);
  // open keeps its id (fetch's scratch tab is closed by it): ids and addresses, no page content.
  const opened = await run('cloud', { type: 'open', url: 'https://public.example/r' });
  assert.deepEqual({ ...opened.result }, { id: 7, url: 'http://localhost:3000/', loaded: true });
  assert.equal(opened.pageErrors, undefined);
  // Backing out answers, but without the page's errors (nav to a 204 leaves the LAN page shown).
  const nav = await run('cloud', { type: 'navigate', urlMatch: 'x', url: 'https://httpbin.org/status/204' });
  assert.deepEqual({ ...nav.result }, { id: 7, loaded: false });
  assert.equal(nav.pageErrors, undefined);
  const failed = await run('cloud', { type: 'eval', urlMatch: 'x', code: '1' });
  assert.equal(failed.ok, false);
  assert.doesNotMatch(failed.error, /router-secret/);
  assert.match(failed.error, /\(the command failed\)/);
  const gate = await run('cloud', { type: 'click', urlMatch: 'x', target: '@e1' });
  assert.match(gate.error, /^this tab is on localhost:3000, which/, 'the gate\'s own refusal passes through');
  assert.equal(drained, 0, 'no page errors drained for a cloud reply from that tab');
  // The local link reads it as before; a public tab answers the cloud as before.
  const local = await run('local', { type: 'snap', urlMatch: 'x' });
  assert.equal(local.result, 'secret page text');
  assert.ok(local.pageErrors);
  tabs.set(7, { id: 7, url: 'https://example.com/' });
  const pub = await run('cloud', { type: 'snap', urlMatch: 'x' });
  assert.equal(pub.result, 'secret page text');
  assert.ok(pub.pageErrors);
});

test('links: boot dials local with its handshake query, journal queues until open', async () => {
  const h = linksHarness();
  await h.flush();
  assert.equal(h.sockets.length, 1);
  assert.match(h.sockets[0].url, /^ws:\/\/127\.0\.0\.1:9333\/ws\?v=9\.9\.9&id=pid&name=oak&install=dev&boot=123&c=[A-Za-z0-9_-]{24}$/);
  h.context.journal('boot', null, 'v9.9.9');
  assert.deepEqual(h.sockets[0].sent, [], 'not open yet — queued, not lost');
  await h.sockets[0].open();
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
  const wedged = linksHarness({ profileId: '', idReady: new Promise(() => {}) });
  await wedged.flush();
  assert.equal(wedged.sockets.length, 0, 'the first dial waits for the profile id');
  wedged.fire(5000);
  await wedged.flush();
  assert.deepEqual(wedged.logs, ['profile-id storage read wedged (5s) — connecting with an id for this session only']);
  assert.equal(wedged.sockets.length, 1, 'a wedged read connects instead of staying offline');
  const q = new URL(wedged.sockets[0].url).searchParams;
  assert.equal(q.get('id'), 'req-1', 'with an id for this session (crypto.randomUUID): the server seats no id-less dial');
  assert.ok(vm.runInContext('NAME_WORDS', wedged.context).includes(q.get('name')), 'and the name that id maps to');

});

test('links: every link strips caller _fields, tags _link and replies on the receiving socket', async () => {
  const h = linksHarness();
  await h.flush();
  const local = h.sockets[0];
  await local.open();
  await local.recv({ id: 1, type: 'snap', urlMatch: 'x', _tabId: 99, _pill: true, _markedByMe: true, _warn: 'forged', _link: 'cloud', _ask: { command: 'snap' }, _askAt: { tabId: 99, host: 'x' }, _askTabs: [99] });
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
  await local.open();
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
  await h.sockets[0].open();
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
  await live.sockets[0].open();
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
  await h.sockets[0].open();
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
  await local.open();
  h.context.journal('boot');
  h.timers.length = 0;
  await local.recv({ type: 'seat-taken' });
  assert.equal(h.context.links.get('local').socket, null);
  local.drop();
  assert.deepEqual(h.timers, [], 'the keepalive alarm re-probes instead');
  assert.equal(h.handled.length, 0);
});

test('local auth: the server proves itself first, then we prove back; nothing is sent or run before that', async () => {
  const h = linksHarness();
  await h.flush();
  const ws = h.sockets[0];
  const url = new URL(ws.url);
  assert.equal(url.searchParams.has('nokey'), false);
  h.context.journal('boot');
  ws.open(false);
  assert.equal(h.context.linkOpen('local'), false, 'open is not up: no proof yet');
  await ws.recv({ id: 9, type: 'eval', code: 'document.cookie' }); // anything but the proof first
  assert.deepEqual(h.handled, [], 'a frame before the proof runs nothing');
  assert.deepEqual(ws.sent, [], 'and gets nothing back — not even the journal');
  assert.equal(ws.auth, undefined);
  assert.equal(h.context.localAuthState().state, 'unverified');
  const ok = h.sockets.length;
  await h.flush();
  // The honest server: its proof, then ours with the same key.
  const h2 = linksHarness();
  await h2.flush();
  const s2 = h2.sockets[0];
  h2.context.journal('boot');
  s2.open(false);
  const challenge = serverAuth(s2.url);
  await s2.recv(challenge);
  assert.equal(s2.auth.m, mac(LOCAL_KEY, 'extension', challenge.s, new URL(s2.url).searchParams.get('c')), 'our proof binds the server nonce and ours');
  assert.equal(h2.context.linkOpen('local'), true);
  assert.deepEqual({ ...h2.context.localAuthState() }, { state: 'ok' });
  assert.deepEqual(s2.sent.map((e) => e.kind), ['boot'], 'the journal flushes only after the handshake');
  await s2.recv({ id: 1, type: 'snap', urlMatch: 'x' });
  assert.equal(h2.handled.length, 1);
  assert.ok(ok >= 1);
});

test('local auth: a server that can\'t prove the key gets nothing, runs nothing, and is retried on a slow backoff (impostor on the port)', async () => {
  let reads = 0;
  const h = linksHarness({ nativeHost: async () => (reads++, { k: LOCAL_KEY }) });
  await h.flush();
  const ws = h.sockets[0];
  ws.open(false);
  h.timers.length = 0;
  await ws.recv(serverAuth(ws.url, 'x'.repeat(43)));
  await ws.recv({ id: 2, type: 'fill', text: 'hunter2' });
  assert.equal(ws.auth, undefined, 'no proof of ours reaches it');
  assert.deepEqual(ws.sent, []);
  assert.deepEqual(h.handled, []);
  assert.equal(reads, 2, 'the key is read once more before calling the server an impostor');
  assert.equal(h.context.localAuthState().state, 'unverified');
  assert.equal(ws.readyState, 3);
  await h.flush();
  assert.deepEqual(h.timers.filter((t) => t.ms !== 2500).map((t) => t.ms), [1000], 'not the 500ms hot loop');
  assert.equal(h.context.linkOpen('local'), false);
});

test('local auth: a rotated key is re-read once and the next connect succeeds without waiting', async () => {
  let key = LOCAL_KEY;
  const h = linksHarness({ nativeHost: async () => ({ k: key }) });
  await h.flush();
  const first = h.sockets[0];
  first.open(false);
  key = 'n'.repeat(43); // the server rotated it (reinstall, or a key other users could read)
  h.timers.length = 0;
  await first.recv(serverAuth(first.url, key));
  await h.flush();
  assert.deepEqual(h.timers.filter((t) => t.ms !== 2500).map((t) => t.ms), [0], 'redial right away');
  h.fire(0);
  await h.flush();
  const second = h.sockets[1];
  second.open(false);
  await second.recv(serverAuth(second.url, key));
  assert.equal(h.context.linkOpen('local'), true);
  assert.deepEqual({ ...h.context.localAuthState() }, { state: 'ok' });
});

test('local auth: no key from Chrome → one &nokey dial says why, then 1s/2s/4s/5s retries; a key later connects', async () => {
  let reply = () => { throw new Error('Specified native messaging host not found.'); };
  const h = linksHarness({ nativeHost: async () => reply() });
  await h.flush();
  assert.equal(new URL(h.sockets[0].url).searchParams.get('nokey'), 'not-found');
  assert.deepEqual({ ...h.context.localAuthState() }, { state: 'no-key', why: 'not-found' });
  const delays = [];
  for (let i = 0; i < 4; i++) {
    h.timers.length = 0;
    h.sockets.at(-1).drop(); // the server refuses a &nokey dial
    delays.push(h.timers.find((t) => t.ms !== 2500).ms);
    h.fire(delays.at(-1));
    await h.flush();
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 5000]);
  for (const [text, why] of [['Access to the specified native messaging host is forbidden.', 'forbidden'], ['Failed to start native messaging host.', 'failed']]) {
    const x = linksHarness({ nativeHost: async () => { throw new Error(text); } });
    await x.flush();
    assert.equal(new URL(x.sockets[0].url).searchParams.get('nokey'), why);
  }
  const missing = linksHarness({ nativeHost: async () => ({ e: 'missing' }) });
  await missing.flush();
  assert.equal(new URL(missing.sockets[0].url).searchParams.get('nokey'), 'missing');
  reply = () => ({ k: LOCAL_KEY });
  h.timers.length = 0;
  h.sockets.at(-1).drop();
  h.fire(5000);
  await h.flush();
  const ws = h.sockets.at(-1);
  assert.equal(new URL(ws.url).searchParams.has('nokey'), false, 'the next dial reads the key again');
  await ws.open();
  assert.equal(h.context.linkOpen('local'), true);
  h.timers.length = 0;
  ws.drop();
  assert.ok(h.timers.some((t) => t.ms === 500), 'once authenticated, an ordinary drop is back to the flat 500ms');
});

test('local auth: a server that never proves itself is left after 5s; the keepalive leaves a handshake alone', async () => {
  const h = linksHarness();
  await h.flush();
  const ws = h.sockets[0];
  ws.open(false);
  h.alarm();
  await h.flush();
  assert.equal(h.sockets.length, 1, 'the alarm does not kill a socket still proving itself');
  h.fire(5000);
  assert.equal(ws.readyState, 3);
  assert.equal(h.context.localAuthState().state, 'unverified');
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
  // findTab's off-limits gate (cloud links on localhost/LAN tabs) lives with the other off-limits helpers.
  const offSource = source.slice(source.indexOf('function privateHost('), source.indexOf('// --- end off-limits'));
  vm.runInContext(offSource + '\n' + findTabSource, Object.assign(context, { URL }));
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

test('findTab records where the tab was when picked — the site a cloud command reports, even after a close (D2b)', async () => {
  const { context } = ownershipHarness();
  const msg = { type: 'close', urlMatch: 'a.test', _link: 'cloud' };
  await context.findTab(msg);
  assert.deepEqual(JSON.parse(JSON.stringify(msg._tabAt)), { url: 'https://a.test/x' });
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

test('findTab: a bare number that is a live tab\'s id says to write id:<n> (it read "the tab may have navigated")', async () => {
  const { context, marked } = ownershipHarness();
  await assert.rejects(context.findTab({ type: 'snap', urlMatch: '8', _link: 'local' }), (e) => e.message === 'no tab\'s URL or title contains "8", but a tab has that id — an id goes as id:8; nothing ran');
  await assert.rejects(context.findTab({ type: 'snap', urlMatch: '12345', _link: 'local' }), /^Error: no tab matching "12345" — the tab may have navigated/);
  assert.equal((await context.findTab({ type: 'snap', urlMatch: 'id:8', _link: 'local' })).id, 8);
  assert.deepEqual(marked, [8], 'only the id: form claimed a tab');
});

// --- Ask gate (D3b): askGate + findTab with the real question window ---------
function gateHarness({ driven = [], owners = [], reclaimed = [], extra = [] } = {}) {
  const fakes = askFakes();
  const marked = [];
  const tabs = [{ id: 7, url: 'https://a.test/x', title: 'A' }, { id: 8, url: 'https://b.test/', title: 'B' }, { id: 9, url: 'https://c.test/', title: 'C' }, ...extra];
  let n = 0;
  const context = vm.createContext({
    URL, drivenTabs: new Set(driven), tabOwner: new Map(owners), humanReclaimed: new Map(reclaimed.map((id) => [id, Date.now()])),
    links: new Map([['local', { label: 'local' }], ['cloud', { label: 'cloud' }]]),
    localOn: true, LOCAL_OFF_ERROR: 'Local AI agents was switched off',
    persist() {}, setFavicon: async () => {}, recordActivity() {},
    markTab: async (tabId) => { context.drivenTabs.add(tabId); marked.push(tabId); },
    chrome: { ...fakes.chrome, tabs: { query: async () => tabs, remove: async () => {} } },
    crypto: { randomUUID: () => 'q' + ++n }, setTimeout: () => 0, clearTimeout() {}, logLine() {}, errMsg: (e) => String(e?.message ?? e),
  });
  const offSource = source.slice(source.indexOf('function privateHost('), source.indexOf('// --- end off-limits'));
  const findTabSource = source.slice(source.indexOf('const CROSS_LINK_READS'), source.indexOf('async function cmdFetch('));
  vm.runInContext(offSource + '\n' + askSource + '\n' + findTabSource, context);
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  // The person answers the newest window; resolves with what it asked about.
  const answer = async (value) => {
    await flush();
    const w = fakes.windows.at(-1);
    const view = plain(await fakes.page(w, { type: 'ask-get' }));
    await fakes.page(w, { type: 'ask-answer', answer: value });
    return view;
  };
  return { ...fakes, context, tabs, marked, flush, answer };
}
const QUESTION = { app: 'Claude', command: 'click', title: 'Click', line: 'click a.test @e1', settingsUrl: '' };

test('ask gate (D3b): the question names the tab\'s website; yes runs the command on that very tab, no runs nothing and claims nothing', { timeout: 10_000 }, async () => {
  const h = gateHarness();
  const msg = { type: 'click', urlMatch: 'a.test', _link: 'cloud', _ask: QUESTION };
  const gate = h.context.askGate(msg);
  assert.equal((await h.answer('once')).site, 'a.test');
  await gate;
  assert.equal((await h.context.findTab(msg)).id, 7);
  assert.deepEqual(h.marked, [7]);
  const denied = { type: 'click', urlMatch: 'b.test', _link: 'cloud', _ask: QUESTION };
  const no = h.context.askGate(denied);
  await h.answer('deny');
  await assert.rejects(no, (e) => e.message === "The user said no when Chrome asked them to allow click on b.test, so nothing ran. Don't run it again; do the task another way, or ask the user in the chat.");
  assert.deepEqual(h.marked, [7], 'nothing claimed');
  // No question (Allow, or any local command): nothing is asked.
  await h.context.askGate({ type: 'click', urlMatch: 'c.test', _link: 'cloud' });
  assert.equal(h.windows.length, 2);
  // handle() asks right after its address checks, before anything else runs: every command passes it.
  const prelude = source.slice(source.indexOf('async function handle(msg) {'), source.indexOf("  if (msg.type === 'ping') {"));
  assert.match(prelude, /\n  refuseOffLimits\(msg\);\n(?:[ \t]*\/\/[^\n]*\n)*[ \t]*await askGate\(msg\);\n\s*$/);
});

test('ask gate (D3b): nobody is asked about a command that can\'t run — no tab, several, a tab the person took back, another link\'s, an off-limits one', { timeout: 10_000 }, async () => {
  const h = gateHarness({ driven: [8], owners: [[8, 'local']], reclaimed: [9], extra: [{ id: 10, url: 'http://localhost:3000/', title: 'L' }] });
  for (const [urlMatch, error] of [
    ['zzz', /^Error: no tab matching "zzz"/],
    ['.test', /^Error: ⚠ 3 tabs match "\.test"/],
    ['c.test', /the human released this tab via ⏏/],
    ['b.test', /driven through the local link/],
    ['id:10', /^Error: this tab is on localhost:3000/],
    ['--diff', /is a flag, not a tab match/],
  ])
    await assert.rejects(h.context.askGate({ type: 'click', urlMatch, _link: 'cloud', _ask: QUESTION }), error, urlMatch);
  assert.equal(h.windows.length, 0);
});

test('ask gate (D3b): after the yes, the tab having moved to another website, or another tab matching now, runs nothing', { timeout: 10_000 }, async () => {
  const h = gateHarness();
  const msg = { type: 'click', urlMatch: 'a.test', _link: 'cloud', _ask: QUESTION };
  const gate = h.context.askGate(msg);
  await h.flush();
  h.tabs[0].url = 'https://a.test.evil.example/x'; // still matches "a.test"
  await h.answer('once');
  await gate;
  await assert.rejects(h.context.findTab(msg), (e) => e.message === "while the user was answering Chrome's question, the tab went to a.test.evil.example, so nothing ran: they allowed it for a.test. Run the command again; the user is asked again.");
  const snap = { type: 'snap', urlMatch: 'b.test', _link: 'cloud', _ask: { ...QUESTION, command: 'snap' } };
  const again = h.context.askGate(snap);
  await h.flush();
  h.tabs.splice(1, 1, { id: 11, url: 'https://b.test/', title: 'B' }); // closed, and opened again
  await h.answer('once');
  await again;
  await assert.rejects(h.context.findTab(snap), /^Error: while the user was answering Chrome's question, "b\.test" now matches another tab, so nothing ran: they allowed it for b\.test\./);
  assert.deepEqual(h.marked, []);
});

test('ask gate (D3b): open, nav and fetch ask about where they go (nav and fetch stay on their tab); a step on no single website asks without one; close --all asks about the tabs it will close', { timeout: 10_000 }, async () => {
  const h = gateHarness();
  let gate = h.context.askGate({ type: 'open', url: 'https://News.example/x', _link: 'cloud', _ask: QUESTION });
  assert.equal((await h.answer('once')).site, 'news.example');
  await gate;
  const nav = { type: 'navigate', urlMatch: 'a.test', url: 'https://b.example/', _link: 'cloud', _ask: QUESTION };
  gate = h.context.askGate(nav);
  assert.equal((await h.answer('once')).site, 'b.example');
  await gate;
  assert.deepEqual(plain(nav._askAt), { tabId: 7, host: 'a.test' }, 'pinned to the tab it moves');
  const fetch = { type: 'fetch', urlMatch: 'c.test', url: 'https://api.c.test/v1', _link: 'cloud', _ask: QUESTION };
  gate = h.context.askGate(fetch);
  assert.equal((await h.answer('once')).site, 'api.c.test');
  await gate;
  assert.deepEqual(plain(fetch._askAt), { tabId: 9, host: 'c.test' });
  gate = h.context.askGate({ type: 'tabs', _link: 'cloud', _ask: QUESTION });
  assert.equal((await h.answer('once')).site, null);
  await gate;
  const all = { type: 'close', all: true, urlMatch: '.test', _link: 'cloud', _ask: QUESTION };
  gate = h.context.askGate(all);
  assert.equal((await h.answer('once')).site, null, 'three websites: none named');
  await gate;
  assert.deepEqual(plain(all._askTabs), [7, 8, 9]);
  const one = { type: 'close', all: true, urlMatch: 'a.test', _link: 'cloud', _ask: QUESTION };
  gate = h.context.askGate(one);
  assert.equal((await h.answer('once')).site, 'a.test');
  await gate;
  assert.equal(h.windows.length, 6);
});

// --- Cloud arm: the hub link speaks MCP over the same commands ---------------
const plain = (v) => JSON.parse(JSON.stringify(v)); // vm-realm objects fail deepStrictEqual's prototype check
// What the AI app gets: the hub keeps _meta (the Activity page's report) and never forwards it.
const forApp = (r) => {
  const { _meta, ...rest } = plain(r);
  return rest;
};
const PAIRED = { hub: 'http://localhost:8787', token: 'cba_dGVzdA.' + 'x'.repeat(43), enabled: true };
async function cloudArm(opts = {}) {
  const h = linksHarness({ cloud: PAIRED, ...opts });
  await h.flush();
  const ws = h.sockets.find((s) => s.url.includes('/arm'));
  ws.open();
  let n = 0;
  const call = async (name, args, meta) => {
    const id = ++n;
    await ws.recv({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } });
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
  assert.deepEqual({ ...ws.sent[0].params, offlineHint: undefined, registry: undefined }, { kind: 'chrome', name: 'oak', version: '9.9.9', selector: 'profile', instanceId: 'pid', offlineHint: undefined, registry: undefined });
  assert.match(ws.sent[0].params.offlineHint, /profile chrome-bridge calls "oak".*Cloud AI apps is on in the chrome-bridge popup's ⚙ Settings/);
  assert.equal(intervals[0].ms, 20000);
  intervals[0].fn();
  assert.equal(ws.sent.at(-1), 'ping');
});

test('cloud hello: the registry lists every browser command in people\'s words, with the typed tools that run it (D3: the hub\'s settings page)', async () => {
  const { ws } = await cloudArm();
  const registry = ws.sent[0].params.registry;
  const C = (() => {
    const c = vm.createContext({});
    vm.runInContext(commandsSource, c);
    return c.BridgeCommands;
  })();
  const browser = [...C.REGISTRY.filter((e) => e.scope === 'browser')];
  assert.deepEqual([...registry.map((e) => e.name)].sort(), browser.map((e) => e.name).sort(), 'browser commands only');
  // The page shows groups in the order they come: the registry's group order, not
  // where a group first appears ("Housekeeping" came second, found live on the hub).
  assert.deepEqual([...new Set(registry.map((e) => e.group))], [...C.GROUPS.filter((g) => browser.some((e) => e.group === g)).map((g) => C.GROUP_TITLES[g])]);
  for (const g of C.GROUPS) assert.deepEqual(registry.filter((e) => e.group === C.GROUP_TITLES[g]).map((e) => e.name), browser.filter((e) => e.group === g).map((e) => e.name), `${g}: registry order within a group`);
  assert.ok(!registry.some((e) => ['start', 'update', 'extreload', 'history'].includes(e.name)), 'local-only commands stay off the page');
  for (const e of registry) {
    assert.ok(e.title && e.title.length <= 60 && !/\b(eval|snap|CDP|DOM|a11y|@ref)\b/.test(e.title), `${e.name}: a plain title (${e.title})`);
    assert.ok(Object.values(C.GROUP_TITLES).includes(e.group), `${e.name}: a people's group (${e.group})`);
  }
  const tools = Object.fromEntries(registry.map((e) => [e.name, e.tools]));
  assert.deepEqual([tools.snap, tools.fill, tools.eval, tools.close], [['chrome_snap'], ['chrome_fill'], [], ['chrome_close']]);
  assert.deepEqual(registry.flatMap((e) => e.tools).sort(), [...C.TOOLS.filter((t) => t.command).map((t) => t.name)].sort(), 'every typed tool belongs to exactly one command');
});

test('cloud: tools/list offers chrome, chrome_batch and every typed tool, whatever is Off (the hub hides those: its list follows a settings change at once)', async () => {
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
  assert.deepEqual(ws.sent.find((m) => m.id === 'l2').result.tools.map((t) => t.name), tools.map((t) => t.name));
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
  assert.match(text(await call('chrome_fill', { tab: 'github', target: '@e5', value: 'x' })), /^fill is turned off for this Chrome profile in the user's Cloud Bridge settings/, 'a cached typed tool is still refused');
  assert.equal(handled.length, n);
});

test('cloud: shot needs no file name, and its typed tool returns the image', async () => {
  const { call, handled } = await cloudArm({ handle: () => 'data:image/jpeg;base64,/9j/' });
  for (const r of [await call('chrome', { command: 'shot github' }), await call('chrome', { command: 'shot github --max 800' }), await call('chrome_shot', { tab: 'github', max: 800, format: 'jpeg' })])
    assert.deepEqual(forApp(r), { content: [{ type: 'image', data: '/9j/', mimeType: 'image/jpeg' }], isError: false });
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
      'https://gone.test/x': { error: { code: -32000, message: 'https://gone.test/x answered 404 — check the link, or send the file as base64 instead' } },
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
    ['upload github @e1 https://gone.test/x', /^https:\/\/gone\.test\/x answered 404 — check the link, or send the file as base64 instead$/],
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

test('cloud: fetch --out and net --har hand the file to the hub and return its link (no disk here)', async () => {
  const results = {
    fetch: (m) => (m.url.endsWith('.png') ? { status: 200, ct: 'image/png', binary: true, body: 'iVBORw0KGgo=' } : { status: 200, ct: 'application/json; charset=utf-8', body: '{"a":1}' }),
    net: () => ({ lines: 'GET 200 https://github.com/api', har: { log: { version: '1.2', entries: [{ request: { headers: [{ name: 'Cookie', value: 's=1' }] } }] } } }),
  };
  const h = await cloudArm({ handle: (msg) => results[msg.type]?.(msg) ?? 'ok' });
  const { call, ws } = h;
  const kept = [];
  let hub = 'new';
  const send = ws.send.bind(ws);
  ws.send = (data) => {
    send(data);
    const m = typeof data === 'string' && data !== 'ping' ? JSON.parse(data) : null;
    if (m?.method !== 'arm/file') return;
    kept.push(plain(m.params));
    const size = m.params.text !== undefined ? m.params.text.length : Math.floor(m.params.data.length * 0.75);
    const answer = hub === 'full' ? { error: { code: -32000, message: 'Cloud Bridge keeps no more files today — run the command without --out/--har: the result comes back here' } } : { result: { url: `https://hub.test/files/${'a'.repeat(32)}/${encodeURIComponent(m.params.name)}`, name: m.params.name, mimeType: m.params.mimeType, size, expiresAt: '2026-11-10T00:00:00.000Z' } };
    setImmediate(() => ws.recv({ jsonrpc: '2.0', id: m.id, ...answer }));
  };
  const json = await call('chrome', { command: 'fetch github https://github.com/x.json --out /tmp/out/data.json' });
  assert.equal(json.isError, false);
  assert.deepEqual(kept[0], { name: 'data.json', mimeType: 'application/json', text: '{"a":1}' }, 'only the file name goes to the hub, never the local path');
  assert.equal(json.content[0].text, `saved data.json (1 KB, 200 application/json; charset=utf-8) → https://hub.test/files/${'a'.repeat(32)}/data.json\nThe link works for an hour, only for the user signed in to Cloud Bridge; resources/read on it returns the file to you.`);
  assert.deepEqual(plain(json.content[1]), { type: 'resource_link', uri: `https://hub.test/files/${'a'.repeat(32)}/data.json`, name: 'data.json', mimeType: 'application/json', size: 7, description: '200 application/json; charset=utf-8; expires 2026-11-10T00:00:00.000Z' });
  const png = await call('chrome', { command: 'fetch github https://github.com/x.png --out x.png' });
  assert.equal(png.isError, false);
  assert.deepEqual(kept[1], { name: 'x.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' }, 'binary bodies go as base64');
  const bin = await call('chrome', { command: 'fetch github https://github.com/x.png' });
  assert.equal(bin.isError, true);
  assert.equal(h.text(bin), 'binary response (image/png) — save it: fetch <match> <url> --out <name> (you get a download link)');
  const net = await call('chrome', { command: 'net github --har capture.har' });
  assert.equal(net.isError, false);
  assert.equal(net.content[0].text, 'GET 200 https://github.com/api', 'the request lines come back as without --har');
  assert.match(net.content[1].text, /^saved capture\.har \(1 KB, HAR 1\.2, 1 entries — contains cookies\/tokens: treat it as a secret\) → https:\/\/hub\.test\/files\//);
  assert.equal(kept[2].name, 'capture.har');
  assert.deepEqual(JSON.parse(kept[2].text).log.entries[0].request.headers, [{ name: 'Cookie', value: 's=1' }]);
  assert.equal(net.content[2].type, 'resource_link');
  hub = 'full';
  const full = await call('chrome', { command: 'net github --har capture.har' });
  assert.equal(full.isError, true);
  assert.equal(full.content[0].text, 'GET 200 https://github.com/api', 'the capture still comes back');
  assert.equal(full.content[1].text, "capture.har wasn't saved: Cloud Bridge keeps no more files today — run the command without --out/--har: the result comes back here");
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

test('cloud: --profile accepts the name the user gave this Chrome on the hub (arm/name), any case, and the refusal names both', async () => {
  const { call, handled, text, ws, flush } = await cloudArm();
  await ws.recv({ jsonrpc: '2.0', method: 'arm/name', params: { name: 'Work laptop' } });
  await flush();
  assert.equal(text(await call('chrome', { command: '--profile "work LAPTOP" tabs' })), 'ok');
  // Its word name may be another Chrome's hub name now (review): through the cloud, only the hub name counts.
  assert.equal(text(await call('chrome', { command: '--profile oak tabs' })), '--profile oak is not this Chrome ("Work laptop" on Cloud Bridge; "oak" is its chrome-bridge name, which Cloud Bridge doesn\'t use since the rename). Pick the Chrome with the tool\'s profile argument instead.');
  assert.equal(text(await call('chrome', { command: '--profile elm tabs' })), '--profile elm is not this Chrome ("Work laptop" on Cloud Bridge). Pick the Chrome with the tool\'s profile argument instead.');
  assert.equal(text(await call('chrome', { command: '--profile "Work laptop" eval x document.querySelector("b").id' })), 'ok', 'a quoted hub name keeps eval verbatim');
  assert.equal(handled.at(-1).code, 'document.querySelector("b").id');
  assert.deepEqual(handled.map((m) => m.type), ['tabs', 'eval']);
  // Not renamed: the hub name is the word name, and both spellings work.
  await ws.recv({ jsonrpc: '2.0', method: 'arm/name', params: { name: 'oak' } });
  await flush();
  assert.equal(text(await call('chrome', { command: '--profile OAK tabs' })), 'ok');
  assert.equal(text(await call('chrome', { command: '--profile oak tabs' })), 'ok');
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
  await ws.recv({ jsonrpc: '2.0', method: 'arm/policy', params: { commands: { click: 'off', eval: 'off' }, settingsUrl: 'https://hub.example/app/settings?profile=a1' } });
  await flush();
  const off = await call('chrome', { command: 'click github @e1' });
  assert.equal(off.isError, true);
  assert.equal(text(off), "click is turned off for this Chrome profile in the user's Cloud Bridge settings, so nothing ran. Do the task without it, or ask the user to allow it there (https://hub.example/app/settings?profile=a1).");
  assert.match(text(await call('chrome', { command: 'wait github --js "1"' })), /^eval is turned off for this Chrome profile/, 'wait --js runs page code: eval\'s rule covers it');
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

test('cloud: a chrome_batch stops where its hub connection dropped — the AI app was already told the call failed, so later lines must not act unseen', { timeout: 10_000 }, async () => {
  let ws;
  const h = await cloudArm({ handle: (msg) => { if (msg.type === 'tabs') ws.drop(); return 'ok'; } });
  ws = h.ws;
  await ws.recv({ jsonrpc: '2.0', id: 'b1', method: 'tools/call', params: { name: 'chrome_batch', arguments: { lines: ['tabs', 'click github @e1', 'fill github @e2 -- x'] } } });
  await h.flush();
  assert.deepEqual(h.handled.map((m) => m.type), ['tabs'], 'nothing after the drop ran');
  const reply = ws.sent.find((m) => m.id === 'b1');
  assert.equal(reply.result.isError, true);
  assert.match(h.text(reply.result), /\nstopped here: Cloud Bridge disconnected, so the 2 line\(s\) from here did not run$/);
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
  assert.deepEqual(forApp(r), { content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }], isError: false });
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
  assert.deepEqual(plain(r._meta), { 'cloud-bridge/activity': { command: 'fetch', site: 'api.example.com', line: 'fetch api.example.com https://api.example.com/v1', preview: text(r) } }, 'the site is what it fetched, the line the one the AI app sent, the preview what it answered');
});

// The hub's Activity page (D2b): each result says what ran, where, and its
// replay line — the history --batch form, so nothing typed reaches the hub's page.
const meta = (r) => plain(r._meta?.['cloud-bridge/activity'] ?? null);
// The preview has its own test below.
const reported = (r) => {
  const { preview, ...rest } = meta(r) ?? {};
  return meta(r) && rest;
};
test('cloud activity: each result reports the command word, the site it acted on and its redacted replay line (D2b)', async () => {
  const at = { 'github.com': 'https://GitHub.com/pulls?q=is%3Aopen', 'local.app': 'http://127.0.0.1:8787/app?code=gh-1:abc', 'shop.test': 'https://shop.test:8443/cart', blank: 'about:blank', blob: 'blob:https://example.com/0f1e', settings: 'chrome://settings/' };
  const handle = (msg) => {
    if (msg.urlMatch in at) msg._tabAt = { url: at[msg.urlMatch] }; // what findTab records when it picks the tab
    if (msg.urlMatch === 'leaving.test') msg._tabAt = { url: 'https://leaving.test/', pendingUrl: 'http://10.0.0.1/admin' };
    if (msg.type === 'open' && msg.url.includes('192.168.')) throw new Error('192.168.1.1 is on this computer or its local network — Cloud AI apps reach public web pages only'); // the real refuseOffLimits
    if (msg.type === 'open') return { id: 5, url: msg.url };
    if (msg.type === 'click' && msg.target === '@e9') throw new Error('no element @e9 — snap again');
    return 'ok';
  };
  const { call } = await cloudArm({ handle });
  assert.deepEqual(reported(await call('chrome', { command: 'snap github.com --find "the search box"' })), { command: 'snap', site: 'github.com', line: 'snap github.com --find "the search box"' });
  const fill = await call('chrome_fill', { tab: 'github.com', target: '@e5', value: 'hunter2 --secret' });
  assert.deepEqual(reported(fill), { command: 'fill', site: 'github.com', line: '# secret · fill github.com @e5 --diff -- "***"' });
  for (const command of ['type github.com @e5 -- hunter2', 'paste github.com @e5 -- hunter2', 'dialog github.com accept --text hunter2', 'fetch github.com https://api.github.com/x --header "Authorization: Bearer hunter2"'])
    assert.doesNotMatch(JSON.stringify(reported(await call('chrome', { command }))), /hunter2/, command);
  assert.deepEqual(reported(await call('chrome', { command: 'click shop.test @e9' })), { command: 'click', site: 'shop.test:8443', line: '# failed · click shop.test @e9' }, 'a failed step is a comment, so a replay proceeds past it');
  assert.deepEqual(reported(await call('chrome_open', { url: 'https://Example.COM/a b' })), { command: 'open', site: 'example.com', line: 'open "https://Example.COM/a b"' });
  // Never a site on this computer or its network (tabs hides those from the cloud too); the line is the AI app's own.
  assert.deepEqual(reported(await call('chrome', { command: 'snap local.app' })), { command: 'snap', line: 'snap local.app' });
  assert.deepEqual(reported(await call('chrome', { command: 'snap leaving.test' })), { command: 'snap', line: 'snap leaving.test' }, 'a tab on its way there counts too');
  for (const page of ['blank', 'blob', 'settings']) assert.deepEqual(reported(await call('chrome', { command: `snap ${page}` })), { command: 'snap', line: `snap ${page}` }, `no web site on a ${page} page`);
  assert.deepEqual(reported(await call('chrome', { command: 'open http://192.168.1.1/' })), { command: 'open', line: '# failed · open http://192.168.1.1/' });
  assert.deepEqual(reported(await call('chrome', { command: 'tabs' })), { command: 'tabs', line: 'tabs' }, 'no one tab, no site');
  // Refused before it ran: the word only (the raw line could hold a secret the parser never redacted).
  assert.deepEqual(reported(await call('chrome', { command: 'fill github.com @e5' })), { command: 'fill' });
  assert.deepEqual(reported(await call('chrome', { command: 'extreload' })), { command: 'extreload' });
  assert.equal(reported(await call('chrome', { command: 'frobnicate x' })), null, 'not a command: nothing to report');
});

test('cloud activity: a batch reports "batch", the lines that ran in order and the last site; long code is never shipped (D2b)', async () => {
  const handle = (msg) => {
    if (msg.urlMatch) msg._tabAt = { url: `https://${msg.urlMatch}/` };
    if (msg.type === 'open') return { id: 5, url: msg.url };
    if (msg.target === '@e9') throw new Error('no element @e9');
    return 'ok';
  };
  const { call, context } = await cloudArm({ handle });
  const r = await call('chrome_batch', { lines: ['open https://a.test/', 'fill a.test @e1 -- pw', '# a comment', 'snap b.test', 'click b.test @e9', 'snap a.test'] });
  assert.equal(r.isError, true);
  assert.deepEqual(reported(r), { command: 'batch', site: 'b.test', line: 'open https://a.test/\n# secret · fill a.test @e1 -- "***"\nsnap b.test\n# failed · click b.test @e9' }, 'the step after the failure never ran, so it is not reported');
  const long = 'x'.repeat(2100);
  assert.deepEqual(reported(await call('chrome', { command: `eval a.test ${long}` })), { command: 'eval', site: 'a.test', line: '# eval: 2112 characters, too long to keep' });
  assert.equal(context.cloudReplay('eval', { type: 'eval', urlMatch: 'a.test', code: 'a\nb' }, true), "# eval: its code spans several lines, which one line of a script can't hold");
  assert.equal(context.cloudReplay('eval', { type: 'eval', urlMatch: 'a.test', code: 'a\nb' }, false), "# failed · eval: its code spans several lines, which one line of a script can't hold");
  const many = await call('chrome_batch', { lines: Array.from({ length: 6 }, (_, i) => `eval a.test ${i}${'y'.repeat(1900)}`) });
  const line = reported(many).line;
  assert.ok(line.length <= 8000, `capped at 8,000 characters (${line.length})`);
  assert.match(line, /\n# … 2 more line\(s\), too long to keep$/);
});

test('cloud activity: wait --js refused under eval\'s Off rule reports a failed line, and a policy-refused command only its word (D2b)', async () => {
  const { call, ws, flush, handled } = await cloudArm();
  await ws.recv({ jsonrpc: '2.0', method: 'arm/policy', params: { commands: { eval: 'off', click: 'off' } } });
  await flush();
  assert.deepEqual(reported(await call('chrome', { command: 'wait a.test --js "window.ok"' })), { command: 'wait', line: '# failed · wait a.test --js window.ok' });
  assert.deepEqual(reported(await call('chrome', { command: 'click a.test @e1' })), { command: 'click' });
  assert.equal(handled.length, 0, 'nothing ran');
});

test('cloud activity: the preview is what the step answered, never a typed value — a batch echoes each step by its replay line (D2b2)', async () => {
  const handle = (msg) => {
    if (msg.urlMatch) msg._tabAt = { url: `https://${msg.urlMatch}/` };
    // A --diff verdict shows the field's new value: the preview must not carry it.
    if (msg.type === 'fill' || msg.type === 'type' || msg.type === 'paste') return `changed: textbox value="${msg.value}"`;
    if (msg.type === 'dialog') return `answered "${msg.text}"`;
    if (msg.target === '@e9') throw new Error('no element @e9 — snap again');
    if (msg.type === 'snap') return '- heading "Inbox" [level=1]';
    return 'ok';
  };
  const { call } = await cloudArm({ handle });
  assert.equal(meta(await call('chrome', { command: 'snap a.test' })).preview, '- heading "Inbox" [level=1]');
  assert.equal(meta(await call('chrome', { command: 'click a.test @e9' })).preview, 'no element @e9 — snap again', 'a failed step keeps why');
  for (const command of ['fill a.test @e5 -- hunter2', 'type a.test @e5 -- hunter2', 'paste a.test @e5 -- hunter2', 'dialog a.test accept --text hunter2']) {
    const r = await call('chrome', { command });
    assert.match(JSON.stringify(r.content), /hunter2/, 'the AI app still gets its answer');
    assert.equal(meta(r).preview, "(its answer isn't kept: it can show what was typed)", command);
  }
  const batch = await call('chrome_batch', { lines: ['snap a.test', 'fill a.test @e1 -- hunter2', 'click a.test @e9', 'snap a.test'] });
  assert.match(JSON.stringify(batch.content), /\$ fill a\.test @e1 -- hunter2/, "the AI app's own echo has the value");
  assert.equal(meta(batch).preview, '$ snap a.test\n- heading "Inbox" [level=1]\n# secret · fill a.test @e1 -- "***"\n(its answer isn\'t kept: it can show what was typed)\n# failed · click a.test @e9\nno element @e9 — snap again');
  const big = await cloudArm({ handle: () => 'z'.repeat(5000) });
  const long = meta(await big.call('chrome', { command: 'snap a.test' })).preview;
  assert.equal(long.length, 2000);
  assert.ok(long.endsWith('…'));
  assert.equal(meta(await call('chrome', { command: 'fill a.test @e5' })).preview, undefined, 'refused before it ran: nothing');
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
  // Read by people in the popup: what happened and the one next step, without "hub"/"pair".
  assert.equal(storage.cloud.notice, 'Cloud Bridge disconnected this Chrome profile (on its web page, or the account\'s data was deleted). To connect it again, turn on Cloud AI apps.');
  assert.doesNotMatch(storage.cloud.notice, /\bhub\b|\bpair/i);
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

test('cloud: pairing keeps polling through a busy hub (429 slow_down: 5s slower) or a failing one (5xx) — either used to end it', async () => {
  const polls = [];
  const replies = [
    { status: 429, body: { status: 'slow_down', error: 'slow_down', message: 'Too many polls from this network in the last minute: the code is still waiting; keep polling, 5 seconds slower.' } },
    { status: 502, body: {} },
    { status: 200, body: { status: 'pending' } },
    { status: 200, body: { status: 'approved', armToken: 'cba_new.' + 'y'.repeat(43), armUrl: 'ws://localhost:8787/arm' } },
  ];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/pair/start') return { status: 200, json: async () => ({ code: 'ABCD-EFGH', pollToken: 'pt', verificationUri: 'http://localhost:8787/pair?code=ABCD-EFGH', interval: 3, expiresIn: 600 }) };
    if (path !== '/pair/poll') return { status: 200, json: async () => ({ ok: true }) };
    const r = replies[polls.length];
    polls.push(JSON.parse(init.body));
    return { status: r.status, json: async () => r.body };
  };
  const h = linksHarness({ fetchImpl });
  await h.flush();
  assert.equal((await h.context.cloudPair('http://localhost:8787')).ok, true);
  const step = async (ms) => {
    h.fire(ms);
    for (let i = 0; i < 4; i++) await h.flush();
  };
  await step(3000);
  assert.equal(polls.length, 1);
  assert.equal(h.storage.cloud.pairing?.code, 'ABCD-EFGH', 'slow_down keeps the code');
  assert.equal(h.storage.cloud.pairing.interval, 8, 'and polls 5 seconds slower');
  await step(8000);
  assert.equal(polls.length, 2);
  assert.equal(h.storage.cloud.pairing?.code, 'ABCD-EFGH', 'a 5xx keeps the code too');
  assert.equal(h.storage.cloud.pairing.interval, 8);
  await step(8000);
  await step(8000);
  assert.equal(polls.length, 4);
  assert.equal(h.storage.cloud.pairing, null);
  assert.equal(h.storage.cloud.enabled, true);
  assert.equal(h.storage.cloud.notice, '');
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

// Ask (D3b): the question each command carries to askGate (handle is stubbed here).
const question = (msg) => {
  if (!msg._ask) return null;
  const { socket, deadline, ...rest } = msg._ask;
  return { ...plain(rest), socket: !!socket };
};
test('cloud Ask (D3b): a command set to Ask carries its question — the AI app, the command in people\'s words, the line it would run; wait --js asks under eval; Allow, Off and the local link never ask', { timeout: 10_000 }, async () => {
  const h = await cloudArm();
  const { call, handled, ws, flush, text } = h;
  const settingsUrl = 'https://hub.example/app/settings?profile=a1';
  await ws.recv({ jsonrpc: '2.0', method: 'arm/policy', params: { commands: { eval: 'ask', fill: 'ask', click: 'off' }, settingsUrl } });
  await flush();
  const started = Date.now();
  await call('chrome', { command: 'eval github "document.title"' }, { clientName: '  Claude  ', client: 'c1' });
  const { deadline } = handled[0]._ask;
  assert.ok(deadline >= started + 45000 && deadline <= Date.now() + 45000, 'one budget for the call\'s questions: 45s from when it came in');
  assert.deepEqual(question(handled[0]), { app: 'Claude', command: 'eval', title: 'Run its own code in a page, including while waiting', line: 'eval github document.title', settingsUrl, socket: true });
  assert.equal(handled[0]._ask.socket, ws, 'the hub connection it came on (askCancel)');
  await call('chrome_fill', { tab: 'github', target: '@e5', value: 'hunter2' });
  assert.deepEqual(question(handled[1]), { app: 'An AI app', command: 'fill', title: 'Fill in fields, replacing what is there', line: 'fill github @e5 --diff -- "***"', settingsUrl, socket: true }, 'a typed value never shows; the AI app gave no name');
  await call('chrome', { command: 'wait github --js "document.readyState === \'complete\'"' });
  assert.equal(handled[2]._ask.command, 'eval', 'wait --js runs page code: eval\'s rule asks');
  assert.match(handled[2]._ask.line, /^wait github --js /);
  await call('chrome', { command: 'wait github --text Saved' });
  assert.equal(question(handled[3]), null, 'wait without page code is wait\'s own rule (Allow)');
  assert.match(text(await call('chrome', { command: 'click github @e1' })), /^click is turned off/);
  assert.equal(handled.length, 4, 'Off is refused before anything runs, never asked');
  // wait set to Ask asks for its --js too, with eval allowed (review: it ran unasked).
  await ws.recv({ jsonrpc: '2.0', method: 'arm/policy', params: { commands: { wait: 'ask' }, settingsUrl } });
  await flush();
  await call('chrome', { command: 'wait github --js "window.ready"' });
  await call('chrome', { command: 'wait github --text Saved' });
  assert.deepEqual([handled[4]._ask?.command, handled[5]._ask?.command], ['wait', 'wait']);
  handled.length = 4;
  // The local link never asks, whatever the hub's rules.
  const local = h.sockets.find((s) => s.url.startsWith('ws://127.0.0.1'));
  await local.open();
  await flush();
  await local.recv({ id: 1, type: 'eval', urlMatch: 'github', code: '1' });
  assert.deepEqual(handled.at(-1), { id: 1, type: 'eval', urlMatch: 'github', code: '1', _link: 'local' });
});

test('cloud Ask (D3b): fetch\'s scratch tab and doctor --fix\'s releases ask once for the whole of it; a no opens, closes and releases nothing', { timeout: 10_000 }, async () => {
  const handle = (msg) => {
    if (msg.type === 'fetch' && msg.urlMatch !== 'id:5') throw new Error(`no tab matching "${msg.urlMatch}"`);
    if (msg.type === 'open') return { id: 5 };
    if (msg.type === 'fetch') return { status: 200, ct: 'application/json', body: '{"a":1}' };
    if (msg.type === 'doctor') return { rows: [{ id: 3, url: 'https://a/', grouped: true }, { id: 4, url: 'https://b/', driven: true }, { id: 6, url: 'https://c/', status: '⏳' }], stale: [] };
    return 'ok';
  };
  const h = await cloudArm({ handle });
  const settle = async () => {
    for (let i = 0; i < 6; i++) await h.flush();
  };
  const answer = async (value) => {
    await settle();
    const w = h.ask.windows.at(-1);
    const view = plain(await h.ask.page(w, { type: 'ask-get' }));
    await h.ask.page(w, { type: 'ask-answer', answer: value });
    return view;
  };
  await h.ws.recv({ jsonrpc: '2.0', method: 'arm/policy', params: { commands: { fetch: 'ask', open: 'ask', close: 'ask', release: 'ask' } } });
  await h.flush();
  let pending = h.call('chrome', { command: 'fetch api.example.com https://api.example.com/v1' }, { clientName: 'Claude' });
  const view = await answer('once');
  assert.deepEqual([view.app, view.command, view.site, view.line], ['Claude', 'fetch, open and close', 'api.example.com', 'fetch api.example.com https://api.example.com/v1\n# in a new tab on api.example.com, closed after']);
  assert.equal((await pending).isError, false);
  assert.deepEqual(h.handled.map((m) => [m.type, !!m._ask]), [['fetch', true], ['open', false], ['fetch', false], ['close', false]], 'the first try found no tab and asked nothing; then one question for all of it');
  assert.equal(h.ask.windows.length, 1);
  h.handled.length = 0;
  pending = h.call('chrome', { command: 'fetch zzz https://evil.example/x --keep' });
  assert.deepEqual((await answer('deny')).command, 'fetch and open', '--keep: no close to ask about');
  const refused = await pending;
  assert.equal(refused.isError, true);
  assert.equal(h.text(refused), 'no tab matching "zzz"\nThe user said no when Chrome asked them to allow fetch and open on evil.example, so nothing ran. Don\'t run it again; do the task another way, or ask the user in the chat.');
  assert.deepEqual(h.handled.map((m) => m.type), ['fetch'], 'no tab opened');
  pending = h.call('chrome', { command: 'doctor --fix' });
  const doctor = await answer('deny');
  assert.deepEqual([doctor.command, doctor.title, doctor.site, doctor.line], ['release', 'Hand a tab back to you', null, 'release id:3\nrelease id:6']);
  const rows = JSON.parse(h.text(await pending));
  const no = 'release failed: The user said no when Chrome asked them to allow release, so nothing ran. Don\'t run it again; do the task another way, or ask the user in the chat.';
  assert.deepEqual(rows.map((r) => [r.id, r.fixed]), [[3, no], [6, no]]);
  assert.ok(!h.handled.some((m) => m.type === 'release'), 'nothing released');
  assert.equal(h.ask.windows.length, 3, 'one question per call');
});

test('cloud Ask (D3b): a question asked after the call\'s hub connection closed is never shown — it carries that connection, not the link\'s next one (review)', { timeout: 10_000 }, async () => {
  let ws;
  const handle = (msg) => {
    if (msg.type !== 'doctor') return 'ok';
    ws.drop(); // the connection goes while doctor runs
    return { rows: [{ id: 3, url: 'https://a/', grouped: true }], stale: [] };
  };
  const h = await cloudArm({ handle });
  ws = h.ws;
  await ws.recv({ jsonrpc: '2.0', method: 'arm/policy', params: { commands: { release: 'ask' } } });
  await ws.recv({ jsonrpc: '2.0', id: 'd1', method: 'tools/call', params: { name: 'chrome', arguments: { command: 'doctor --fix' } } });
  await h.flush();
  assert.equal(h.ask.windows.length, 0, 'nobody to tell: no question');
  assert.deepEqual(h.handled.map((m) => m.type), ['doctor'], 'nothing released');
  const reply = ws.sent.find((m) => m.id === 'd1');
  assert.match(reply.result.content[0].text, /"fixed":"release failed: Cloud Bridge disconnected while Chrome asked the user to allow release, so nothing ran\."/);
});

test('cloud Ask (D3b): the hub connection dropping takes its waiting question with it — nothing runs once its AI app has been told the call failed', { timeout: 10_000 }, async () => {
  const h = await cloudArm({ handle: (msg) => { if (msg.type === 'fetch') throw new Error('no tab matching "x"'); return { id: 5 }; } });
  await h.ws.recv({ jsonrpc: '2.0', method: 'arm/policy', params: { commands: { open: 'ask' } } });
  const pending = h.ws.recv({ jsonrpc: '2.0', id: 'f1', method: 'tools/call', params: { name: 'chrome', arguments: { command: 'fetch x https://x.example/' } } });
  for (let i = 0; i < 6; i++) await h.flush();
  assert.equal(h.ask.windows.length, 1);
  h.ws.drop();
  await pending;
  await h.flush();
  assert.deepEqual(h.ask.removed, [h.ask.windows[0].id]);
  assert.deepEqual(h.handled.map((m) => m.type), ['fetch'], 'no tab opened');
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
