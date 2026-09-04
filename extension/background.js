const WS_URL = 'ws://127.0.0.1:9333/ws';
let ws = null;

// --- Service-worker log ring ------------------------------------------------
// The SW console is invisible to the CLI (it's not a tab); keep the tail so
// `swlogs` can read it. Cleared on SW restart, like everything else here.
const swLogs = [];
const logLine = (line) => {
  swLogs.push(new Date().toISOString().slice(11, 19) + ' ' + line);
  if (swLogs.length > 100) swLogs.shift();
};
self.addEventListener('error', (e) => logLine('ERROR ' + e.message + (e.filename ? ` @${e.filename}:${e.lineno}` : '')));
self.addEventListener('unhandledrejection', (e) => logLine('REJECT ' + String(e.reason)));
for (const lvl of ['error', 'warn']) {
  const orig = console[lvl].bind(console);
  console[lvl] = (...a) => {
    logLine(lvl.toUpperCase() + ' ' + a.map((x) => String(x?.stack || x)).join(' '));
    orig(...a);
  };
}

function connect() {
  // Two connects in flight (reconnect timer + keepalive alarm) means two
  // sockets; the server seats the first and rejects the second. Reply on the
  // socket that received the message (s), never the global ws — after a race
  // those differ, and replying on the rejected socket leaves every command
  // unanswered while health still says "connected".
  try {
    ws?.close();
  } catch {}
  let s;
  try {
    s = ws = new WebSocket(WS_URL);
  } catch {
    return;
  }
  s.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    try {
      const result = await handle(msg);
      s.send(JSON.stringify({ id: msg.id, ok: true, result }));
    } catch (err) {
      // Failures belong in the human-visible history too — a red-ink line in
      // the pill log, not just an error back to the agent.
      if (msg._tabId != null && drivenTabs.has(msg._tabId)) {
        const { done } = activityPhrases(msg);
        const lines = pushActivity(msg._tabId, '✗ ' + done + ' — ' + String(err).slice(0, 60));
        chrome.scripting
          .executeScript({ target: { tabId: msg._tabId }, func: pillInject, args: ['✗ ' + done, lines, null, false] })
          .catch(() => {});
      }
      s.send(JSON.stringify({ id: msg.id, ok: false, error: String(err) }));
    } finally {
      // ✅ when a command on a driven tab lands. Non-driven tabs are left
      // alone — otherwise any stray command would stick a ✅ on them with
      // no release to ever restore it. Release restores in releaseTab.
      if (msg._tabId != null && drivenTabs.has(msg._tabId)) {
        setFavicon(msg._tabId, '✅');
        // Pill back to neutral after a beat — the in-flight label needs
        // ~800ms to be glanceable, and the tooltip ring keeps the history.
        // The seq guard skips the reset if a newer command already started.
        const tabId = msg._tabId;
        const seq = pillSeq.get(tabId) || 0;
        setTimeout(() => {
          if ((pillSeq.get(tabId) || 0) !== seq) return;
          chrome.scripting
            .executeScript({ target: { tabId }, func: pillInject, args: ['AI idle', tabActivity.get(tabId) || [], null, false] })
            .catch(() => {});
        }, 800);
      }
    }
  };
  s.onclose = () => {
    if (ws !== s) return; // a newer socket already took over — don't double-reconnect
    ws = null;
    // Reconnect immediately; the alarm is only a backstop for a killed SW.
    setTimeout(connect, 500);
  };
}

connect();

// Keep the service worker (and its WebSocket) alive; reconnect if dropped.
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connect();
  }
});

// --- Driven-tab marking -----------------------------------------------------
// Tabs the bridge touches get a purple frame + corner tag in-page and a
// shared "🟣 Bridge" tab group, so the user can see at a glance what's being
// driven. `release` undoes all of it.
const drivenTabs = new Set();
let drivenGroupId = null;

// SW restarts wipe drivenTabs while the visuals (group, banner, favicon)
// persist in the pages — rehydrate from the 🟣 Bridge tab group, else after a
// reload the bridge treats still-bannered tabs as strangers (no favicon
// status, no pill updates, release won't clean them up).
(async () => {
  try {
    for (const g of await chrome.tabGroups.query({ title: '🟣 Bridge' })) {
      for (const t of await chrome.tabs.query({ groupId: g.id })) drivenTabs.add(t.id);
    }
  } catch {}
})();

// Runs in the page; must be self-contained.
// No document.title prefix: pages rewrite their title constantly (unread
// counts, SPA navs), so it never stays put — and it leaks into any page that
// reads its own title. The tab group is the strip marker; it can't clobber it.
function injectBanner() {
  if (document.getElementById('bridge-banner')) {
    return;
  }
  const d = document.createElement('div');
  d.id = 'bridge-banner';
  // The viewport frame starts transparent: it lights up purple only while a
  // command is in flight (pillInject toggles it) — a peripheral "the agent is
  // acting RIGHT NOW" signal — while the pill carries identity + history and
  // idle tabs stay clean. pointer-events: none, covers nothing.
  d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;border:3px solid transparent;border-radius:2px';
  const pill = document.createElement('div');
  pill.style.cssText =
    'position:fixed;bottom:8px;right:8px;background:#a855f7;color:#fff;font:12px sans-serif;padding:3px 10px;border-radius:11px;pointer-events:auto;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.4);user-select:none';
  const label = document.createElement('span');
  label.textContent = '🟣 AI idle';
  const x = document.createElement('span');
  x.textContent = ' ✕';
  x.title = 'hide until next navigation';
  x.style.opacity = '.75';
  x.onclick = (e) => {
    e.stopPropagation();
    d.remove();
  };
  pill.append(label, x);
  pill.title = 'An AI agent is driving this tab (chrome-bridge) — click for action history';
  // Click the pill body → a scrolling log of what the agent did on this tab
  // (pill.dataset.log, fed by pillInject). Click again to close. The ✕ span
  // keeps the old whole-pill click-to-hide behavior.
  pill.onclick = () => {
    if (document.getElementById('bridge-log')) {
      document.getElementById('bridge-log').remove();
      return;
    }
    const p = document.createElement('pre');
    p.id = 'bridge-log';
    p.style.cssText =
      'position:fixed;bottom:36px;right:8px;width:380px;max-height:50vh;overflow:auto;margin:0;background:rgba(24,12,40,.94);color:#e9d5ff;font:11px/1.6 monospace;padding:8px 10px;border-radius:8px;pointer-events:auto;white-space:pre-wrap;box-shadow:0 2px 12px rgba(0,0,0,.5)';
    p.textContent = pill.dataset.log || '(no activity yet)';
    d.appendChild(p);
  };
  d.appendChild(pill);
  (document.body || document.documentElement).appendChild(d);
}

