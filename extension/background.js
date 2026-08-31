const WS_URL = 'ws://127.0.0.1:9333/ws';
let ws = null;

function connect() {
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    return;
  }
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    try {
      const result = await handle(msg);
      ws.send(JSON.stringify({ id: msg.id, ok: true, result }));
    } catch (err) {
      ws.send(JSON.stringify({ id: msg.id, ok: false, error: String(err) }));
    }
  };
  ws.onclose = () => {
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
// Tabs the bridge touches get a purple banner + title prefix in-page and a
// shared "🟣 Bridge" tab group, so the user can see at a glance what's being
// driven. `release` undoes all of it.
const drivenTabs = new Set();
let drivenGroupId = null;

// Runs in the page; must be self-contained.
function injectBanner() {
  const PREFIX = '🟣 BRIDGE — ';
  if (!document.title.startsWith(PREFIX)) {
    document.title = PREFIX + document.title;
  }
  if (document.getElementById('bridge-banner')) {
    return;
  }
  const d = document.createElement('div');
  d.id = 'bridge-banner';
  d.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#a855f7;color:#fff;font:bold 13px sans-serif;padding:4px 10px;text-align:center;pointer-events:none';
  d.textContent = '🟣 AI AGENT IS DRIVING THIS TAB (chrome-bridge)';
  (document.body || document.documentElement).appendChild(d);
}

function removeBanner() {
  const PREFIX = '🟣 BRIDGE — ';
  if (document.title.startsWith(PREFIX)) {
    document.title = document.title.slice(PREFIX.length);
  }
  document.getElementById('bridge-banner')?.remove();
}

async function groupTab(tabId) {
  try {
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

// Re-banner a driven tab after every load (navigations wipe the DOM marker).
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete' && drivenTabs.has(tabId)) {
    chrome.scripting
      .executeScript({ target: { tabId }, func: injectBanner })
      .catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  drivenTabs.delete(tabId);
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

// --- Page-side scripts ------------------------------------------------------
// These run through runEval (ISOLATED world, MAIN fallback, CDP last resort).
// Refs from snap live in `window.__bridgeRefs` of the world snap ran in;
// click/fill run through the same pipeline so they resolve in the same world.

const SNAP_SRC = `(() => {
  const MAX = 300;
  const refs = (window.__bridgeRefs = {});
  let n = 0, truncated = false;
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
    return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  }
  function stateOf(el, role) {
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
    if (role === 'link' && el.href) s.push(el.href.length > 60 ? el.href.slice(0, 57) + '…' : el.href);
    return s.length ? ' ' + s.join(' ') : '';
  }
  function walk(el, depth) {
    if (lines.length >= MAX) { truncated = true; return; }
    if (hidden(el)) return;
    const role = roleOf(el);
    let childDepth = depth;
    if (role && hasBox(el)) {
      const ref = 'e' + ++n;
      refs[ref] = el;
      const name = nameOf(el, role);
      lines.push('  '.repeat(Math.min(depth, 10)) + role + (name ? ' ' + JSON.stringify(name) : '') + ' @' + ref + stateOf(el, role));
      childDepth = depth + 1;
    }
    for (const c of el.children) walk(c, childDepth);
    if (el.shadowRoot) for (const c of el.shadowRoot.children) walk(c, childDepth);
  }
  walk(document.body, 0);
  return lines.join('\\n') + (truncated ? '\\n… truncated at ' + MAX + ' nodes' : '');
})()`;

const clickSrc = (target) => `(() => {
  const sel = ${JSON.stringify(target)};
  const el = sel.startsWith('@') ? window.__bridgeRefs?.[sel.slice(1)] : document.querySelector(sel);
  if (!el) throw new Error('element not found: ' + sel + (sel.startsWith('@') ? ' — refs expire on navigation; run snap again' : ''));
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
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

const waitSrc = ({ selector, text, timeout }) => `(async () => {
  const sel = ${JSON.stringify(selector || null)}, text = ${JSON.stringify(text || null)}, timeout = ${Number(timeout) || 10000};
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (sel) {
      const el = document.querySelector(sel);
      if (el) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return 'found ' + sel; }
    }
    if (text && (document.body?.innerText || '').includes(text)) return 'found text ' + JSON.stringify(text);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('timeout after ' + timeout + 'ms waiting for ' + (sel || JSON.stringify(text)));
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

  const worlds = world === 'auto' ? ['ISOLATED', 'MAIN'] : [world];
  for (const w of worlds) {
    const r = (await run(w))?.[0]?.result;
    if (r && r.ok === false && /EvalError|eval/.test(r.error)) continue; // CSP — try next
    if (!r) throw new Error('no injection result');
    if (r.ok === false) throw new Error(r.error);
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

// --- Commands ---------------------------------------------------------------

async function findTab(urlMatch) {
  const tabs = await chrome.tabs.query({});
  const matches = tabs.filter((t) => t.url && t.url.includes(urlMatch));
  if (!matches.length) {
    throw new Error(`no tab matching "${urlMatch}"`);
  }
  matches.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return matches[0];
}

async function handle(msg) {
  if (msg.type === 'ping') {
    return 'pong';
  }

  if (msg.type === 'tabs') {
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
      driven: drivenTabs.has(t.id),
    }));
  }

  if (msg.type === 'open') {
    const tab = await chrome.tabs.create({ url: msg.url, active: true });
    await markTab(tab.id);
    return { id: tab.id, url: tab.url };
  }

  if (msg.type === 'navigate') {
    const tab = await findTab(msg.urlMatch);
    await chrome.tabs.update(tab.id, { url: msg.url, active: true });
    await markTab(tab.id);
    return { id: tab.id };
  }

  if (msg.type === 'close') {
    const tab = await findTab(msg.urlMatch);
    await chrome.tabs.remove(tab.id);
    return { id: tab.id };
  }

  if (msg.type === 'mark') {
    const tab = await findTab(msg.urlMatch);
    await markTab(tab.id);
    return { id: tab.id };
  }

  if (msg.type === 'release') {
    const tab = await findTab(msg.urlMatch);
    await releaseTab(tab.id);
    return { id: tab.id };
  }

  if (msg.type === 'eval') {
    const tab = await findTab(msg.urlMatch);
    return await runEval(tab.id, msg.code, msg.world || 'auto');
  }

  if (msg.type === 'snap') {
    const tab = await findTab(msg.urlMatch);
    return await runEval(tab.id, SNAP_SRC);
  }

  if (msg.type === 'click') {
    const tab = await findTab(msg.urlMatch);
    return await runEval(tab.id, clickSrc(msg.target));
  }

  if (msg.type === 'fill') {
    const tab = await findTab(msg.urlMatch);
    return await runEval(tab.id, fillSrc(msg.target, msg.value));
  }

  if (msg.type === 'wait') {
    const tab = await findTab(msg.urlMatch);
    return await runEval(tab.id, waitSrc(msg));
  }

  if (msg.type === 'console') {
    const tab = await findTab(msg.urlMatch);
    return await runEval(tab.id, consoleSrc(msg.clear), 'MAIN');
  }

  if (msg.type === 'emulate') {
    const tab = await findTab(msg.urlMatch);
    await setEmulation(tab.id, msg);
    return {
      id: tab.id,
      width: msg.width,
      height: msg.height,
      mobile: !!msg.mobile,
    };
  }

  if (msg.type === 'unemulate') {
    const tab = await findTab(msg.urlMatch);
    await clearEmulation(tab.id);
    return { id: tab.id };
  }

  if (msg.type === 'resize') {
    const tab = await findTab(msg.urlMatch);
    await chrome.windows.update(tab.windowId, {
      width: msg.width,
      height: msg.height,
      state: 'normal',
    });
    return { id: tab.id, width: msg.width, height: msg.height };
  }

  if (msg.type === 'shot') {
    const tab = await findTab(msg.urlMatch);
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise((r) => setTimeout(r, 400));
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
      if (msg.crop) {
        params.clip = {
          x: msg.crop[0],
          y: msg.crop[1],
          width: msg.crop[2],
          height: msg.crop[3],
          scale: msg.scale || 1,
        };
      } else if (msg.scale && msg.scale !== 1) {
        const m = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.getLayoutMetrics');
        const v = m.cssVisualViewport;
        params.clip = { x: v.x, y: v.y, width: v.width, height: v.height, scale: msg.scale };
      }
      const res = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.captureScreenshot', params);
      return `data:image/${format};base64,${res.data}`;
    } catch (e) {
      // debugger unavailable (chrome:// pages etc.) — fall back to captureVisibleTab
      return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } finally {
      if (attachedByUs) {
        await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
      }
    }
  }

  throw new Error(`unknown type "${msg.type}"`);
}