function removeBanner() {
  document.getElementById('bridge-banner')?.remove();
}

// --- Live status in the corner pill ------------------------------------------
// The human watching the tab sees what the agent is doing, not just that it
// is: every command re-labels the pill ("🟣 clicking @e4") and appends to a
// 30-entry ring shown as the pill tooltip and the click-to-open log panel.
// recordActivity is fire-and-forget — never awaited, so it adds no latency to
// the command path. A pill the user hid via ✕ stays hidden: pillInject no-ops
// when the banner is absent.
const tabActivity = new Map(); // tabId -> last 30 "HH:MM:SS label" lines

// Runs in the page; must be self-contained. `@e21`-style refs mean nothing to
// a human, so resolve them to the element's own name right here — refs live in
// this world's window.__bridgeRefs, no extra round trip needed. `active` also
// lights the viewport frame for the duration of the command.
function pillInject(label, lines, target, active) {
  const banner = document.getElementById('bridge-banner');
  const pill = banner?.querySelector('div');
  if (!pill) return;
  banner.style.borderColor = active ? 'rgba(168,85,247,.75)' : 'transparent';
  if (target && target.startsWith('@')) {
    const el = window.__bridgeRefs?.[target.slice(1)];
    const name = String(el?.getAttribute('aria-label') || el?.innerText || el?.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (name) {
      label = label.replace(target, '"' + name + '"');
      lines = lines.map((l) => l.replace(target, '"' + name + '"'));
    }
  }
  pill.firstChild.textContent = '🟣 ' + label;
  const log = lines.join('\n');
  pill.dataset.log = log;
  pill.title = log + '\n(click for history · ✕ hides)';
  const p = document.getElementById('bridge-log');
  if (p) p.textContent = log || '(no activity yet)'; // panel open → live-update it
}

// Per-tab command counter: the idle-reset in onmessage is delayed ~800ms so a
// fast command's in-flight label stays glanceable, and the counter keeps that
// delayed reset from clobbering a NEWER command's label in rapid sequences.
const pillSeq = new Map();

function pushActivity(tabId, line) {
  const lines = tabActivity.get(tabId) || [];
  lines.push(new Date().toISOString().slice(11, 19) + ' ' + line);
  if (lines.length > 30) lines.shift();
  tabActivity.set(tabId, lines);
  return lines;
}

function recordActivity(tabId, msg) {
  const { ing, done } = activityPhrases(msg);
  const lines = pushActivity(tabId, done);
  pillSeq.set(tabId, (pillSeq.get(tabId) || 0) + 1);
  chrome.scripting
    .executeScript({ target: { tabId }, func: pillInject, args: [ing + '…', lines, msg.target || null, true] })
    .catch(() => {}); // banner absent (user hid it / chrome:// page) — fine
}

// One-line command summary for the pill, in human words: present-continuous
// while the command runs ("taking screenshot…"), past tense for the tooltip
// history ring. The user glances at the tab to see what the agent is doing
// RIGHT NOW — agent-speak like "click @e4" doesn't answer that.
const ACT_VERBS = {
  open: ['opening page', 'opened page'],
  navigate: ['opening page', 'opened page'],
  close: ['closing tab', 'closed tab'],
  mark: ['marking tab', 'marked tab'],
  release: ['releasing tab', 'released tab'],
  snap: ['reading page', 'read page'],
  shot: ['taking screenshot', 'took screenshot'],
  click: ['clicking', 'clicked'],
  fill: ['filling in', 'filled in'],
  type: ['typing into', 'typed into'],
  press: ['pressing', 'pressed'],
  hover: ['hovering over', 'hovered over'],
  scroll: ['scrolling', 'scrolled'],
  wait: ['waiting for', 'waited for'],
  ask: ['asking Nano', 'asked Nano'],
  eval: ['running a script', 'ran a script'],
  net: ['watching network', 'watched network'],
  console: ['reading page logs', 'read page logs'],
  measure: ['measuring layout', 'measured layout'],
  grid: ['toggling grid', 'toggled grid'],
  emulate: ['emulating device', 'emulated device'],
  resize: ['resizing window', 'resized window'],
};
function activityPhrases(msg) {
  let v = ACT_VERBS[msg.type] || [msg.type, msg.type];
  const detail = msg.target || msg.key || msg.selector || msg.text || msg.question || msg.url || '';
  if (msg.type === 'scroll' && detail && !['up', 'down', 'top', 'bottom'].includes(detail)) v = ['scrolling to', 'scrolled to'];
  const cut = (s) => (s.length > 36 ? s.slice(0, 33) + '…' : s);
  return { ing: cut(detail ? v[0] + ' ' + detail : v[0]), done: cut(detail ? v[1] + ' ' + detail : v[1]) };
}

async function groupTab(tabId) {
  try {
    if (drivenGroupId === null) {
      // Service-worker restarts wipe drivenGroupId — recover the existing
      // Bridge group in this window instead of spawning a duplicate.
      const { windowId } = await chrome.tabs.get(tabId);
      const groups = await chrome.tabGroups.query({ title: '🟣 Bridge', windowId });
      drivenGroupId = groups[0]?.id ?? null;
    }
    if (drivenGroupId !== null) {
      await chrome.tabs.group({ tabIds: tabId, groupId: drivenGroupId });
      return;
    }
  } catch {
    drivenGroupId = null; // group is gone or in another window — recreate
  }
  try {
    drivenGroupId = await chrome.tabs.group({ tabIds: tabId });
    await chrome.tabGroups.update(drivenGroupId, {
      title: '🟣 Bridge',
      color: 'purple',
    });
  } catch {
    // Grouping is best-effort (e.g. chrome:// pages can't be grouped).
  }
}

// --- Status favicon ----------------------------------------------------------
// ⏳ while a command is in flight on the tab, ✅ when it lands. The link swap
// is best-effort (loading/chrome:// pages reject injection); tabStatus
// re-applies the current emoji after every load since navigations reset it.
const tabStatus = new Map(); // tabId -> emoji

// Runs in the page; must be self-contained. `emoji === null` restores the
// site's own favicon. rel must be exactly `icon` (one of its tokens) so we
// don't grab apple-touch-icon, which never controls the tab strip.
function faviconInject(emoji) {
  const svg = (e) =>
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">' + e + '</text></svg>'
    );
  let link = [...document.querySelectorAll('link[rel]')].find((l) =>
    l.rel.split(/\s+/).includes('icon')
  );
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    link.dataset.bridgeMade = '1';
    (document.head || document.documentElement).appendChild(link);
  }
  if (emoji === null) {
    if (link.dataset.bridgeMade) link.remove();
    else if (link.dataset.bridgeOrig !== undefined) link.href = link.dataset.bridgeOrig;
    return;
  }
  if (link.dataset.bridgeOrig === undefined) {
    link.dataset.bridgeOrig = link.getAttribute('href') || '';
  }
  link.href = svg(emoji);
}

async function setFavicon(tabId, emoji) {
  if (emoji === null) tabStatus.delete(tabId);
  else tabStatus.set(tabId, emoji);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: faviconInject,
      args: [emoji],
    });
  } catch {} // best-effort — onUpdated re-applies once the page loads
}

async function markTab(tabId) {
  drivenTabs.add(tabId);
  await groupTab(tabId);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: injectBanner,
    });
  } catch {
    // Non-http pages (chrome://, WebGL-heavy SPAs mid-load) reject injection.
  }
}

async function releaseTab(tabId) {
  drivenTabs.delete(tabId);
  await setFavicon(tabId, null); // restore the site's own favicon
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: removeBanner,
    });
  } catch {}
  try {
    await chrome.tabs.ungroup(tabId);
  } catch {}
}

// Re-banner a driven tab after every load (navigations wipe the DOM marker),
// and re-apply the status favicon (loads reset it to the site's own).
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete' && drivenTabs.has(tabId)) {
    chrome.scripting
      .executeScript({ target: { tabId }, func: injectBanner })
      .catch(() => {});
    const emoji = tabStatus.get(tabId);
    if (emoji) {
      chrome.scripting
        .executeScript({ target: { tabId }, func: faviconInject, args: [emoji] })
        .catch(() => {});
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  drivenTabs.delete(tabId);
  tabStatus.delete(tabId);
  tabActivity.delete(tabId);
  worldCache.delete(tabId);
  emulatedTabs.delete(tabId); // debugger auto-detaches on close
});

// --- Device emulation (CDP) -------------------------------------------------
// DevTools-device-toolbar behavior without resizing the window. Attaches
// chrome.debugger (shows the "debugging this browser" infobar while active);
// `unemulate` clears and detaches. Survives navigations while attached.
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const emulatedTabs = new Set();

async function setEmulation(tabId, { width, height, mobile }) {
  await chrome.debugger.attach({ tabId }, '1.3');
  await chrome.debugger.sendCommand(
    { tabId },
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile }
  );
  await chrome.debugger.sendCommand(
    { tabId },
    'Emulation.setTouchEmulationEnabled',
    { enabled: !!mobile }
  );
  if (mobile) {
    await chrome.debugger.sendCommand(
      { tabId },
      'Network.setUserAgentOverride',
      { userAgent: MOBILE_UA }
    );
  }
  emulatedTabs.add(tabId);
}

async function clearEmulation(tabId) {
  try {
    await chrome.debugger.sendCommand(
      { tabId },
      'Emulation.clearDeviceMetricsOverride'
    );
  } catch {}
  try {
    await chrome.debugger.detach({ tabId });
  } catch {}
  emulatedTabs.delete(tabId);
}

// --- Network capture (CDP) ---------------------------------------------------
// Opt-in debug mode: attaches the debugger (infobar shows) for `duration` ms,
// returns one compact line per request. Bodies stay out — replay with eval.
const netCollectors = new Map(); // tabId -> Map(requestId -> entry)

chrome.debugger.onEvent.addListener((src, method, params) => {
  const c = netCollectors.get(src.tabId);
  if (!c) return;
  if (method === 'Network.requestWillBeSent') {
    c.set(params.requestId, { t: Date.now(), method: params.request.method, url: params.request.url });
  } else if (method === 'Network.responseReceived') {
    const r = c.get(params.requestId);
    if (r) r.status = params.response.status;
  } else if (method === 'Network.loadingFinished') {
    const r = c.get(params.requestId);
    if (r) { r.ms = Date.now() - r.t; r.size = params.encodedDataLength; }
  } else if (method === 'Network.loadingFailed') {
    const r = c.get(params.requestId);
    if (r) { r.ms = Date.now() - r.t; r.error = params.errorText; }
  }
});

async function captureNetwork(tabId, duration, filter) {
  let attachedByUs = true;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    if (!/already attached/i.test(String(e))) throw e;
    attachedByUs = false; // emulate/shot is holding it — don't detach.
  }
  const c = new Map();
  netCollectors.set(tabId, c);
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
      maxTotalBufferSize: 10_000_000,
      maxResourceBufferSize: 5_000_000,
    });
    await new Promise((r) => setTimeout(r, Math.min(duration || 4000, 30000)));
    await chrome.debugger.sendCommand({ tabId }, 'Network.disable').catch(() => {});
  } finally {
    netCollectors.delete(tabId);
    if (attachedByUs) await chrome.debugger.detach({ tabId }).catch(() => {});
  }
  const lines = [];
  for (const r of c.values()) {
    if (filter && !r.url.includes(filter)) continue;
    let u;
    try {
      const p = new URL(r.url);
      u = p.pathname + p.search;
    } catch {
      u = r.url;
    }
    if (u.length > 100) u = u.slice(0, 97) + '…';
    const status = r.error ? 'ERR:' + r.error : r.status || '…';
    const kb = r.size !== undefined ? ' ' + (r.size > 1024 ? Math.round(r.size / 1024) + 'kB' : r.size + 'B') : '';
    const ms = r.ms !== undefined ? ' ' + r.ms + 'ms' : '';
    lines.push(`${r.method} ${status} ${u}${kb}${ms}`);
    if (lines.length >= 100) { lines.push('… truncated at 100 requests — use --filter'); break; }
  }
  return lines.join('\n') || '(no requests captured — is the page idle? trigger the action, then run net again)';
}

// --- Page-side scripts ------------------------------------------------------
// These run through runEval (ISOLATED world, MAIN fallback, CDP last resort).
// Refs from snap live in `window.__bridgeRefs` of the world snap ran in;
// click/fill run through the same pipeline so they resolve in the same world.

const SNAP_SRC = (scope, diff, href) => `(() => {
  const MAX = 300;
  // Refs persist across snaps within one navigation: an element keeps its @eN
  // while its role+name are unchanged (playwright-mcp style), so a re-snap
  // after a DOM change doesn't renumber the page the agent already read.
  const refs = (window.__bridgeRefs = window.__bridgeRefs || {});
  // A star prefix marks refs not present in any earlier snap this navigation,
  // so a re-snap shows new content (browser-use does the same) without a
  // separate --diff round trip. Skipped on a page's first snap (everything
  // would be new) and inside --diff output (its '+ ~' lines already say it).
  // NOTE: no backticks in comments inside these templates — one closes the
  // template and the function silently becomes string * string = NaN.
  const seen = (window.__bridgeSeen = window.__bridgeSeen || new Set());
  const markFresh = seen.size > 0 && !${diff ? 'true' : 'false'};
  for (const k in refs) if (!refs[k].isConnected) delete refs[k];
  let n = (window.__bridgeRefN = window.__bridgeRefN || 0);
  let truncated = false;
  const lines = [];
  const ROLE_BY_TAG = { A:'link', BUTTON:'button', SELECT:'combobox', TEXTAREA:'textbox', SUMMARY:'button',
    H1:'heading', H2:'heading', H3:'heading', H4:'heading', H5:'heading', H6:'heading',
    IMG:'img', NAV:'navigation', MAIN:'main', HEADER:'banner', FOOTER:'contentinfo', ASIDE:'complementary',
    FORM:'form', DIALOG:'dialog', TABLE:'table', UL:'list', OL:'list', LI:'listitem', LABEL:'label' };
  const INPUT_ROLE = { checkbox:'checkbox', radio:'radio', range:'slider', button:'button', submit:'button', reset:'button', search:'searchbox' };
  const hidden = (el) => { const s = getComputedStyle(el); return s.display === 'none' || s.visibility === 'hidden'; };
  const hasBox = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return ['presentation', 'none'].includes(explicit) ? null : explicit;
    if (el.tagName === 'INPUT') return INPUT_ROLE[el.type] || 'textbox';
    return ROLE_BY_TAG[el.tagName] || null;
  }
  function nameOf(el, role) {
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return al.trim().slice(0, 60);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\\s+/).map((id) => document.getElementById(id)?.textContent).filter(Boolean).join(' ').trim();
      if (t) return t.slice(0, 60);
    }
    if (role === 'img') return el.alt || '';
    if (el.tagName === 'INPUT') return el.placeholder || el.name || '';
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) return text.slice(0, 60);
    return (el.getAttribute('title') || '').trim().slice(0, 60);
  }
  function stateOf(el, role, name) {
    const s = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
    if (el.checked || el.getAttribute('aria-checked') === 'true') s.push('checked');
    if (el.getAttribute('aria-expanded') === 'true') s.push('expanded');
    if (el.getAttribute('aria-expanded') === 'false') s.push('collapsed');
    if (el.getAttribute('aria-selected') === 'true' || el.selected) s.push('selected');
    if (['textbox', 'searchbox', 'combobox', 'slider'].includes(role)) {
      const v = el.value ?? el.getAttribute('aria-valuenow');
      if (v !== undefined && v !== null && v !== '') s.push('value=' + JSON.stringify(String(v).slice(0, 40)));
    }
    // hrefs are the biggest token sink in snap (~60% on link-heavy pages) and
    // almost never needed — the @eN ref is what you click. Keep them only for
    // nameless links (else they'd be unidentifiable) or when --href is passed.
    if (role === 'link' && el.href && (${href ? 'true' : 'false'} || !name)) {
      s.push(el.href.length > 60 ? el.href.slice(0, 57) + '…' : el.href);
    }
    return s.length ? ' ' + s.join(' ') : '';
  }
  function walk(el, depth) {
    if (lines.length >= MAX) { truncated = true; return; }
    if (hidden(el)) return;
    const role = roleOf(el);
    let childDepth = depth;
    if (role && hasBox(el)) {
      const name = nameOf(el, role);
      const key = role + ' ' + name;
      let ref = el.__bridgeRef;
      if (ref && (refs[ref] !== el || el.__bridgeRefKey !== key)) ref = null; // name/role changed → mint fresh
      if (!ref) {
        ref = 'e' + ++n;
        window.__bridgeRefN = n;
        el.__bridgeRef = ref;
        el.__bridgeRefKey = key;
      }
      refs[ref] = el;
      const fresh = markFresh && !seen.has(ref);
      seen.add(ref);
      lines.push('  '.repeat(Math.min(depth, 10)) + (fresh ? '* ' : '') + role + (name ? ' ' + JSON.stringify(name) : '') + ' @' + ref + stateOf(el, role, name));
      childDepth = depth + 1;
    }
    for (const c of el.children) walk(c, childDepth);
    if (el.shadowRoot) for (const c of el.shadowRoot.children) walk(c, childDepth);
    if (el.tagName === 'IFRAME') {
      try { if (el.contentDocument?.body) walk(el.contentDocument.body, childDepth); } catch {} // cross-origin
    }
  }
  const scopeSel = ${JSON.stringify(scope || null)};
  const root = scopeSel ? document.querySelector(scopeSel) : document.body;
  if (!root) throw new Error('scope not found: ' + scopeSel);
  walk(root, 0);
  if (truncated) lines.push('… truncated at ' + MAX + ' nodes' + (scopeSel ? '' : ' — scope with: snap <match> <css>'));
  // --diff: lines added/changed/removed since the last snap at THIS scope.
  const store = (window.__bridgeSnapLines = window.__bridgeSnapLines || {});
  // Key by scope AND href mode: lines embed hrefs only in --href snaps, so a
  // shared key would report every link as changed when the flag is toggled.
  const skey = (scopeSel || '') + (${href ? 'true' : 'false'} ? '|href' : '');
  const prev = store[skey] || null;
  const cur = {};
  // Star markers are display-only — strip them before storing, else a starred
  // line from a full snap diffs as "changed" against its unstarred diff twin.
  for (const l of lines) { const m = l.match(/@(e\\d+)/); if (m) cur[m[1]] = l.replace(/^(\\s*)\\* /, '$1'); }
  store[skey] = cur;
  if (${diff ? 'true' : 'false'} && prev) {
    const out = [];
    for (const ref in cur) if (prev[ref] !== cur[ref]) out.push((prev[ref] ? '~' : '+') + ' ' + cur[ref].trim());
    for (const ref in prev) if (!cur[ref]) out.push('- @' + ref);
    return out.length ? out.join('\\n') : '(no changes since last snap)';
  }
  return lines.join('\\n');
})()`;

// Page-side: fake pointer at (x, y) so the user sees where the agent is
// acting. `ripple` = the click ping. Style block is idempotent; the cursor
// element self-erases. String-concat inside — this gets interpolated into
// other template literals below.
const CURSOR_SRC = `
  const showCursor = (x, y, ripple) => {
    if (!document.getElementById('bridge-cursor-style')) {
      const st = document.createElement('style');
      st.id = 'bridge-cursor-style';
      st.textContent =
        '@keyframes bridge-ripple{from{transform:scale(.3);opacity:.9}to{transform:scale(2.4);opacity:0}}' +
        '@keyframes bridge-cursor-fade{to{opacity:0}}';
      document.documentElement.appendChild(st);
    }
    const c = document.createElement('div');
    c.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;left:' + x + 'px;top:' + y +
      'px;animation:bridge-cursor-fade .3s .9s forwards';
    c.innerHTML =
      (ripple
        ? '<div style="position:absolute;left:-14px;top:-14px;width:28px;height:28px;border:3px solid rgba(168,85,247,.9);border-radius:50%;animation:bridge-ripple .6s ease-out forwards"></div>'
        : '') +
      '<svg width="20" height="20" viewBox="0 0 20 20" style="filter:drop-shadow(0 1px 1px rgba(0,0,0,.4))"><path d="M3 1v16l3.9-3.7 2.3 5.5 2.8-1.2-2.4-5.4 5.6-.6z" fill="#a855f7" stroke="#fff" stroke-width="1.3"/></svg>';
    (document.body || document.documentElement).appendChild(c);
    setTimeout(() => c.remove(), 1300);
  };
`;

const clickSrc = (target) => `(() => {
  const sel = ${JSON.stringify(target)};
  const el = sel.startsWith('@') ? window.__bridgeRefs?.[sel.slice(1)] : document.querySelector(sel);
  if (!el) throw new Error('element not found: ' + sel + (sel.startsWith('@') ? ' — refs expire on navigation; run snap again' : ''));
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  // Coverage preflight: fail loudly when an overlay intercepts the click point
  // instead of dispatching a click that silently lands on the wrong element.
  const top = document.elementFromPoint(cx, cy);
  if (top && top !== el && !el.contains(top) && !top.contains(el) && !top.closest('#bridge-banner')) {
    const cls = typeof top.className === 'string' && top.className.trim() ? '.' + top.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    const txt = (top.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    throw new Error('click covered by <' + top.tagName.toLowerCase() + cls + '>' + (txt ? ' "' + txt + '"' : '') + ' — close the overlay or click that element first');
  }
  ${CURSOR_SRC}
  showCursor(cx, cy, true);
  const o = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerover', o));
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new MouseEvent('mousedown', o));
  el.focus?.();
  el.dispatchEvent(new PointerEvent('pointerup', o));
  el.dispatchEvent(new MouseEvent('mouseup', o));
  el.dispatchEvent(new MouseEvent('click', o));
  return 'clicked ' + sel;
})()`;

const fillSrc = (target, value) => `(() => {
  const sel = ${JSON.stringify(target)}, value = ${JSON.stringify(value)};
  const el = sel.startsWith('@') ? window.__bridgeRefs?.[sel.slice(1)] : document.querySelector(sel);
  if (!el) throw new Error('element not found: ' + sel + (sel.startsWith('@') ? ' — refs expire on navigation; run snap again' : ''));
  el.scrollIntoView({ block: 'center' });
  el.focus?.();
  if (el.isContentEditable) {
    el.innerText = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  } else if (el.tagName === 'SELECT') {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // Native setter + events, so React's value tracker sees a real change.
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return 'filled ' + sel;
})()`;

// Per-char typing: real keydown/input/keyup per character, so autocomplete and
// keystroke-driven UIs react (fill sets the value in one shot and they don't).
const typeSrc = (target, text) => `(async () => {
  const sel = ${JSON.stringify(target)}, text = ${JSON.stringify(text)};
  let el = sel.startsWith('@') ? window.__bridgeRefs?.[sel.slice(1)] : document.querySelector(sel);
  if (!el) throw new Error('element not found: ' + sel + (sel.startsWith('@') ? ' — refs expire on navigation; run snap again' : ''));
  el.scrollIntoView({ block: 'center' });
  el.focus?.();
  for (const ch of text) {
    if (!el.isConnected) {
      // Frameworks sometimes swap the input for a fresh element mid-typing
      // (Wikipedia Codex does this on first keystroke) — follow the focus.
      const a = document.activeElement;
      if ((a && /^(INPUT|TEXTAREA)$/.test(a.tagName)) || a?.isContentEditable) el = a;
      else throw new Error('element detached mid-typing and focus is not on a text field — re-snap and retry');
    }
    const o = { bubbles: true, cancelable: true, composed: true, key: ch, code: /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : 'Digit' + ch };
    el.dispatchEvent(new KeyboardEvent('keydown', o));
    if (el.isContentEditable) {
      document.execCommand('insertText', false, ch); // deprecated, still the only CE path that fires beforeinput correctly
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, el.value + ch);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
    }
    el.dispatchEvent(new KeyboardEvent('keyup', o));
    await new Promise((r) => setTimeout(r, 25));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
  const got = el.isContentEditable ? el.innerText : el.value;
  const warn = got !== undefined && !String(got).endsWith(text) ? ' — WARNING readback is ' + JSON.stringify(String(got).slice(0, 40)) + ' (framework rewrote the value; consider fill)' : '';
  return 'typed ' + text.length + ' chars into ' + sel + warn;
})()`;

// Key press on the focused element (or a target). Synthetic keys are untrusted:
// they reach JS listeners but don't trigger browser defaults (form submit).
const pressSrc = (key, target) => `(() => {
  const sel = ${JSON.stringify(target || '')}, key = ${JSON.stringify(key)};
  let el = document.activeElement || document.body;
  if (sel) {
    el = sel.startsWith('@') ? window.__bridgeRefs?.[sel.slice(1)] : document.querySelector(sel);
    if (!el) throw new Error('element not found: ' + sel);
    el.focus?.();
  }
  const code = key.length === 1 ? (/[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : 'Digit' + key) : key;
  const o = { bubbles: true, cancelable: true, composed: true, key, code };
  el.dispatchEvent(new KeyboardEvent('keydown', o));
  el.dispatchEvent(new KeyboardEvent('keypress', o));
  el.dispatchEvent(new KeyboardEvent('keyup', o));
  return 'pressed ' + key + ' on <' + el.tagName.toLowerCase() + '>';
})()`;

const hoverSrc = (target) => `(() => {
  const sel = ${JSON.stringify(target)};
  const el = sel.startsWith('@') ? window.__bridgeRefs?.[sel.slice(1)] : document.querySelector(sel);
  if (!el) throw new Error('element not found: ' + sel + (sel.startsWith('@') ? ' — refs expire on navigation; run snap again' : ''));
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  ${CURSOR_SRC}
  showCursor(r.left + r.width / 2, r.top + r.height / 2, false);
  const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new PointerEvent('pointerover', o));
  el.dispatchEvent(new MouseEvent('mouseover', o));
  el.dispatchEvent(new MouseEvent('mouseenter', { ...o, bubbles: false }));
  return 'hovered ' + sel;
})()`;

// Instant (not CSS-smooth) scrolling, so the position readback is true even on
// pages with scroll-behavior: smooth. up/down page by 85% of the scroller.
// App shells (Linear, Gmail) scroll an inner panel, not the window — when the
// document itself can't move, scroll the tallest visible overflow panel instead.
const scrollSrc = (what) => `(() => {
  const what = ${JSON.stringify(what)};
  const o = { behavior: 'instant' };
  if (!['top', 'bottom', 'up', 'down'].includes(what)) {
    const el = what.startsWith('@') ? window.__bridgeRefs?.[what.slice(1)] : document.querySelector(what);
    if (!el) throw new Error('element not found: ' + what + (what.startsWith('@') ? ' — refs expire on navigation; run snap again' : ''));
    el.scrollIntoView({ ...o, block: 'center' });
    return 'scrolled ' + what + ' into view';
  }
  let scroller = document.scrollingElement || document.documentElement;
  if (scroller.scrollHeight <= scroller.clientHeight + 8) {
    let best = null;
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 8 && el.clientHeight > 100) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && (!best || el.clientHeight > best.clientHeight)) best = el;
      }
    }
    if (best) scroller = best;
  }
  const isWin = scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body;
  const y0 = Math.round(scroller.scrollTop);
  const d = Math.round((isWin ? innerHeight : scroller.clientHeight) * 0.85);
  if (what === 'top') scroller.scrollTo({ ...o, top: 0 });
  else if (what === 'bottom') scroller.scrollTo({ ...o, top: scroller.scrollHeight });
  else scroller.scrollTo({ ...o, top: scroller.scrollTop + (what === 'up' ? -d : d) });
  const y1 = Math.round(scroller.scrollTop);
  const name = isWin ? 'window' : '<' + scroller.tagName.toLowerCase() + (scroller.id ? '#' + scroller.id : '') + '>';
  return 'scrolled ' + what + ' ' + name + ' (' + y0 + ' → ' + y1 + ')' + (y1 !== y0 ? '' : ' — nothing moved (at the end, or no scrollable content)');
})()`;

// Mutation-driven wait (puppeteer `polling: 'mutation'` style): the predicate
// re-runs on every mutation batch (microtask latency) instead of a fixed
// 150ms sleep; a slow interval backstops changes that mutate nothing.
// Page text minus the pill: the banner narrates commands ('waiting for X'),
// so a naive body.innerText read self-matches 'wait --text X' instantly and
// feeds Nano bridge UI instead of page content. String subtraction is
// bulletproof-enough here — worst case is a no-op replace (old behavior).
const PAGE_TEXT = `(()=>{const b=document.getElementById('bridge-banner');const t=document.body?.innerText||'';return b?t.replace(b.innerText,''):t})()`;

const waitSrc = ({ selector, text, timeout }) => `(async () => {
  const sel = ${JSON.stringify(selector || null)}, text = ${JSON.stringify(text || null)}, timeout = ${Number(timeout) || 10000};
  const t0 = Date.now();
  const check = () => {
    if (sel) {
      const el = document.querySelector(sel);
      if (el) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return 'found ' + sel; }
    }
    if (text && (${PAGE_TEXT}).includes(text)) return 'found text ' + JSON.stringify(text);
    return null;
  };
  const first = check();
  if (first) return first;
  await new Promise((resolve) => {
    const done = () => { try { mo.disconnect(); } catch {} clearInterval(iv); resolve(); };
    const tryDone = () => { if (check() || Date.now() - t0 >= timeout) done(); };
    const mo = new MutationObserver(tryDone);
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    const iv = setInterval(tryDone, 200);
  });
  const r = check();
  if (r) return r;
  throw new Error('timeout after ' + timeout + 'ms waiting for ' + (sel || JSON.stringify(text)));
})()`;

// Post-action settle (chrome-devtools-mcp style): resolves once the DOM has
// been quiet for 100ms, capped at 3s — a --diff observation then reads the
// finished state instead of a half-updated page.
const SETTLE_SRC = `(async () => {
  const t0 = Date.now();
  await new Promise((resolve) => {
    const done = () => { try { mo.disconnect(); } catch {} clearTimeout(t); clearInterval(iv); resolve(); };
    let t = null;
    const mo = new MutationObserver(() => {
      if (Date.now() - t0 >= 3000) return done();
      clearTimeout(t);
      t = setTimeout(done, 100);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    t = setTimeout(done, 100);
    const iv = setInterval(() => { if (Date.now() - t0 >= 3000) done(); }, 500);
  });
  return 'settled ' + Math.round(Date.now() - t0) + 'ms';
})()`;

// Experimental: answer a question about the page with Chrome's built-in
// Gemini Nano (Prompt API) — local, so page text never leaves the machine and
// costs no cloud tokens. Quality ceiling is a small on-device model: use as a
// pre-filter ("does this page mention X?"), never as ground truth.
// ponytail: 3000-char page cap stays under Nano's default input quota; if real
// use needs whole-page Q&A, chunk + map-reduce is the upgrade path.
const askSrc = (question) => `(async () => {
  if (typeof LanguageModel === 'undefined') throw new Error('no Prompt API in this Chrome (needs 138+) — developer.chrome.com/docs/ai/get-started');
  const avail = await LanguageModel.availability();
  if (avail !== 'available') throw new Error('Gemini Nano not ready (availability: ' + avail + ') — the first LanguageModel.create() downloads it (~2GB), then ask works');
  const text = (${PAGE_TEXT}).replace(/\\s+/g, ' ').trim().slice(0, 3000);
  const session = await LanguageModel.create();
  try {
    return await session.prompt('Answer from this page text. Page ' + location.href + ':\\n' + text + '\\n\\nQuestion: ' + ${JSON.stringify(question)});
  } finally {
    session.destroy();
  }
})()`;

// Console hook must run in the MAIN world — isolated worlds get their own console.
const consoleSrc = (clear) => `(() => {
  if (!window.__bridgeLog) {
    const buf = (window.__bridgeLog = []);
    const fmt = (a) => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } };
    const push = (kind, args) => { buf.push(kind + ' ' + Array.from(args).map(fmt).join(' ').slice(0, 300)); if (buf.length > 300) buf.shift(); };
    for (const k of ['error', 'warn', 'info', 'log']) {
      const orig = console[k];
      console[k] = function (...a) { push(k, a); return orig.apply(this, a); };
    }
    window.addEventListener('error', (e) => push('pageerror', [e.message]));
    window.addEventListener('unhandledrejection', (e) => push('unhandledrejection', [String(e.reason)]));
  }
  const out = window.__bridgeLog.join('\\n');
  if (${clear ? 'true' : 'false'}) window.__bridgeLog.length = 0;
  return out || '(empty — hook installed; captures console + page errors from now on, re-run after navigation)';
})()`;

// --- eval machinery -----------------------------------------------------------
// Errors are caught in-page and returned as data so the caller sees the real
// failure (e.g. CSP EvalError) instead of a null result.
const worldCache = new Map(); // tabId -> world whose eval worked (CSP pages pay the full ISOLATED→MAIN→CDP ladder per command otherwise)

async function runEval(tabId, code, world = 'auto') {
  const injected = (src) => {
    try {
      const value = eval(src);
      if (value && typeof value.then === 'function') {
        return value.then(
          (v) => ({ ok: true, value: v === undefined ? null : v }),
          (e) => ({ ok: false, error: `async: ${String(e)}` })
        );
      }
      return { ok: true, value: value === undefined ? null : value };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  };
  const run = (w) =>
    chrome.scripting.executeScript({
      target: { tabId },
      world: w,
      func: injected,
      args: [code],
    });

  // Cached world first; on CSP failure fall through to the full ladder.
  const worlds = world === 'auto' ? [...new Set([worldCache.get(tabId), 'ISOLATED', 'MAIN'])] : [world];
  for (const w of worlds) {
    if (!w) continue;
    const r = (await run(w))?.[0]?.result;
    if (r && r.ok === false && /EvalError|eval/.test(r.error)) continue; // CSP — try next
    if (!r) throw new Error('no injection result');
    if (r.ok === false) throw new Error(r.error);
    if (world === 'auto') worldCache.set(tabId, w);
    return r.value;
  }

  // Page CSP blocks eval() in both scripting worlds; CDP Runtime.evaluate is exempt.
  let attachedByUs = true;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    if (!/already attached/i.test(String(e))) throw e;
    attachedByUs = false; // e.g. emulate is holding it — don't detach.
  }
  try {
    const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: code,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails;
      throw new Error(`cdp: ${ex.text} ${ex.exception?.description || ''}`.trim());
    }
    return res.result.value === undefined ? null : res.result.value;
  } finally {
    if (attachedByUs) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
    }
  }
}

// --- --diff on actions: observe in the same round trip ----------------------
// The core agent loop collapses from click → wait → snap --diff (3 shell
// calls, ~1s harness round trip each) to `click <match> @e3 --diff` (1 call):
// settle, then diff-snap, appended to the action result. playwright-mcp and
// BrowserMCP return a post-action snapshot with every action for the same
// reason; a diff costs fewer tokens than the full snap it replaces.
async function observeDiff(tabId, actionResult) {
  try {
    await runEval(tabId, SETTLE_SRC);
    const snap = await runEval(tabId, SNAP_SRC(null, true, false));
    return actionResult + '\n' + snap;
  } catch (e) {
    // The action worked; only the observation failed (e.g. it navigated and
    // tore the context mid-settle). Don't turn a success into an error.
    return actionResult + '\n(observation unavailable: ' + String(e).slice(0, 120) + ' — re-snap; refs expired on navigation)';
  }
}

// Bounded wait for a tab to reach status 'complete' — nav/open then read as
// loaded instead of the agent paying a separate `wait` round trip (playwright
// caps goto the same way). 8s ceiling; `loaded: false` means still loading.
function waitForLoad(tabId, timeout = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpd); resolve(false); }, timeout);
    const onUpd = (tid, info) => {
      if (tid !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpd);
      resolve(true);
    };
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

// --- Commands ---------------------------------------------------------------

// Takes the whole msg: records _tabId so the onmessage finally can flip a
// driven tab's favicon to ✅, and marks a driven tab busy (⏳) for the command
// about to run. `open` sets msg._tabId itself — it creates rather than finds.
async function findTab(msg) {
  const tabs = await chrome.tabs.query({});
  const matches = tabs.filter((t) => t.url && t.url.includes(msg.urlMatch));
  if (!matches.length) {
    throw new Error(`no tab matching "${msg.urlMatch}"`);
  }
  matches.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  msg._tabId = matches[0].id;
  // Not `release`: it would flash ⏳ on the still-driven tab right before
  // releaseTab restores the site's own favicon.
  if (msg.type !== 'release' && drivenTabs.has(matches[0].id)) {
    await setFavicon(matches[0].id, '⏳');
    recordActivity(matches[0].id, msg);
  }
  return matches[0];
}

async function handle(msg) {
  if (msg.type === 'ping') {
    return 'pong';
  }

  if (msg.type === 'swlogs') {
    return swLogs;
  }

  if (msg.type === 'tabs') {
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => ({
      id: t.id,
      url: t.url, // whole — agents pick their <match> substring from this
      title: (t.title || '').slice(0, 80),
      ...(t.active ? { active: true } : {}),
      ...(drivenTabs.has(t.id) ? { driven: true } : {}),
    }));
  }

  if (msg.type === 'open') {
    const tab = await chrome.tabs.create({ url: msg.url, active: false });
    msg._tabId = tab.id;
    // Listener before the favicon/banner work: those are two executeScript
    // round trips, and a fast page can hit 'complete' inside that window
    // (observed with example.com) — the load event would be missed.
    const complete = waitForLoad(tab.id);
    await setFavicon(tab.id, '⏳');
    await markTab(tab.id);
    recordActivity(tab.id, msg);
    const loaded = await complete;
    const { url } = await chrome.tabs.get(tab.id); // create returns url:"" while pending
    return { id: tab.id, url, loaded };
  }

  if (msg.type === 'navigate') {
    const tab = await findTab(msg);
    // Listener before update: a fast page can hit 'complete' before
    // tabs.update resolves, and a missed event would mean a wasted 8s wait.
    const loaded = waitForLoad(tab.id);
    await chrome.tabs.update(tab.id, { url: msg.url });
    await markTab(tab.id);
    const complete = await loaded;
    if (msg.diff) return await observeDiff(tab.id, `navigated${complete ? '' : ' (still loading)'}`);
    return { id: tab.id, loaded: complete };
  }

  if (msg.type === 'close') {
    const tab = await findTab(msg);
    await chrome.tabs.remove(tab.id);
    return { id: tab.id };
  }

  if (msg.type === 'mark') {
    const tab = await findTab(msg);
    await markTab(tab.id);
    return { id: tab.id };
  }

  if (msg.type === 'release') {
    const tab = await findTab(msg);
    await releaseTab(tab.id);
    return { id: tab.id };
  }

  if (msg.type === 'eval') {
    const tab = await findTab(msg);
    return await runEval(tab.id, msg.code, msg.world || 'auto');
  }

  if (msg.type === 'snap') {
    const tab = await findTab(msg);
    return await runEval(tab.id, SNAP_SRC(msg.scope, msg.diff, msg.href));
  }

  if (['click', 'fill', 'type', 'press', 'hover'].includes(msg.type)) {
    const tab = await findTab(msg);
    const src =
      msg.type === 'click' ? clickSrc(msg.target) :
      msg.type === 'fill' ? fillSrc(msg.target, msg.value) :
      msg.type === 'type' ? typeSrc(msg.target, msg.value) :
      msg.type === 'press' ? pressSrc(msg.key, msg.target) :
      hoverSrc(msg.target);
    const result = await runEval(tab.id, src);
    return msg.diff ? await observeDiff(tab.id, result) : result;
  }

  if (msg.type === 'scroll') {
    const tab = await findTab(msg);
    const result = await runEval(tab.id, scrollSrc(msg.target));
    // --diff shines here: lazy-loaded content is DOM mutations, so the
    // settle + snap-diff returns exactly what the scroll revealed.
    return msg.diff ? await observeDiff(tab.id, result) : result;
  }

  if (msg.type === 'ask') {
    const tab = await findTab(msg);
    return await runEval(tab.id, askSrc(msg.question));
  }

  if (msg.type === 'net') {
    const tab = await findTab(msg);
    return await captureNetwork(tab.id, msg.duration, msg.filter);
  }

  if (msg.type === 'wait') {
    const tab = await findTab(msg);
    return await runEval(tab.id, waitSrc(msg));
  }

  if (msg.type === 'console') {
    const tab = await findTab(msg);
    return await runEval(tab.id, consoleSrc(msg.clear), 'MAIN');
  }

  if (msg.type === 'emulate') {
    const tab = await findTab(msg);
    await setEmulation(tab.id, msg);
    return {
      id: tab.id,
      width: msg.width,
      height: msg.height,
      mobile: !!msg.mobile,
    };
  }

  if (msg.type === 'unemulate') {
    const tab = await findTab(msg);
    await clearEmulation(tab.id);
    return { id: tab.id };
  }

  if (msg.type === 'resize') {
    const tab = await findTab(msg);
    await chrome.windows.update(tab.windowId, {
      width: msg.width,
      height: msg.height,
      state: 'normal',
    });
    return { id: tab.id, width: msg.width, height: msg.height };
  }

  if (msg.type === 'shot') {
    const tab = await findTab(msg);
    // No tab activation here: CDP captureScreenshot works on background tabs,
    // and activating would steal the user's view. Only the fallback below needs it.
    const format = msg.format === 'jpeg' ? 'jpeg' : 'png';
    let attachedByUs = true;
    try {
      try {
        await chrome.debugger.attach({ tabId: tab.id }, '1.3');
      } catch (e) {
        if (!/already attached/i.test(String(e))) throw e;
        attachedByUs = false; // emulate is holding the debugger — don't detach.
      }
      const params = { format };
      if (format === 'jpeg') params.quality = msg.quality ?? 80;
      // Downscale to a long edge of `max` px (0 = native). Claude resizes
      // anything past ~1568px on read anyway, so a native-res capture of a big
      // window buys file size, never detail — smaller capture, same answer.
      const maxN = Number(msg.max);
      const max = msg.max == null || Number.isNaN(maxN) ? 1280 : maxN === 0 ? Infinity : Math.abs(maxN);
      // Captures render at devicePixelRatio, so budget max/dpr CSS px to keep
      // the OUTPUT long edge <= max (visualViewport is in device px).
      let dpr = 1;
      const dprFrom = (m) => {
        const d = m.visualViewport?.clientWidth, c = m.cssVisualViewport?.clientWidth;
        if (d && c) dpr = d / c;
      };
      const cap = (w, h) => Math.min(msg.scale || 1, max / (Math.max(w, h) * dpr));
      if (msg.full) {
        // Full page: render beyond the viewport, clip to the CSS content size.
        const m = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.getLayoutMetrics');
        const c = m.cssContentSize;
        dprFrom(m);
        params.captureBeyondViewport = true;
        const w = Math.ceil(c.width), h = Math.min(Math.ceil(c.height), 16384);
        params.clip = { x: 0, y: 0, width: w, height: h, scale: cap(w, h) };
      } else if (msg.crop) {
        // --crop x,y are viewport-relative (measure output); clip is page-absolute.
        const m = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.getLayoutMetrics');
        const v = m.cssVisualViewport;
        dprFrom(m);
        params.captureBeyondViewport = true;
        params.clip = { x: msg.crop[0] + v.pageX, y: msg.crop[1] + v.pageY, width: msg.crop[2], height: msg.crop[3], scale: cap(msg.crop[2], msg.crop[3]) };
      } else {
        // Viewport: cssVisualViewport fields are pageX/pageY/clientWidth/
        // clientHeight (no x/y/width/height — that's what broke --scale).
        const m = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.getLayoutMetrics');
        const v = m.cssVisualViewport;
        dprFrom(m);
        const s = cap(v.clientWidth, v.clientHeight);
        if (s !== 1) {
          params.captureBeyondViewport = true;
          params.clip = { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale: s };
        }
      }
      const res = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.captureScreenshot', params);
      return `data:image/${format};base64,${res.data}`;
    } catch (e) {
      // debugger unavailable (chrome:// pages etc.) — fall back to captureVisibleTab
      // (viewport only, native res — crop/max/scale can't be honored there)
      console.warn('[bridge] cdp shot failed, falling back (crop/max/scale ignored):', e);
      // captureVisibleTab grabs the window's ACTIVE tab — must activate first,
      // otherwise we'd screenshot whatever the user is looking at.
      await chrome.tabs.update(tab.id, { active: true });
      await new Promise((r) => setTimeout(r, 400));
      return await chrome.tabs.captureVisibleTab(tab.windowId, { format, ...(format === 'jpeg' ? { quality: msg.quality ?? 80 } : {}) });
    } finally {
      if (attachedByUs) {
        await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
      }
    }
  }

  throw new Error(`unknown type "${msg.type}"`);
}
