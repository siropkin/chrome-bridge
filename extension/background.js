// Port 9333 is hardcoded in THREE places: here, cli.mjs, server.mjs. The extension
// can't read BRIDGE_PORT — change all three together (README 'Install detail').
const WS_URL = 'ws://127.0.0.1:9333/ws';

// Section map (each '// ---' banner, in order):
//   Service-worker log ring · Driven-tab marking (pill/banner injection) ·
//   Live status in the corner pill (narration, ticker, activity ring) ·
//   Status favicon · CDP debugger refcount · Device emulation · Boot hydration
//   (storage.session restore) · Network capture · Page-side scripts (every
//   injected JS template: snap/click/fill/…/find/measure/console/wall) ·
//   pixel diff + capture (banner suppression lives here) · trusted input ·
//   eval machinery · --diff on actions · wait --human · Commands (handle()).
let ws = null;

// Stable per-profile id (uuid, persisted): the server logs and /health report
// WHICH Chrome holds the seat — with two profiles loaded, a silent seat
// migration would start driving the browser the human isn't watching.
let PROFILE_ID = '';
let PROFILE_NAME = '';
// Short stable human-readable profile name (e.g. 'birch'), derived once from
// the profile id: '@4371' in the watch feed means nothing to a human, and
// Chrome never exposes the profile's display name to an extension. Collision
// between two profiles is possible (20 words) but harmless — ids stay the
// identity for --profile and /health.
const NAME_WORDS = ['ash', 'birch', 'cedar', 'cypress', 'elm', 'fir', 'hazel', 'ironwood', 'juniper', 'larch', 'maple', 'oak', 'pine', 'poplar', 'rowan', 'spruce', 'sumac', 'walnut', 'willow', 'yew'];
const idReady = chrome.storage.local
  .get('profileId')
  .then(({ profileId }) => {
    PROFILE_ID = profileId || crypto.randomUUID();
    if (!profileId) chrome.storage.local.set({ profileId: PROFILE_ID }).catch(() => {});
    // Stable pick from the id — same id always gets the same word, across SW
    // restarts, without a second storage key.
    PROFILE_NAME = NAME_WORDS[[...PROFILE_ID].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % NAME_WORDS.length];
  })
  .catch(() => {});

// --- Service-worker log ring ------------------------------------------------
// The SW console is invisible to the CLI (it's not a tab); keep the tail so
// `swlogs` can read it. Cleared on SW restart, like everything else here.
const swLogs = [];
// Write-through to storage.session (merged back in `ready`): a bare in-memory
// ring dies with the worker — the one extension-side diagnostic, gone exactly
// when the SW crashed. logsHydrated is its own flag (not `hydrated`, declared
// far below): logLine runs at module load, before that declaration — touching
// it here would TDZ-crash the worker.
let logsHydrated = false;
const logLine = (line) => {
  swLogs.push(new Date().toISOString().slice(11, 19) + ' ' + line);
  if (swLogs.length > 100) swLogs.shift();
  if (logsHydrated) chrome.storage.session.set({ swLogs }).catch(() => {});
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
// First entry of every fresh worker's ring: `swlogs` answers "which file is
// actually running, since when" — the one question reload trouble-shooting
// can't answer otherwise (behavior can't distinguish loaded from stale).
logLine('background v' + chrome.runtime.getManifest().version + ' loaded ' + new Date().toISOString());

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
    // ?v= lets `cli health` catch a stale extension after git pull; ?id= names
    // which profile holds the seat in the server log and /health.
    s = ws = new WebSocket(
      WS_URL + '?v=' + chrome.runtime.getManifest().version + (PROFILE_ID ? '&id=' + PROFILE_ID : '') + (PROFILE_NAME ? '&name=' + PROFILE_NAME : '')
    );
  } catch {
    return;
  }
  s.onopen = () => {
    // Back online after a server outage: every driven tab's pill said
    // "offline" — put them back to the honest current state.
    if (wasOffline) {
      wasOffline = false;
      for (const tabId of drivenTabs) {
        chrome.scripting
          .executeScript({ target: { tabId }, func: pillInject, args: [idleLabel(tabId), tabActivity.get(tabId) || [], null, false] })
          .catch(() => {});
      }
    }
  };
  s.onmessage = async (e) => {
    // The local relay is normally the only peer, but a malformed WebSocket
    // frame must not throw out of this async event handler and strand the
    // socket in an apparently connected, command-deaf state. Close this
    // connection and let onclose establish a known-good seat instead.
    let msg;
    try {
      msg = JSON.parse(e.data);
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('message must be an object');
    } catch {
      logLine('bad relay message — reconnecting');
      s.close();
      return;
    }
    if (msg.type === 'seat-taken') {
      // This profile already holds a live socket (a service-worker reconnect
      // race — the server keeps ONE seat per profile). Intercept BEFORE
      // handle() (an unknown type there throws) and mark the socket: the
      // 500ms hot reconnect in onclose would churn the server at 2Hz — let
      // the 30s keepalive alarm re-probe instead.
      s._seatTaken = true;
      ws = null;
      return;
    }
    let failed = false;
    try {
      let result = await handle(msg);
      // A few legacy/diagnostic call paths can still attach a warning. Keep
      // it visible whatever the result shape is; tab-targeting commands now
      // reject ambiguity before they can dispatch an action (findTab).
      if (msg._warn) {
        if (typeof result === 'string') result += '\n' + msg._warn;
        else if (Array.isArray(result)) result = { result, warning: msg._warn }; // spread would reshape the array into {0:…}
        else if (result && typeof result === 'object') result = { ...result, warning: msg._warn };
        else if (result !== undefined && result !== null) result = [result, msg._warn]; // primitives (eval "1+1") — the warning must not vanish
      }
      s.send(JSON.stringify({ id: msg.id, ok: true, result }));
    } catch (err) {
      failed = true;
      const wrapped = wrapErr(err); // raw Chrome tab-gone noise → named cause + recovery
      // Failures belong in the human-visible history too — a red-ink line in
      // the pill log, not just an error back to the agent.
      if (msg._tabId != null && drivenTabs.has(msg._tabId)) {
        const { done } = activityPhrases(msg);
        // Same 'Error: Error:' dedup the CLI and the watch feed got (756df17)
        // — the pill history is the third place this line lands.
        const lines = pushActivity(msg._tabId, '✗ ' + done + ' — ' + humanizeErr(wrapped));
        chrome.scripting
          .executeScript({
            target: { tabId: msg._tabId },
            func: pillInject,
            args: ['✗ ' + done, lines, msg.target || null, false],
            // Same world as the success path: refs live in the world snap ran
            // in, so on CSP/MAIN-world pages this resolves the @ref to a name
            // instead of narrating agent-speak ('✗ clicked @e4').
            world: worldCache.get(msg._tabId) || 'MAIN',
          })
          .catch(() => {});
      }
      s.send(JSON.stringify({ id: msg.id, ok: false, error: wrapped }));
    } finally {
      // ✅ when a command on a driven tab lands, ✗ when it failed — the strip
      // icon must not claim success on an error. Non-driven tabs are left
      // alone — otherwise any stray command would stick an icon on them with
      // no release to ever restore it. Release restores in releaseTab.
      const tabId = msg._tabId;
      if (msg._pill) inflight.set(tabId, (inflight.get(tabId) || 1) - 1);
      if (tabId != null && drivenTabs.has(tabId)) {
        // Consecutive failures since the last ok: the durable "something
        // failed" glance — ✗ in the favicon is 16px in the strip, but the
        // pill itself must not read 'AI idle' like nothing happened. Only a
        // successful MUTATING command clears it — a read-only success (snap,
        // measure, eval…) is the agent inspecting the wreckage, not the
        // recovery; found live when an observer eval wiped the ⚠ a click
        // had earned.
        if (failed) failedSinceOk.set(tabId, (failedSinceOk.get(tabId) || 0) + 1);
        else if (MUTATING.has(msg.type) && msg.type !== 'eval') failedSinceOk.delete(tabId);
        setFavicon(tabId, failed ? '✗' : '✅');
        if (!(inflight.get(tabId) > 0)) stopTick(tabId); // a still-running sibling keeps the ticker going
        // Pill back to neutral after a beat — the in-flight label needs
        // ~800ms to be glanceable, and the tooltip ring keeps the history.
        // A note holds ~4s instead: its label IS the message, and the note
        // command itself runs in ~100ms — the standard beat would flash it
        // too briefly to ever be seen (found live in v1.5.0 testing).
        // The seq guard skips the reset if a newer command already started;
        // the inflight guard skips it if a sibling command is STILL running
        // (its own reset will fire when it finishes).
        const seq = pillSeq.get(tabId) || 0;
        setTimeout(() => {
          if (!drivenTabs.has(tabId)) return; // released in the window — never paint over the '✓ released' fade
          if ((pillSeq.get(tabId) || 0) !== seq) return;
          if ((inflight.get(tabId) || 0) > 0) return;
          const idleArgs = [idleLabel(tabId), tabActivity.get(tabId) || [], null, false];
          chrome.scripting
            .executeScript({ target: { tabId }, func: pillInject, args: idleArgs })
            // A gone pill (page wiped it; a first mark gated by a capture
            // window) gets rebuilt — this reset can be the last guaranteed
            // pill touch on the tab.
            .then((res) => revivePill(tabId, res, idleArgs))
            .catch(() => {});
        }, msg.type === 'note' ? 4000 : 800);
      }
    }
  };
  s.onclose = () => {
    if (ws !== s) return; // a newer socket already took over — don't double-reconnect
    ws = null;
    if (s._seatTaken) return; // lost the seat race — the 30s keepalive alarm re-probes
    // Say so in the pill: 'AI idle' during a bridge outage reads as "done,
    // waiting" — the human can't tell a dead server from a resting agent.
    // Injected once per outage (wasOffline), restored by s.onopen.
    if (!wasOffline) {
      wasOffline = true;
      for (const tabId of drivenTabs) {
        chrome.scripting
          .executeScript({ target: { tabId }, func: pillInject, args: ['⚠ bridge offline — reconnecting…', tabActivity.get(tabId) || [], null, false] })
          .catch(() => {});
      }
    }
    // Reconnect immediately; the alarm is only a backstop for a killed SW.
    setTimeout(connect, 500);
  };
}

// True while the WS is down — onopen clears it and restores the idle label.
let wasOffline = false;
// Wait for the profile id before the first dial — otherwise this connect
// races the storage read and the seat is held with extId=null until the next
// SW cycle (days, on a healthy server). Reconnects run after idReady settled.
idReady.then(connect);

// Keep the service worker (and its WebSocket) alive; reconnect if dropped.
// Chrome floors sub-30s alarm periods to 30s (and warns) — ask for 0.5 outright.
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
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

// Per-tab bridge state lives in chrome.storage.session: it survives the MV3
// service-worker cycle and dies with the browser — exactly the lifetime these
// visuals have. Without it an SW restart wiped the maps while the pages kept
// their banners/favicons/emulation: driven tabs became strangers (no pill
// updates, release wouldn't clean up) and unemulate no-op'd on a still-live
// override. The in-memory maps stay the fast path; persist() writes through.
// (tabStatus/tabActivity are declared below; persist() only runs after them.)
// False until the `ready` rehydration below completes. persist() during the
// hydration window would serialize the half-empty maps over the good copy in
// storage.session — and the wake-up event is often itself a tab close
// (onRemoved fires before hydration fills drivenTabs). If the SW then dies
// before the next command's persist, emulatedTabs is gone while the device
// override is still live and unemulate no-ops forever.
let hydrated = false;
// onReplaced pairs that fired before hydration completed — replayed inside
// `ready` after the storage restore (the old id's state exists again) and
// BEFORE the live prune (the old id is already gone from tabs.query; the
// prune would delete the very state the replay needs to move).

// Runs in the page; must be self-contained.
// No document.title prefix: pages rewrite their title constantly (unread
// counts, SPA navs), so it never stays put — and it leaks into any page that
// reads its own title. The tab group is the strip marker; it can't clobber it.
// Runs in the page; must be self-contained. respectHide (the SW-death
// catch-up passes it): honor a ✕ hide recorded on THIS document instead of
// resurrecting a pill the human dismissed — markTab's own re-mark (a new
// agent action) still re-banners, matching the old behavior.
function injectBanner(respectHide) {
  const existing = document.getElementById('bridge-banner');
  if (existing) {
    // A banner from a previous extension load carries handlers bound to a
    // dead service worker — ⏏/✕/history all dead after a reload. Rebuild.
    // dataset.fading: a '✓ released' pill mid-fade must not block a re-mark
    // either — rebuild, or the re-driven tab keeps a dead 'released' pill.
    if (existing.dataset.v === chrome.runtime.getManifest().version && !existing.dataset.fading) return;
    existing.remove();
  }
  if (respectHide && document.documentElement.dataset.bridgeHide === '1') return; // ✕'d this document, no navigation since
  // Building the pill ends the hide — clear the flag so a stale '1' can never
  // outlive a visible pill and silently block a later respectHide revive
  // (✕ → release → re-drive leaves the flag behind otherwise).
  delete document.documentElement.dataset.bridgeHide;
  const d = document.createElement('div');
  d.id = 'bridge-banner';
  d.dataset.v = chrome.runtime.getManifest().version; // load tag — handlers die with their worker, see the rebuild above
  // The viewport frame starts transparent: it lights up purple only while a
  // command is in flight (pillInject toggles it) — a peripheral "the agent is
  // acting RIGHT NOW" signal — while the pill carries identity + history and
  // idle tabs stay clean. pointer-events: none, covers nothing. The border
  // transition keeps the on/off from snapping at command boundaries.
  d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;border:3px solid transparent;border-radius:2px;transition:border-color .15s ease';
  const pill = document.createElement('div');
  // #9333ea over the old #a855f7: white 12px text passes WCAG AA (5.4:1, was
  // 3.96:1) — the pill's whole job is being read at a glance. system-ui matches
  // the OS face (SF/Segoe) next to native Chrome UI.
  pill.style.cssText =
    'position:fixed;bottom:8px;right:8px;background:#9333ea;color:#fff;font:12px system-ui,sans-serif;padding:3px 10px;border-radius:11px;pointer-events:auto;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.4);user-select:none;display:flex;align-items:center;gap:6px';
  // The pill is the product's trust surface — make it reachable and announced
  // for keyboard/screen-reader users (this tool's own pitch is an a11y tree).
  pill.setAttribute('role', 'button');
  pill.tabIndex = 0;
  pill.setAttribute('aria-label', 'An AI agent is driving this tab (chrome-bridge) — click for action history');
  const label = document.createElement('span');
  label.setAttribute('role', 'status'); // narration changes announced politely
  label.setAttribute('aria-live', 'polite');
  // Long labels (a 90-char note) ellipsize instead of wrapping into a ragged
  // two-line pill — and never clip the ✕/⏏ buttons (⏏ must stay clickable).
  // min-width:0 lets the flex item shrink below its content width so the
  // ellipsis can actually engage; flex+align-items:center on the pill keeps
  // the emoji glyphs (✕/⏏ sit on different font baselines than system-ui
  // text) vertically centered with the label instead of baseline-misaligned.
  label.style.cssText = 'white-space:nowrap;max-width:min(60vw,480px);overflow:hidden;text-overflow:ellipsis;min-width:0';
  label.textContent = '🟣 AI idle';
  const x = document.createElement('span');
  x.textContent = '✕';
  x.title = 'hide until next navigation';
  x.setAttribute('role', 'button');
  x.tabIndex = 0;
  x.setAttribute('aria-label', 'hide agent pill until next navigation');
  x.style.opacity = '.75';
  x.onclick = (e) => {
    e.stopPropagation();
    // Record the hide on the DOCUMENT: it survives SW restarts (the DOM
    // outlives the worker) and dies with the next navigation — exactly the
    // "hidden until next navigation" contract. The SW-death catch-up reads
    // it to know not to resurrect the pill on a still-same document.
    document.documentElement.dataset.bridgeHide = '1';
    d.remove();
  };
  x.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      document.documentElement.dataset.bridgeHide = '1';
      d.remove();
    }
  };
  pill.title = 'An AI agent is driving this tab (chrome-bridge) — click for history · ⏏ releases · ✕ hides';
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
      'position:fixed;bottom:36px;right:8px;width:380px;max-width:calc(100vw - 16px);max-height:50vh;overflow:auto;margin:0;background:rgba(24,12,40,.94);color:#e9d5ff;font:11px/1.6 monospace;padding:8px 10px;border-radius:8px;pointer-events:auto;white-space:pre-wrap;box-shadow:0 2px 12px rgba(0,0,0,.5)';
    p.textContent = pill.dataset.log || '(no activity yet)';
    d.appendChild(p);
  };
  pill.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pill.onclick(e);
    }
  };
  // ⏏: the human's "disconnect the agent from this tab" — no CLI needed.
  // Release, not hide: ✕ only hides until the next navigation; ⏏ ends the
  // bridge's claim (markers, group, device emulation). isTrusted is the
  // security boundary: a hostile page can dispatchEvent synthetic clicks,
  // and without this guard it could strip its own driven markers while the
  // agent keeps driving — the one signal README promises a page can't fake.
  // Same defense wait --human already uses for trusted input.
  const off = document.createElement('span');
  off.id = 'bridge-disconnect';
  off.textContent = '⏏';
  off.title = 'disconnect the agent from this tab (release it)';
  off.setAttribute('role', 'button');
  off.tabIndex = 0;
  off.setAttribute('aria-label', 'disconnect the agent from this tab');
  off.style.opacity = '.75';
  const selfRelease = (e) => {
    if (!e.isTrusted) return; // synthetic — page JS can't fake trusted input
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'self-release' }).catch(() => {});
  };
  off.onclick = selfRelease;
  off.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') selfRelease(e); // Enter/Space only — Tab must keep moving focus (any-key released on keydown, found by review)
  };
  // Order: label, ⏏ release, ✕ hide LAST — the toast/notification convention
  // (dismiss is always the terminal control; Material chips, macOS banners).
  pill.append(label, off, x);
  d.appendChild(pill);
  (document.body || document.documentElement).appendChild(d);
}

function removeBanner() {
  document.getElementById('bridge-banner')?.remove();
}

// Runs in the page; must be self-contained. The human clicked ⏏: confirm the
// release in place and let the pill fade out — a pill that just vanishes
// reads as a glitch, not an acknowledgement. dataset.fading tells injectBanner
// to rebuild (not early-return) if the agent re-marks inside the fade window.
function flashReleased() {
  const banner = document.getElementById('bridge-banner');
  const pill = banner?.querySelector('div');
  if (!pill) return;
  banner.dataset.fading = '1';
  banner.style.borderColor = 'transparent';
  pill.firstChild.textContent = '🟣 ✓ released — this tab is yours again';
  pill.title = 'released';
  pill.style.pointerEvents = 'none';
  document.getElementById('bridge-log')?.remove();
  setTimeout(() => banner.remove(), 2000);
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
  // Sentinels let the SW tell a page-deleted pill (rebuild it — a page or SPA
  // re-render can wipe #bridge-banner mid-session) from the user's ✕ hide
  // (respect it — bridgeHide is set only by the ✕ handler).
  if (!banner) return document.documentElement.dataset.bridgeHide === '1' ? 'hid' : 'gone';
  const pill = banner.querySelector('div');
  if (!pill) return;
  banner.style.borderColor = active ? 'rgba(147,51,234,.75)' : 'transparent';
  if (target && target.startsWith('@')) {
    const el = window.__bridgeRefs?.[target.slice(1)];
    const name = String(el?.getAttribute('aria-label') || el?.innerText || el?.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (name) {
      // (?!\d): '@e3' must not rewrite the '@e3' inside '@e30'.
      const re = new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!\\d)', 'g');
      label = label.replace(re, '"' + name + '"');
      lines = lines.map((l) => l.replace(re, '"' + name + '"'));
    }
  }
  pill.firstChild.textContent = '🟣 ' + label;
  const log = lines.join('\n');
  pill.dataset.log = log;
  // Fixed short hint naming all three affordances — a 30-line native tooltip
  // doesn't scroll and duplicates the click-to-open panel that holds the log.
  pill.title = 'AI is driving this tab — click for history · ⏏ releases · ✕ hides';
  const p = document.getElementById('bridge-log');
  if (p) {
    p.textContent = log || '(no activity yet)'; // panel open → live-update it
    p.scrollTop = p.scrollHeight; // newest last — an opened panel shows what just happened, not the oldest lines
  }
}

// Per-tab command counter: the idle-reset in onmessage is delayed ~800ms so a
// fast command's in-flight label stays glanceable, and the counter keeps that
// delayed reset from clobbering a NEWER command's label in rapid sequences.
const pillSeq = new Map();
// tabId -> commands currently running. The seq guard alone can't tell "a newer
// command started" from "a sibling started during this one and is still
// running" — both bump seq — so the idle-reset also checks this.
const inflight = new Map();
// tabId -> consecutive failures since the last ok (cleared by a success,
// release, or tab close). Drives the failure-aware idle label.
const failedSinceOk = new Map();
const idleLabel = (tabId) => {
  const n = failedSinceOk.get(tabId) || 0;
  return n ? `AI idle — ⚠ ${n} failed since last ok` : 'AI idle';
};
// The pill is read by the human, not the agent: raw Error text ('timeout
// after 120000ms — nudge them (note <match> …)') is agent-speak on the
// product's trust surface. Map the common failures to human words here, at
// the single pill-bound site — the agent-facing error field stays verbatim.
const humanizeErr = (err) => {
  const s = String(err).replace(/^(Error:\s*)+/, '');
  if (/timeout after \d+ms/.test(s)) return 'gave up waiting — time ran out';
  if (/tab was closed/i.test(s)) return 'the tab was closed';
  if (/debugger|detached|extension disconnected|not connected/i.test(s)) return 'lost the connection to the page';
  return s.replace(/[;—] (use|nudge|re-run|tell the user|run) [\s\S]*$/i, '').slice(0, 60);
};
// Chrome's raw tab-gone errors ('No tab with id: …') read as internal noise —
// name what happened and the recovery move, in the house style of findTab's
// 'run tabs to re-find it'. 'Cannot access contents of' is a different beast:
// the restricted-page rejection (chrome://, Web Store, PDF), not a gone tab.
const wrapErr = (err) => {
  const s = String(err);
  if (/No tab with id|The frame was removed/i.test(s)) return 'the tab was closed (or navigated) mid-command — run tabs to re-find it';
  if (/Cannot access contents of/i.test(s)) return 'that page is off-limits to extensions (chrome://, Web Store, PDF) — pick another tab';
  return s;
};
// tabId -> interval re-labeling the pill with elapsed seconds while a command
// runs. One 5s tick per tab (not per command): a 30s net capture stops
// reading as "stuck" — the human sees honest progress without the DOM being
// touched at animation frequency. Stopped the moment inflight hits 0.
const pillTick = new Map();
function startTick(tabId, msg, t0) {
  if (pillTick.has(tabId)) return; // a sibling command is already ticking
  const { ing } = activityPhrases(msg);
  pillTick.set(
    tabId,
    setInterval(() => {
      if (!inflight.get(tabId)) return stopTick(tabId);
      const args = [`${ing}… ${Math.round((Date.now() - t0) / 1000)}s`, tabActivity.get(tabId) || [], msg.target || null, true];
      chrome.scripting
        .executeScript({
          target: { tabId },
          func: pillInject,
          args,
          world: worldCache.get(tabId) || 'MAIN',
        })
        .then((res) => revivePill(tabId, res, args))
        .catch(() => {});
    }, 5000)
  );
}
function stopTick(tabId) {
  clearInterval(pillTick.get(tabId));
  pillTick.delete(tabId);
}

function pushActivity(tabId, line) {
  const lines = tabActivity.get(tabId) || [];
  lines.push(new Date().toISOString().slice(11, 19) + ' ' + line);
  if (lines.length > 30) lines.shift();
  tabActivity.set(tabId, lines);
  persist();
  return lines;
}

// The pill is page DOM — a page script or SPA re-render can delete
// #bridge-banner mid-session, and every narration then no-ops silently while
// the agent keeps driving. pillInject's 'gone' sentinel (vs 'hid' — the
// user's ✕ sets bridgeHide, and that stays respected) re-asserts the banner
// on the next narration, mirroring restoreBanner's two-call pattern.
// bannerSuppressed gates this: never rebuild the pill into a shot/wait
// capture window — the exact regression removeBannerForCapture exists to
// prevent.
function revivePill(tabId, res, args) {
  if (res?.[0]?.result !== 'gone') return;
  if (!drivenTabs.has(tabId) || bannerSuppressed.has(tabId)) return;
  chrome.scripting
    .executeScript({ target: { tabId }, func: injectBanner })
    .then(() =>
      chrome.scripting.executeScript({ target: { tabId }, func: pillInject, args, world: worldCache.get(tabId) || 'MAIN' })
    )
    .catch(() => {});
}

function recordActivity(tabId, msg) {
  const { ing, done } = activityPhrases(msg);
  const lines = pushActivity(tabId, done);
  pillSeq.set(tabId, (pillSeq.get(tabId) || 0) + 1);
  msg._pill = true; // onmessage's finally decrements inflight only for commands that recorded
  inflight.set(tabId, (inflight.get(tabId) || 0) + 1);
  startTick(tabId, msg, Date.now());
  const args = [ing + '…', lines, msg.target || null, true];
  chrome.scripting
    .executeScript({
      target: { tabId },
      func: pillInject,
      args,
      // Refs live in the world snap ran in (worldCache); on CSP pages that's
      // MAIN — inject there or the pill falls back to raw '@e4' agent-speak.
      world: worldCache.get(tabId) || 'MAIN',
    })
    .then((res) => revivePill(tabId, res, args))
    .catch(() => {}); // banner absent (user hid it / chrome:// page) — fine
}

// One-line command summary for the pill, in human words: present-continuous
// while the command runs ("taking screenshot…"), past tense for the tooltip
// history ring. The user glances at the tab to see what the agent is doing
// RIGHT NOW — agent-speak like "click @e4" doesn't answer that.
// Adding a command? SEVEN registries stay in sync (a missing one fails SILENTLY):
// cli.mjs USAGE · cli.mjs run() · server.mjs CLI_LINES · server.mjs route() (only if it
// needs special routing) · background.js handle() · ACT_VERBS (pill narration) · MUTATING.
const ACT_VERBS = {
  open: ['opening page', 'opened page'],
  navigate: ['opening page', 'opened page'],
  close: ['closing tab', 'closed tab'],
  mark: ['marking tab', 'marked tab'],
  release: ['releasing tab', 'released tab'],
  snap: ['reading page', 'read page'],
  shot: ['taking screenshot', 'took screenshot'],
  click: ['clicking', 'clicked'],
  drag: ['dragging', 'dragged'],
  dialog: ['answering a dialog', 'answered a dialog'],
  fill: ['filling in', 'filled in'],
  paste: ['pasting into', 'pasted into'],
  upload: ['uploading file to', 'uploaded file to'],
  type: ['typing into', 'typed into'],
  press: ['pressing', 'pressed'],
  hover: ['hovering over', 'hovered over'],
  scroll: ['scrolling', 'scrolled'],
  wait: ['waiting for', 'waited for'],
  ask: ['asking Nano', 'asked Nano'],
  eval: ['running a script', 'ran a script'],
  measure: ['measuring layout', 'measured layout'],
  grid: ['toggling alignment grid', 'toggled alignment grid'],
  net: ['watching network', 'watched network'],
  console: ['reading page logs', 'read page logs'],
  emulate: ['emulating device', 'emulated device'],
  unemulate: ['clearing device emulation', 'cleared device emulation'],
  resize: ['resizing window', 'resized window'],
  fetch: ['fetching', 'fetched'],
};
function activityPhrases(msg) {
  if (msg.type === 'note') {
    const t = msg.text.length > 90 ? msg.text.slice(0, 87) + '…' : msg.text;
    return { ing: '💬 ' + t, done: '💬 ' + t };
  }
  // --human: the pill label IS the handoff — the human must notice it's their
  // turn; the ticker appends elapsed seconds while they take it.
  if (msg.type === 'wait' && msg.human) return { ing: '🙋 your turn — act in this tab', done: '🙋 you acted — carrying on' };
  if (msg.type === 'emulate' && msg.focus) return { ing: 'emulating focus', done: 'emulated focus' };
  let v = ACT_VERBS[msg.type] || [msg.type, msg.type];
  const detail = msg.target || msg.key || msg.selector || msg.find || msg.text || msg.question || msg.url || '';
  if (msg.type === 'snap' && msg.find) v = ['searching page for', 'searched page for'];
  if (msg.type === 'scroll' && detail && !['up', 'down', 'top', 'bottom'].includes(detail)) v = ['scrolling to', 'scrolled to'];
  const cut = (s) => (s.length > 36 ? s.slice(0, 33) + '…' : s);
  return { ing: cut(detail ? v[0] + ' ' + detail : v[0]), done: cut(detail ? v[1] + ' ' + detail : v[1]) };
}

// Serialized per window: two concurrent first-ever marks would both query
// "no Bridge group yet" and each create one — tab groups never auto-dissolve,
// so the duplicate would live forever.
const groupChain = new Map(); // windowId -> in-flight grouping
async function groupTab(tabId) {
  let windowId;
  try {
    ({ windowId } = await chrome.tabs.get(tabId));
  } catch {
    return; // tab died mid-command — grouping is best-effort
  }
  const run = (groupChain.get(windowId) || Promise.resolve()).then(() =>
    // Gate at resume: a release that landed while this mark sat queued must
    // not be un-done by the queued grouping (markTab adds to drivenTabs
    // synchronously before calling, so every call site passes the gate).
    drivenTabs.has(tabId) ? groupTabNow(tabId) : null
  );
  const tail = run.catch(() => {});
  groupChain.set(windowId, tail);
  tail.then(() => groupChain.get(windowId) === tail && groupChain.delete(windowId)); // self-pruning; the identity guard keeps a newer in-flight chain's entry
  try {
    await run;
  } catch {} // e.g. chrome:// pages can't be grouped
}
async function groupTabNow(tabId) {
  // The Bridge group is ALWAYS re-derived from the tab's own window — a
  // cached global id teleports tabs in multi-window sessions:
  // chrome.tabs.group with a cross-window groupId does not throw, it MOVES
  // the tab into the cached group's window (verified against Chromium's
  // tabs_api.cc — found by the v1.18.12 flow review). Derived at EXECUTION
  // time, not enqueue time: a tab dragged to another window while queued
  // must group where it lives NOW, not where it lived when queued.
  let windowId;
  try {
    ({ windowId } = await chrome.tabs.get(tabId));
  } catch {
    return;
  }
  try {
    const groups = await chrome.tabGroups.query({ title: '🟣 Bridge', windowId });
    if (groups[0]) {
      await chrome.tabs.group({ tabIds: tabId, groupId: groups[0].id });
      return;
    }
  } catch {} // fall through to create
  const gid = await chrome.tabs.group({ tabIds: tabId });
  await chrome.tabGroups.update(gid, {
    title: '🟣 Bridge',
    color: 'purple',
  });
}

// --- Status favicon ----------------------------------------------------------
// ⏳ while a command is in flight on the tab, ✅ when it lands. The link swap
// is best-effort (loading/chrome:// pages reject injection); tabStatus
// re-applies the current emoji after every load since navigations reset it.
const tabStatus = new Map(); // tabId -> emoji

// Runs in the page; must be self-contained. `emoji === null` restores the
// site's own favicon. rel must CONTAIN `icon` as a token so we don't grab
// apple-touch-icon, which never controls the tab strip — but among several
// icon links (GitHub ships 'alternate icon' + 'icon') prefer the exact
// rel="icon": that's the one the tab strip actually shows, and stamping the
// fallback made the emoji invisible there.
function faviconInject(emoji) {
  const svg = (e) =>
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">' + e + '</text></svg>'
    );
  const links = [...document.querySelectorAll('link[rel]')].filter((l) => l.rel.split(/\s+/).includes('icon'));
  if (emoji === null) {
    // Restore ONLY a link we stamped (ours is found by its markers, however
    // the page reordered its head since) — never create a link to remove it.
    const stamped = links.find((l) => l.dataset.bridgeMade || l.dataset.bridgeOrig !== undefined);
    if (!stamped) return;
    if (stamped.dataset.bridgeMade) stamped.remove();
    else {
      stamped.href = stamped.dataset.bridgeOrig;
      delete stamped.dataset.bridgeOrig; // restore is final — the next stamp re-captures the site's CURRENT icon
    }
    return;
  }
  let link =
    links.find((l) => l.dataset.bridgeMade || l.dataset.bridgeOrig !== undefined) || // keep stamping the link we already own
    links.find((l) => l.rel === 'icon') ||
    links[0];
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    link.dataset.bridgeMade = '1';
    (document.head || document.documentElement).appendChild(link);
  }
  if (link.dataset.bridgeOrig === undefined) {
    link.dataset.bridgeOrig = link.getAttribute('href') || '';
  }
  link.href = svg(emoji);
}

async function setFavicon(tabId, emoji) {
  if (emoji === null) tabStatus.delete(tabId);
  else tabStatus.set(tabId, emoji);
  persist();
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: faviconInject,
      args: [emoji],
    });
  } catch {
    // Best-effort — onUpdated re-applies once the page loads. A failed RESTORE
    // has no such net (the tab is no longer driven) and a stuck emoji otherwise
    // lives until the next navigation: one bounded retry, guarded so a tab
    // re-marked inside the window keeps its new session's icon. A permanently
    // undrivable tab (discarded/crashed) still self-heals on its next load.
    if (emoji === null)
      setTimeout(() => {
        if (!drivenTabs.has(tabId))
          chrome.scripting.executeScript({ target: { tabId }, func: faviconInject, args: [null] }).catch(() => {});
      }, 1500);
  }
}

// In-flight marks, per tab. Handlers whose correctness needs the banner to
// have LANDED (note's visibility probe; shot / wait --pixel-change / trusted
// input's suppression windows) await this via awaitMark — a SIBLING command's
// fire-and-forget mark is otherwise invisible to them (drivenTabs already
// reads true by the time they look). Self-pruning; a re-mark's entry
// replaces the prior one's (its own prune then no-ops on the identity check).
const markInflight = new Map(); // tabId -> in-flight markTab promise
function markTab(tabId) {
  drivenTabs.add(tabId);
  persist();
  const p = (async () => {
    await groupTab(tabId);
    if (!drivenTabs.has(tabId)) return; // a release landed mid-mark — don't resurrect the pill
    // A capture/trusted-input window is open on this tab — injecting now
    // would put the pill inside it (a mid-window re-mark is exactly the
    // interleave awaitMark can't see: it started after the await). After the
    // window: a non-hidden tab heals via revivePill on the next narration;
    // a ✕-hidden tab stays hidden until the next navigation — inside a
    // capture window the human's ✕ outranks even an explicit re-mark.
    if (bannerSuppressed.has(tabId)) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: injectBanner,
      });
    } catch {
      // Non-http pages (chrome://, WebGL-heavy SPAs mid-load) reject injection.
    }
  })();
  markInflight.set(tabId, p);
  const done = () => markInflight.get(tabId) === p && markInflight.delete(tabId);
  p.then(done, done);
  return p;
}
// Bounded await of the tab's in-flight mark: injectBanner can pend forever on
// an uncommitted navigation (the reason every AUTO-mark site is
// fire-and-forget — the explicit `mark` command awaits and carries that hang
// risk by choice), so race a short fuse — a no-show banner degrades to each
// caller's existing backstop (at-capture re-removal; note's loud probe
// failure).
const awaitMark = (tabId, ms = 2000) => {
  const p = markInflight.get(tabId);
  return p ? Promise.race([p, new Promise((r) => setTimeout(r, ms))]).catch(() => {}) : Promise.resolve();
};

async function releaseTab(tabId, opts = {}) {
  drivenTabs.delete(tabId);
  tabActivity.delete(tabId); // else a re-mark resurrects the stale history ring
  shotBaselines.delete(tabId); // else a later session's first --diff compares against a previous session's pixels
  // pillSeq/inflight deliberately STAY: they're per-command bookkeeping, not
  // markers. A command in flight at release time decrements its OWN count in
  // onmessage's finally — deleting the counter here unpairs that math, so the
  // finishing pre-release command zeroes a post-release sibling's count and
  // the pill reads 'AI idle' mid-command (found by the race audit).
  failedSinceOk.delete(tabId);
  stopTick(tabId);
  // Release = the tab is the human's again, ALL of it. A marker-only release
  // left phone-sized tabs with a live debugger infobar and nothing on screen
  // to explain why (found by the flow review) — same clear as unemulate,
  // serialized behind any in-flight CDP sibling.
  if (emulatedTabs.has(tabId)) await withCdp(tabId, () => clearEmulation(tabId)).catch(() => {}); // best-effort like every other step — a wedged CDP clear must not abort the release tail
  if (drivenTabs.has(tabId)) return; // re-marked mid-release — the new mark owns the markers now (mirrors markTab's guard); stripping them here would leave a naked driven tab
  await setFavicon(tabId, null); // restore the site's own favicon
  persist();
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      // The human's own ⏏ click gets a '✓ released' fade instead of a silent
      // vanish — an acknowledgement, not a glitch.
      func: opts.flash ? flashReleased : removeBanner,
    });
  } catch {}
  // Ungroup through the SAME per-window chain groupTab uses, gated at
  // EXECUTION time like groupTabNow's: a re-mark's grouping then orders
  // cleanly against this ungroup whichever lands first — a pre-check alone
  // left the re-mark's fresh 🟣 Bridge group stripped with no re-group path
  // (found by the verify pass). The 🟣 Bridge title check stays: releasing a
  // tab the bridge never drove must not yank it out of a group the USER made.
  try {
    const { windowId } = await chrome.tabs.get(tabId);
    const run = (groupChain.get(windowId) || Promise.resolve()).then(async () => {
      if (drivenTabs.has(tabId)) return; // re-marked mid-release — the new mark owns the group
      const { groupId } = await chrome.tabs.get(tabId);
      if (groupId !== -1 && (await chrome.tabGroups.get(groupId)).title === '🟣 Bridge') await chrome.tabs.ungroup(tabId);
    });
    const tail = run.catch(() => {});
    groupChain.set(windowId, tail);
    tail.then(() => groupChain.get(windowId) === tail && groupChain.delete(windowId)); // same self-pruning as groupTab
    await run;
  } catch {}
}

// Re-banner a driven tab after every load (navigations wipe the DOM marker),
// and re-apply the status favicon (loads reset it to the site's own).
chrome.tabs.onUpdated.addListener((tabId, info) => {
  // A new document kills the pinned diff frame — its page-absolute clip and
  // baseline died with the old page; re-baseline instead of garbage-diffing.
  // status:'loading' with no url change is a same-URL reload — ALSO a new
  // document, and info.url never fires for it.
  if (info.url || info.status === 'loading') {
    shotBaselines.delete(tabId);
    navSeq.set(tabId, (navSeq.get(tabId) || 0) + 1);
  }
  if (info.status === 'complete' && drivenTabs.has(tabId) && !bannerSuppressed.has(tabId)) {
    // respectHide while a debugger is or was JUST attached: Chrome fires a
    // SPURIOUS status:'complete' ~0.5-1s after attach (live-observed, see
    // bannerSuppressed) on the SAME document — sometimes after a fast command
    // already detached, hence the dbgSince grace — and it must not resurrect
    // a pill the human ✕-hid. Real navigations get a fresh document
    // (bridgeHide gone — moot either way); a bfcache restore re-fires
    // complete on the preserved document with no debugger involved, so the
    // hide ends there as the ✕ contract ('hide until next navigation')
    // promises. KNOWN RESIDUAL: a bfcache restore keeps the hide past the
    // navigation when it lands inside a debugger session (emulated tabs hold
    // one for the whole session) or within the 1.5s post-attach grace —
    // telling it apart from the spurious event needs webNavigation's
    // from_back_forward qualifier; parked while the CWS listing is in review
    // (a permission change mid-review is a re-review trap).
    chrome.scripting
      .executeScript({ target: { tabId }, func: injectBanner, args: [cdpRefs.has(tabId) || Date.now() - (dbgSince.get(tabId) || 0) < 1500] })
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
  pillSeq.delete(tabId);
  inflight.delete(tabId);
  navSeq.delete(tabId);
  dbgSince.delete(tabId);
  markInflight.delete(tabId); // a mark whose injectBanner pends forever (uncommitted nav) never self-prunes
  failedSinceOk.delete(tabId);
  worldCache.delete(tabId);
  cdpRefs.delete(tabId); // debugger auto-detaches on close
  cdpQ.delete(tabId);
  emulatedTabs.delete(tabId);
  shotBaselines.delete(tabId); // full-png baselines must not outlive their tab
  persist();
});

// Prerender/Instant swaps the tab id under us (onReplaced, NOT onRemoved —
// onRemoved only fires on close): without a remap the new id drops out of
// drivenTabs and sheds every marker (banner died with the old document;
// onUpdated won't re-banner an id it has never seen) while the old id's
// state leaks and the session still believes the tab is driven.
//
// Durable per-tab DATA follows the id; volatile command lifecycle does NOT:
// commands in flight at swap time are keyed to the OLD id (msg._tabId) and
// their finallys settle there — remapping their bookkeeping (inflight,
// pillSeq, a mid-command ⏳ tabStatus) strands it on the new id forever, and
// the debugger session died with the old renderer, so emulatedTabs/cdpQ/
// cdpRefs must DROP, not follow (onDetach fires with the old id and would
// miss entries that had already moved).
chrome.tabs.onReplaced.addListener((newTabId, oldTabId) => {
  if (!hydrated) {
    pendingSwaps.push([newTabId, oldTabId]); // replayed inside ready, after the storage restore
    return;
  }
  remapTabId(newTabId, oldTabId);
});
function remapTabId(newTabId, oldTabId) {
  stopTick(oldTabId); // the ticker would inject into a dead id
  cdpRefs.delete(oldTabId);
  cdpQ.delete(oldTabId); // the dead session's pending chain can only wedge the new id (up to 65s)
  emulatedTabs.delete(oldTabId); // the override died with the old renderer — the new id is fresh for the next emulate
  for (const m of [tabActivity, failedSinceOk, worldCache, shotBaselines]) {
    if (m.has(oldTabId)) {
      m.set(newTabId, m.get(oldTabId));
      m.delete(oldTabId);
    }
  }
  if (drivenTabs.delete(oldTabId)) {
    drivenTabs.add(newTabId);
    persist();
    // Banner + group died with the old document — re-assert them on the new
    // id, or the pill stays gone until the next navigation.
    markTab(newTabId).catch(() => {});
  }
}

// The pill's ⏏: the human can end the bridge's claim on a tab without the
// CLI. sender.tab.id is set by the browser — page JS can't forge it, and the
// click handler's isTrusted guard keeps synthesized clicks out. releaseTab
// is idempotent on a non-driven tab, so no entry guard needed; it also clears
// device emulation (release = the tab is the human's again, ALL of it).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'self-release' && sender?.tab?.id != null) {
    logLine('self-release tab ' + sender.tab.id + ' (pill ⏏ — human)');
    // Wait for hydration like every command does: this click may be the very
    // event that woke a dead worker — releasing against the still-empty maps
    // would no-op, then hydration + the catch-up would resurrect everything
    // (found by review). On a live worker `ready` is already settled.
    ready
      .then(() => releaseTab(sender.tab.id, { flash: true }))
      .then(() => {
        // Tell the agent's feed (watch/history): the human took the tab back.
        // Without this the next command silently re-marks and nobody noticed.
        if (ws && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: 'event', kind: 'self-release', tabId: sender.tab.id, url: sender.tab.url || '' }));
      })
      .catch(() => {});
  }
});

// --- CDP debugger refcount ---------------------------------------------------
// Concurrent debugger commands on one tab (parallel agent calls: emulate + net
// on the same tab) used to race attach against detach — one attach failed
// "already attached", a detach mid-capture killed the other's in-flight
// sendCommand ("Detached while handling command", and Chrome occasionally
// dropped the callback entirely, hanging the command to the server's 70s cap
// with the debugger left attached). Owners now share the session; the last one
// out detaches. One pair of helpers replaces the per-call-site attachedByUs
// dance that only covered two of the five CDP users.
const cdpRefs = new Map(); // tabId -> active owners
const dbgSince = new Map(); // tabId -> last attach ts — the spurious post-attach status:'complete' (live-observed at 0.5-1s) can land AFTER a fast command already detached
async function attachDbg(tabId) {
  // Claim the share BEFORE the await: an attach-in-flight must still count,
  // or a sibling's detach (e.g. runEval's CDP fallback, which runs outside
  // withCdp) can drop the count to zero and pull the session out from under
  // this attach between its resolution and the increment.
  const n = (cdpRefs.get(tabId) || 0) + 1;
  cdpRefs.set(tabId, n);
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    // onUpdated's respectHide grace: the spurious attach-complete can outlive
    // a fast detach. Stamped on SUCCESS only — a failed attach provokes no
    // event, and a stale stamp would needlessly extend the bfcache residual.
    dbgSince.set(tabId, Date.now());
    logLine('dbg +' + tabId);
  } catch (e) {
    if (!/already attached/i.test(String(e))) {
      // Roll back against the CURRENT map value, not the pre-await capture —
      // a sibling may have incremented while our attach was in flight.
      const cur = cdpRefs.get(tabId) || 1;
      if (cur <= 1) cdpRefs.delete(tabId);
      else cdpRefs.set(tabId, cur - 1);
      throw e;
    }
    // 'already attached' with no sibling share and no emulation zombie can be
    // a FOREIGN debugger (the user's own DevTools) — sharing that breaks both
    // sides. Probe ownership with one read-only command: our zombie session
    // (pre-restart SW) answers it, a foreign one throws.
    if (n === 1 && !emulatedTabs.has(tabId)) {
      try {
        await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
      } catch {
        cdpRefs.delete(tabId); // n === 1 — roll back our share
        throw new Error('another debugger holds tab ' + tabId + ' (DevTools open?) — close it and retry');
      }
    }
    dbgSince.set(tabId, Date.now()); // shared live session — its own attach's spurious complete may still be in flight
    logLine('dbg +' + tabId + ' (shared)'); // ours from a sibling command — share it
  }
}
async function detachDbg(tabId) {
  const n = (cdpRefs.get(tabId) || 1) - 1;
  if (n > 0) {
    logLine('dbg -' + tabId + ' (share left: ' + n + ')');
    return cdpRefs.set(tabId, n);
  }
  cdpRefs.delete(tabId);
  logLine('dbg -' + tabId + ' (detaching)');
  try {
    await chrome.debugger.detach({ tabId });
  } catch (e) {
    logLine('dbg detach ' + tabId + ' FAILED: ' + String(e).slice(0, 80));
  } // tab already closed — debugger auto-detaches
}

// External detach (user cancels the "debugging" infobar, DevTools opens on the
// tab, extension reload) invalidates the refcount silently — without this, a
// stale count makes every later unemulate's detach a no-op and the session
// stays wedged until the tab closes.
// The mid-command error names all three causes: the third is the dangerous
// one — on a debugger-hostile page (console.cloud.google.com kills sessions
// on sight) 'retry the command' alone re-attaches, gets re-killed, and wedges
// the tab for ALL commands until a nav reload.
const DBG_GONE =
  'the "debugging this browser" infobar was dismissed, DevTools opened on this tab, or the page itself killed the session (debugger-hostile, e.g. console.cloud.google.com); ' +
  'retry the command — if every command on the tab then fails (even snap), the tab wedged: heal it with nav <match> <its url>';
chrome.debugger.onDetach.addListener((src) => {
  if (cdpRefs.delete(src.tabId) || emulatedTabs.has(src.tabId)) logLine('dbg DETACHED EXTERNALLY ' + src.tabId);
  emulatedTabs.delete(src.tabId);
  // Fired during the hydration window (often the very event that woke the
  // SW): the delete hit the still-empty map, and hydration then resurrects
  // the stale emulatedTabs entry from storage.session — re-apply once
  // hydrated so the cleanup lands on the real map and persists.
  if (!hydrated) ready.then(() => { emulatedTabs.delete(src.tabId); persist(); });
  persist();
  // A detach can drop an in-flight sendCommand's callback entirely — the
  // queued chain behind it would never advance, wedging every later CDP
  // command on this tab. Drop the chain; the stuck command itself still
  // fails via the withCdp timeout.
  cdpQ.delete(src.tabId);
  const c = netCollectors.get(src.tabId);
  if (c) {
    // A live capture self-completes via c.wake with a cut-short report —
    // don't also fast-reject its withCdp, or the partial capture (the useful
    // part) turns into a bare error.
    c.detached = true; // captureNetwork reports the cut-short capture
    c.kill?.(new Error('debugger detached during capture setup — ' + DBG_GONE)); // pre-sleep awaits race this
    c.wake?.(); // and stops sleeping out the rest of --dur
  } else {
    cdpInflight.get(src.tabId)?.(new Error('debugger detached mid-command — ' + DBG_GONE));
    cdpInflight.delete(src.tabId);
  }
});

// Serialize the CDP-holding commands per tab. The refcount makes concurrent
// owners SHARE a session; this makes the attach/clear/detach lifecycle ORDERED
// — an unemulate racing a sibling used to tear the shared session out from its
// in-flight sendCommand ("Detached while handling command"; 5.5% of
// deliberately interleaved CDP commands in stress). The session outlives the
// lock: net piggybacking an emulation still shares it, and unemulate's release
// is the one that detaches. runEval's CDP fallback stays outside — upload's
// cleanup runs eval right after (not inside) this lock, and runEval itself
// must never queue behind a command waiting on it.
const cdpQ = new Map(); // tabId -> in-flight CDP command chain
// tabId -> early-reject handle of the RUNNING command. onDetach fires it: a
// detach drops sendCommand callbacks, so the command fails NOW with the real
// cause instead of sleeping out the 65s backstop. The slot is claimed when fn
// STARTS — set at enqueue time it named the newest caller, and a detach with
// one command running and one queued rejected the QUEUED one (which never
// started) while the genuinely stuck one rotted (stress-review finding).
const cdpInflight = new Map();
function withCdp(tabId, fn) {
  let wake;
  let timer;
  let started = false;
  let cancelled = false;
  const run = (cdpQ.get(tabId) || Promise.resolve()).then(() => {
    // Timed out while QUEUED: the caller already has the error — running fn
    // now would land side effects (attach, emulation cleared, capture started)
    // after the failure was reported.
    if (cancelled) return undefined;
    started = true;
    cdpInflight.set(tabId, wake);
    return fn();
  });
  // Timeout under the server's 70s cap: a dropped sendCommand callback (Chrome
  // does this on detach) must fail THIS command and let the queue advance —
  // otherwise every later CDP command on the tab chains onto a promise that
  // never settles and rots to 'extension timeout' until the SW restarts.
  // One end-to-end budget (the server cap is end-to-end too), but the message
  // names the phase: 'stuck' once started, 'queued too long' before — a 60s
  // wait --pixel-change holds this lock and used to fail healthy queued
  // commands with the misleading 'stuck (dropped callback?)'.
  const timed = Promise.race([
    run,
    new Promise((_, rej) => {
      timer = setTimeout(() => {
        if (!started) cancelled = true;
        rej(
          new Error(
            started
              ? 'CDP command stuck (dropped callback?) — queue advanced'
              : 'queued 65s behind another CDP command on this tab (a long wait --pixel-change?) — cancelled without running; retry after it finishes'
          )
        );
      }, 65_000);
      wake = (e) => {
        clearTimeout(timer);
        rej(e);
      };
    }),
  ]);
  run.then(clearTimeout.bind(null, timer), clearTimeout.bind(null, timer)); // no 65s timer litter per command
  timed.catch(() => {}).finally(() => {
    if (cdpInflight.get(tabId) === wake) cdpInflight.delete(tabId); // don't delete a newer sibling's handle
  });
  cdpQ.set(tabId, timed.catch(() => {}));
  return timed;
}

// --- Device emulation (CDP) -------------------------------------------------
// DevTools-device-toolbar behavior without resizing the window. Attaches
// chrome.debugger (shows the "debugging this browser" infobar while active);
// `unemulate` clears and detaches. Survives navigations while attached.
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const emulatedTabs = new Set();

// --- Boot hydration (storage.session -> in-memory maps) ------------------------
// Declared DOWN HERE on purpose: the IIFE touches tabActivity, groupTab,
// tabStatus, setFavicon, remapTabId, emulatedTabs — every one of them is now
// lexically above it, so no TDZ timing invariant is being relied on. It still
// runs at boot (module eval reaches here in microseconds) and handle() awaits it.
const pendingSwaps = [];
function persist() {
  if (!hydrated) return;
  chrome.storage.session
    .set({
      drivenTabs: [...drivenTabs],
      emulatedTabs: [...emulatedTabs],
      tabStatus: Object.fromEntries(tabStatus),
      tabActivity: Object.fromEntries(tabActivity),
    })
    .catch(() => {});
}

// SW restarts wipe the in-memory maps — rehydrate from storage.session and
// prune ids of tabs that no longer exist. handle() awaits `ready` so no
// command can observe a half-empty map. NOTE: the old belt-and-braces merge
// from the 🟣 Bridge tab group is GONE on purpose: the group is a user-
// editable strip object, so a human dragging a never-driven tab into it made
// hydration resurrect the tab as driven — forever, with no release coming
// (found by the flow review). Group membership is bridge-MADE state, not
// bridge-proof state; storage.session is the only source of truth.
const ready = (async () => {
  try {
    const s = await chrome.storage.session.get(['drivenTabs', 'emulatedTabs', 'tabStatus', 'tabActivity', 'swLogs']);
    for (const id of s.drivenTabs || []) drivenTabs.add(id);
    for (const id of s.emulatedTabs || []) emulatedTabs.add(id);
    for (const [k, v] of Object.entries(s.tabStatus || {})) tabStatus.set(Number(k), v);
    for (const [k, v] of Object.entries(s.tabActivity || {})) tabActivity.set(Number(k), v);
    // The dead worker's log tail rides along — this worker's own lines (the
    // 'background vX loaded' marker) stay newest at the end.
    swLogs.unshift(...(s.swLogs || []));
    if (swLogs.length > 100) swLogs.length = 100;
    logsHydrated = true;
  } catch {}
  // Prerender swaps that fired before hydration (the swap itself is often the
  // wake event): replay now — restored old-id state moves to the live new id
  // in time to survive the prune right below.
  for (const [n, o] of pendingSwaps.splice(0)) remapTabId(n, o);
  try {
    const live = new Set((await chrome.tabs.query({})).map((t) => t.id));
    for (const id of [...drivenTabs]) if (!live.has(id)) drivenTabs.delete(id);
    for (const id of [...emulatedTabs]) if (!live.has(id)) emulatedTabs.delete(id);
    for (const id of [...tabStatus.keys()]) if (!live.has(id)) tabStatus.delete(id);
    for (const id of [...tabActivity.keys()]) if (!live.has(id)) tabActivity.delete(id);
  } catch {}
  // A ⏳ tabStatus outlived its worker: the finally that clears it died with
  // the SW, and inflight is memory-only — nothing is running in this fresh
  // worker. Reset the stale ones or onUpdated re-applies ⏳ after every
  // navigation of that tab, forever.
  for (const id of [...tabStatus.keys()]) if (tabStatus.get(id) === '⏳') setFavicon(id, null);
  // What survived the restart is THE diagnostic question after reload trouble
  // (storage.session dies on extension reload; the re-mark on the next command
  // rebuilds the rest).
  logLine(`hydrated driven=${drivenTabs.size} emulated=${emulatedTabs.size}`);
  hydrated = true; // persist() is safe from here on — the catch-up below persists
  // SW-death catch-up: a driven tab that navigated while the worker was dead
  // lost its 'complete' event (never replayed) — findTab won't re-mark it
  // (already driven) and pillInject no-ops without the banner, so the bridge
  // could keep acting on a tab wearing NO markers. Re-assert banner, group
  // and favicon on every driven tab each time the worker starts; convergence
  // then holds across SW cycles no matter which events were lost — except a
  // pill the human ✕'d on THIS document (respectHide), which stays hidden.
  for (const id of [...drivenTabs]) {
    groupTab(id).catch(() => {}); // strip marker, like markTab's
    chrome.scripting.executeScript({ target: { tabId: id }, func: injectBanner, args: [true] }).catch(() => {});
    if (tabStatus.get(id)) setFavicon(id, tabStatus.get(id));
  }
  persist(); // the ⏳ resets above became durable only now
})();


async function setEmulation(tabId, { width, height, mobile, focus }) {
  // The emulation share in cdpRefs is owned by emulatedTabs membership, not by
  // each call — re-emulating a tab (resize the device) must not take a second
  // share, or N emulates + one unemulate would leave the debugger attached and
  // the metrics uncleared. Membership is set before the first await so a
  // concurrent emulate on the same tab can't double-claim the share.
  const fresh = !emulatedTabs.has(tabId);
  if (fresh) {
    emulatedTabs.add(tabId);
    persist();
    try {
      await attachDbg(tabId);
    } catch (e) {
      emulatedTabs.delete(tabId);
      persist();
      throw e;
    }
  }
  try {
    if (focus) {
      // Focus emulation: the page believes it's focused, so focus-GATED work
      // (pages that pause on document.hasFocus() === false — timers, video,
      // dashboards) keeps running while the tab sits in the background. NOT
      // a compositor override: an occluded window's rendering suspension and
      // visibility-based timer throttling are NOT fixed by this.
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      return;
    }
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
  } catch (e) {
    // Mid-setup failure: only a fresh attach owns a share to give back — a
    // re-emulation's failure leaves the previous emulation in effect.
    if (fresh) {
      emulatedTabs.delete(tabId);
      persist();
      await detachDbg(tabId);
    }
    throw e;
  }
}

async function clearEmulation(tabId) {
  // A stray unemulate (nothing emulated) is a clean no-op — firing the CDP
  // clear at an unattached debugger logged a FAILED in swlogs while the caller
  // got ok (stress: 1 per 40 interleaved cycles). The entry guard also keeps
  // it from decrementing a piggybacking net/shot off the shared session.
  if (!emulatedTabs.has(tabId)) return;
  try {
    await chrome.debugger.sendCommand(
      { tabId },
      'Emulation.clearDeviceMetricsOverride'
    );
    // setEmulation also sets touch + (mobile) a UA override + (focus mode)
    // focus emulation — clear all, or the tab keeps the phone UA / fake focus.
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setTouchEmulationEnabled', { enabled: false });
    await chrome.debugger.sendCommand({ tabId }, 'Network.setUserAgentOverride', { userAgent: '' });
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: false });
    logLine('emulation cleared ' + tabId);
  } catch (e) {
    logLine('emulation clear ' + tabId + ' FAILED: ' + String(e).slice(0, 80));
  }
  emulatedTabs.delete(tabId);
  persist();
  await detachDbg(tabId);
}

// --- Network capture (CDP) ---------------------------------------------------
// Opt-in debug mode: attaches the debugger (infobar shows) for `duration` ms,
// returns one compact line per request. Bodies are opt-in (--body <substr>):
// only matching JSON/text URLs, 8 max, 1500 chars each — enough to read an
// API answer, capped so a busy page can't flood the agent's context.
const netCollectors = new Map(); // tabId -> Map(requestId -> entry)

chrome.debugger.onEvent.addListener((src, method, params) => {
  const c = netCollectors.get(src.tabId);
  if (!c) return;
  // --ws: WebSocket frames — chat/streaming apps are invisible to the request
  // lines. Nearly free: the debugger is attached for the capture anyway.
  if (c.ws && method.startsWith('Network.webSocket')) {
    if (method === 'Network.webSocketCreated') c.wsUrls.set(params.requestId, params.url);
    else if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
      if ((c.wsFrames.length || 0) < 200)
        c.wsFrames.push({
          url: c.wsUrls.get(params.requestId) || '(closed socket)',
          dir: method === 'Network.webSocketFrameSent' ? '→' : '←',
          data: params.response?.opcode === 2 ? '(binary ' + (params.response?.payloadData?.length || 0) + 'B)' : (params.response?.payloadData || '').slice(0, 300),
        });
    }
    return;
  }
  if (method === 'Network.requestWillBeSent') {
    // Initiator (already on the wire): the request→issuing-script jump —
    // first stack frame with a URL, or the parser's URL. 'other' with no URL
    // adds nothing and stays off the line.
    const i = params.initiator || {};
    let init = '';
    const tail = (u, ln) => u.split('/').pop().slice(0, 40) + (ln != null ? ':' + ln : '');
    if (i.type === 'script' && i.stack?.callFrames) {
      const fr = i.stack.callFrames.find((f) => f.url && !f.url.startsWith('chrome-extension://'));
      if (fr) init = ' ⟵ ' + tail(fr.url, fr.lineNumber);
    } else if (i.url) init = ' ⟵ ' + tail(i.url, i.lineNumber);
    else if (i.type && i.type !== 'other') init = ' ⟵ ' + i.type;
    // req/wallTime/initiator ride the entry for the HAR export (--har) — the
    // payloads are already in this event, keeping them costs nothing.
    c.set(params.requestId, { t: Date.now(), wall: params.wallTime, method: params.request.method, url: params.request.url, init, req: params.request, initObj: params.initiator });
  } else if (method === 'Network.responseReceived') {
    const r = c.get(params.requestId);
    if (r) { r.status = params.response.status; r.mime = params.response.mimeType; r.res = params.response; }
  } else if (method === 'Network.loadingFinished') {
    const r = c.get(params.requestId);
    if (r) {
      r.ms = Date.now() - r.t; r.size = params.encodedDataLength;
      // --body: filtered bodies append to the printed lines (agent context —
      // 8 max). --har: text/JSON bodies go into the FILE (50 max, they don't
      // cost context), the lines stay untouched.
      const textish = /json|text|xml|javascript/.test(r.mime || '');
      const forLine = !!(c.bodyFilter && (c.bodyCount || 0) < 8 && r.url.includes(c.bodyFilter));
      const forHar = !!(c.har && (c.bodyCount || 0) < 50);
      if (textish && (forLine || forHar)) {
        c.bodyCount = (c.bodyCount || 0) + 1;
        r.lineBody = forLine;
        r.bodyP = chrome.debugger.sendCommand(src, 'Network.getResponseBody', { requestId: params.requestId }).catch(() => null);
      }
    }
  } else if (method === 'Network.loadingFailed') {
    const r = c.get(params.requestId);
    if (r) { r.ms = Date.now() - r.t; r.error = params.errorText; }
  }
});

async function captureNetwork(tabId, duration, filter, bodyFilter, har, ws) {
  await attachDbg(tabId);
  const c = new Map();
  c.bodyFilter = bodyFilter;
  c.har = har;
  c.ws = ws;
  c.wsUrls = new Map();
  c.wsFrames = [];
  netCollectors.set(tabId, c);
  // Kill switch for the pre-sleep awaits: onDetach sets c.detached and fires
  // c.wake — but c.wake only exists once the sleep starts, so a detach during
  // Network.enable (whose callback Chrome drops) used to hang the capture to
  // the 65s withCdp backstop and leak the collector meanwhile.
  c.dead = new Promise((_, rej) => (c.kill = rej));
  c.dead.catch(() => {}); // handled even when no await is racing it (sleep window)
  try {
    await Promise.race([
      chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
        maxTotalBufferSize: 10_000_000,
        maxResourceBufferSize: 5_000_000,
      }),
      c.dead,
    ]);
    await Promise.race([new Promise((r) => setTimeout(r, Math.min(duration || 4000, 30000))), new Promise((r) => (c.wake = r))]); // onDetach wakes us — a cut-short capture reports now, not after the full --dur
    if ((bodyFilter || har) && !c.detached)
      // Await body fetches while still attached — they fail after detach.
      // (Skipped after a detach: those callbacks may never fire.)
      for (const r of c.values())
        if (r.bodyP) {
          if (c.detached) break; // detached mid-loop: further callbacks never fire
          const b = await Promise.race([r.bodyP, c.dead]).catch(() => null);
          if (b) r.bodyRaw = b; // kept whole for the HAR (base64 flag and all)
          if (r.lineBody) r.body = !b ? '(body unavailable)' : b.base64Encoded ? '(binary body)' : b.body.slice(0, 1500);
        }
    await chrome.debugger.sendCommand({ tabId }, 'Network.disable').catch(() => {});
  } finally {
    netCollectors.delete(tabId);
    await detachDbg(tabId);
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
    lines.push(`${r.method} ${status} ${u}${kb}${ms}${r.init || ''}`);
    if (r.body) lines.push('  ↳ ' + r.body.replace(/\s+/g, ' ').trim());
    if (lines.length >= 100) { lines.push('… truncated at 100 requests — use --filter'); break; }
  }
  // External detach mid-capture (user cancelled the infobar): the sleep ran
  // out the full duration but events stopped — say so, don't pass the partial
  // list off as a full capture.
  if (c.detached) lines.push('⚠ capture cut short — debugger detached mid-capture');
  // The --ws frame section rides the same output, grouped per connection.
  // --filter keeps applying to request lines only (frame URLs rarely match
  // the API path being filtered on).
  if (c.ws) {
    if (!c.wsFrames.length) lines.push('(no WebSocket frames this window)');
    else {
      lines.push('— WebSocket frames —');
      let url = null;
      for (const f of c.wsFrames) {
        if (f.url !== url) {
          url = f.url;
          lines.push('WS ' + (url.length > 80 ? url.slice(0, 77) + '…' : url));
        }
        lines.push('  ' + f.dir + ' ' + f.data.replace(/\s+/g, ' ').trim());
      }
      if (c.wsFrames.length >= 200) lines.push('… frame cap 200 reached — run another capture for more');
    }
  }
  const text = lines.join('\n') || '(no requests captured — is the page idle? trigger the action, then run net again)';
  if (!har) return text;
  // HAR 1.2 (DevTools/Burp/Caido open it): everything here was already riding
  // the events — headers, postData, wallTime, initiator (#11 → the standard
  // _initiator field). Bodies ride content.text (base64-encoded flagged) for
  // the requests the capture fetched them for.
  const H = (hdrs) => Object.entries(hdrs || {}).map(([name, value]) => ({ name, value: Array.isArray(value) ? value.join('\n') : String(value) }));
  const qs = (u) => {
    try {
      return [...new URL(u).searchParams].map(([name, value]) => ({ name, value }));
    } catch {
      return [];
    }
  };
  return {
    lines: text,
    har: {
      log: {
        version: '1.2',
        creator: { name: 'chrome-bridge', version: chrome.runtime.getManifest().version },
        entries: [...c.values()].map((r) => ({
          startedDateTime: r.wall != null ? new Date(r.wall * 1000).toISOString() : new Date(r.t).toISOString(),
          time: r.ms || 0,
          request: {
            method: r.method,
            url: r.url,
            httpVersion: r.req?.protocol || 'HTTP/1.1',
            headers: H(r.req?.headers),
            queryString: qs(r.url),
            cookies: [],
            headersSize: -1,
            bodySize: -1,
            ...(r.req?.postData ? { postData: { mimeType: r.req.postData.mimeType || '', text: String(r.req.postData.text || '').slice(0, 100_000) } } : {}),
          },
          response: r.res
            ? {
                status: r.res.status,
                statusText: r.res.statusText || '',
                httpVersion: r.res.protocol || 'HTTP/1.1',
                headers: H(r.res.headers),
                cookies: [],
                content: {
                  size: r.size || 0,
                  mimeType: r.res.mimeType || '',
                  ...(r.bodyRaw ? (r.bodyRaw.base64Encoded ? { text: r.bodyRaw.body.slice(0, 300_000), encoding: 'base64' } : { text: r.bodyRaw.body.slice(0, 300_000) }) : {}),
                },
                redirectURL: '',
                headersSize: -1,
                bodySize: r.size ?? -1,
              }
            : { status: 0, statusText: r.error || '(no response)', httpVersion: '', headers: [], cookies: [], content: { size: 0, mimeType: '' }, redirectURL: '', headersSize: -1, bodySize: -1 },
          cache: {},
          timings: { send: 0, wait: r.ms || 0, receive: 0 },
          _initiator: { type: r.initObj?.type || 'other', ...(r.initObj?.url ? { url: r.initObj.url } : {}), ...(r.initObj?.stack?.callFrames?.[0]?.url ? { frame: r.initObj.stack.callFrames[0].url + ':' + r.initObj.stack.callFrames[0].lineNumber } : {}) },
        })),
      },
    },
  };
}

// In-page fetch/fetch-fallback body cap — one number, interpolated into the
// page-side template and used by the SW-side fallback alike.
const BODY_CAP = 512_000;

// --- Page-side scripts ------------------------------------------------------
// These run through runEval (ISOLATED world, MAIN fallback, CDP last resort).
// Refs from snap live in `window.__bridgeRefs` of the world snap ran in;
// click/fill run through the same pipeline so they resolve in the same world.

const SNAP_SRC = (scope, diff, href, skel) => `(() => {
  const MAX = 300;
  // --skeleton: depth-limited map — past the cut, count instead of emit.
  const SKEL = ${skel ? 'true' : 'false'};
  const CUT = 3;
  // width-fold threshold: near the cap, skeleton mode stops WALKING further
  // children and counts them instead — a wide tree at/below the depth cut
  // used to blow past MAX and truncate exactly like the plain snap.
  const WCUT = MAX - 40;
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
  let skipped = 0;
  const lines = [];
  const ROLE_BY_TAG = { A:'link', BUTTON:'button', SELECT:'combobox', TEXTAREA:'textbox', SUMMARY:'button',
    H1:'heading', H2:'heading', H3:'heading', H4:'heading', H5:'heading', H6:'heading',
    IMG:'img', NAV:'navigation', MAIN:'main', HEADER:'banner', FOOTER:'contentinfo', ASIDE:'complementary',
    FORM:'form', DIALOG:'dialog', TABLE:'table', UL:'list', OL:'list', LI:'listitem', LABEL:'label',
    IFRAME:'frame' };
  const INPUT_ROLE = { checkbox:'checkbox', radio:'radio', range:'slider', button:'button', submit:'button', reset:'button', search:'searchbox', file:'file' };
  const hidden = (el) => { const s = getComputedStyle(el); return s.display === 'none' || s.visibility === 'hidden'; };
  const hasBox = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return ['presentation', 'none'].includes(explicit) ? null : explicit;
    if (el.tagName === 'INPUT') return INPUT_ROLE[el.type] || 'textbox';
    // editing HOSTS (the attr marks the host; inheritors read 'inherit') —
    // fill/paste drive contenteditable editors, but the tree never showed
    // them (stress: rich fixture's #ce invisible between its headings)
    const ce = el.getAttribute('contenteditable');
    if (ce === 'true' || ce === 'plaintext-only') return 'textbox';
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
    if (el.tagName === 'IFRAME') return (el.getAttribute('src') || '').slice(0, 60); // a cross-origin frame is otherwise a black hole in the tree
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
    if (['textbox', 'searchbox', 'combobox', 'slider', 'file'].includes(role)) {
      // Never print a password field's value — an autofilled credential is
      // exactly what "your logged-in browser" means, and snap lines land in
      // the agent's context and terminal scrollback.
      if (el.type === 'password') {
        if (el.value) s.push('value=•••');
      } else {
        const v = el.value ?? el.getAttribute('aria-valuenow');
        if (v !== undefined && v !== null && v !== '') s.push('value=' + JSON.stringify(String(v).slice(0, 40)));
      }
    }
    // hrefs are the biggest token sink in snap (~60% on link-heavy pages) and
    // almost never needed — the @eN ref is what you click. Keep them only for
    // nameless links (else they'd be unidentifiable) or when --href is passed.
    if (role === 'link' && el.href && (${href ? 'true' : 'false'} || !name)) {
      s.push(el.href.length > 60 ? el.href.slice(0, 57) + '…' : el.href);
    }
    return s.length ? ' ' + s.join(' ') : '';
  }
  // Count of line-worthy elements in a subtree (the --skeleton cut's payload):
  // same line rules as walk, no refs, no output.
  function countLines(el) {
    if (el.id === 'bridge-banner' || el.id === 'bridge-grid' || el.id === 'bridge-cursor') return 0;
    if (hidden(el)) return 0;
    const role = roleOf(el);
    let count = 0;
    if (role && hasBox(el)) {
      const name = nameOf(el, role);
      if (!name && (role === 'img' || role === 'status')) skipped++;
      else count = 1;
    }
    for (const c of el.children) count += countLines(c);
    if (el.shadowRoot) for (const c of el.shadowRoot.children) count += countLines(c);
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      try { if (el.contentDocument?.body) count += countLines(el.contentDocument.body); } catch {} // cross-origin
    }
    return count;
  }
  function walk(el, depth) {
    // --skeleton: past the cut, count instead of emit — the count rides the
    // nearest emitted container as '… N inside', so the agent sees exactly
    // which subtrees were skipped (and their size) instead of a silent
    // truncation that grep/--find can't see past. Drill: snap <match> @ref.
    if (SKEL && depth > CUT) return countLines(el);
    if (lines.length >= MAX) { truncated = true; return 0; }
    // The bridge's own UI is not page content: the pill is a role=button
    // whose label mutates every command — it would mint a ref and own the
    // --diff output. Skip it (and the cursor/grid overlays) entirely.
    if (el.id === 'bridge-banner' || el.id === 'bridge-grid' || el.id === 'bridge-cursor') return 0;
    if (hidden(el)) return 0;
    const role = roleOf(el);
    let childDepth = depth;
    let myRef = null;
    let myLineIdx = -1; // where MY line landed — annotations append here even
                        // when children emitted lines after it (width fold)
    if (role && hasBox(el)) {
      const name = nameOf(el, role);
      // Unnamed imgs/statuses are decorative icons and empty live regions —
      // zero information, but 60-80 lines per snap on real apps. No line, no
      // ref; children still walked at the same depth.
      if (!name && (role === 'img' || role === 'status')) {
        skipped++;
      } else {
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
        myRef = ref;
        const fresh = markFresh && !seen.has(ref);
        seen.add(ref);
        myLineIdx = lines.push('  '.repeat(Math.min(depth, 10)) + (fresh ? '* ' : '') + role + (name ? ' ' + JSON.stringify(name) : '') + ' @' + ref + stateOf(el, role, name)) - 1;
        childDepth = depth + 1;
      }
    }
    let inside = 0;
    let foldCnt = 0;
    const kid = (c) => {
      // width fold: once the map nears the cap, stop WALKING further children
      // and count them — a skeleton must never silently truncate at MAX
      // (a wide tree at role-depth <= CUT used to).
      if (SKEL && lines.length >= WCUT) { foldCnt += countLines(c); return; }
      inside += walk(c, childDepth);
    };
    for (const c of el.children) kid(c);
    if (el.shadowRoot) for (const c of el.shadowRoot.children) kid(c);
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') { // FRAME: old <frameset> pages — walk them too, else the tree is silently empty
      try { if (el.contentDocument?.body) kid(el.contentDocument.body); } catch {} // cross-origin
    }
    if (SKEL && foldCnt) {
      // attach the fold count to the parent's line; a role-less parent gets
      // a minted container line so the drill (snap <match> @ref) always has
      // a handle — counts used to vanish silently up div-soup ancestors.
      let idx = myLineIdx;
      if (idx < 0) {
        const crole = role || 'container';
        const cname = nameOf(el, crole) || '';
        const key2 = crole + ' ' + cname;
        let ref = el.__bridgeRef;
        if (ref && (refs[ref] !== el || el.__bridgeRefKey !== key2)) ref = null;
        if (!ref) { ref = 'e' + ++n; window.__bridgeRefN = n; el.__bridgeRef = ref; el.__bridgeRefKey = key2; }
        refs[ref] = el;
        myRef = ref;
        idx = lines.push('  '.repeat(Math.min(depth, 10)) + crole + (cname ? ' ' + JSON.stringify(cname) : '') + ' @' + ref + stateOf(el, crole, cname)) - 1;
      }
      lines[idx] += ' … ' + foldCnt + ' inside';
    }
    if (SKEL && myRef && childDepth > CUT && inside) lines[myLineIdx] += ' … ' + inside + ' inside';
    return (myRef ? 1 : 0) + inside + foldCnt;
  }
  const scopeSel = ${JSON.stringify(scope || null)};
  ${DEEPQ}
  // Scope = subtree root: a CSS selector (document-level, then open shadow
  // roots) or an @ref — the --skeleton drill-down is 'snap <match> @eN'.
  const root = scopeSel ? (scopeSel.startsWith('@') ? window.__bridgeRefs?.[scopeSel.slice(1)] : document.querySelector(scopeSel) || deepAll(scopeSel, document)[0]) : document.body;
  if (!root) throw new Error('scope not found: ' + scopeSel + (scopeSel.startsWith('@') ? ' — refs expire on navigation; run snap again' : ''));
  walk(root, 0);
  if (truncated) lines.push('… truncated at ' + MAX + ' nodes' + (scopeSel ? '' : ' — scope with: snap <match> <css>'));
  // --diff: lines added/changed/removed since the last snap at THIS scope.
  const store = (window.__bridgeSnapLines = window.__bridgeSnapLines || {});
  // Key by scope AND href mode: lines embed hrefs only in --href snaps, so a
  // shared key would report every link as changed when the flag is toggled.
  const skey = (scopeSel || '') + (${href ? 'true' : 'false'} ? '|href' : '') + (${skel ? 'true' : 'false'} ? '|skel' : '');
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
  // Display elision (full snaps only): identical lines — same indent, role,
  // name, state, differing only by ref — collapse after the first occurrence
  // into trailing "… N more" summaries that keep the refs clickable. Repeated
  // rows (avatar stacks, row checkboxes, icon buttons) were ~25% of snap
  // bytes on real apps. Starred (fresh) lines always show. The diff store
  // above is built from full lines, so --diff is unaffected.
  if (!${diff ? 'true' : 'false'}) {
    // Two passes: count identical lines first so dups occurring only twice
    // stay inline in place (a "1 more" summary costs what it saves), and only
    // lines seen 3+ times collapse — first occurrence in place, rest summarized.
    const keys = lines.map((l) => (/^\\s*\\* /.test(l) ? null : l.replace(/ @e\\d+/, '')));
    const counts = new Map();
    for (const k of keys) if (k) counts.set(k, (counts.get(k) || 0) + 1);
    const shown = new Set();
    const extra = new Map();
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const k = keys[i];
      if (!k || counts.get(k) < 3 || !shown.has(k)) {
        if (k) shown.add(k);
        out.push(lines[i]);
        continue;
      }
      if (!extra.has(k)) extra.set(k, []);
      extra.get(k).push(lines[i].match(/@(e\\d+)/)[1]);
    }
    for (const [k, refs2] of extra) {
      out.push('… ' + refs2.length + ' more · ' + k.trim() + ' → ' + refs2.map((r) => '@' + r).join(' '));
    }
    if (skipped) out.push('… ' + skipped + ' unnamed img/status elided (decorative — no name, no ref)');
    return out.join('\\n');
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
    c.id = 'bridge-cursor'; // id'd so the settle filter can ignore its mutations
    c.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;left:' + x + 'px;top:' + y +
      'px;animation:bridge-cursor-fade .3s .9s forwards';
    // ponytail: DOM-built nodes, not innerHTML — Trusted-Types CSPs (Gmail)
    // make innerHTML assignments throw and kill the whole click.
    if (ripple) {
      const r = document.createElement('div');
      r.style.cssText =
        'position:absolute;left:-14px;top:-14px;width:28px;height:28px;border:3px solid rgba(147,51,234,.9);border-radius:50%;animation:bridge-ripple .6s ease-out forwards';
      c.appendChild(r);
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.style.filter = 'drop-shadow(0 1px 1px rgba(0,0,0,.4))';
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M3 1v16l3.9-3.7 2.3 5.5 2.8-1.2-2.4-5.4 5.6-.6z');
    p.setAttribute('fill', '#9333ea');
    p.setAttribute('stroke', '#fff');
    p.setAttribute('stroke-width', '1.3');
    svg.appendChild(p);
    c.appendChild(svg);
    (document.body || document.documentElement).appendChild(c);
    setTimeout(() => c.remove(), 1300);
  };
`;

// File inputs can't be driven synthetically: the chooser needs a trusted
// gesture and JS value-set is ignored. Fail loudly toward upload instead of
// returning fake success ('clicked'/'filled'/'typed' while nothing happened).
const FILE_INPUT_GUARD = `if (el.tagName === 'INPUT' && el.type === 'file') throw new Error('file input — synthetic events cannot set it; use: upload <match> ' + sel + ' <file...>');`;
// Shadow-piercing target resolution, embedded into the page scripts that
// resolve a selector. @refs and document-level CSS stay the fast path; the
// deep fallback walks OPEN shadow roots (Reddit's faceplate-*, LinkedIn's
// nested roots) — document.querySelector can't reach those. snap already
// shows shadow elements with refs, so this is the CSS escape hatch, not the
// main road. The fallback runs only on a document miss (it walks every
// element to find shadow hosts), and closed roots stay invisible to it.
const DEEPQ = `
  const deepAll = (sel, root) => {
    let out = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) out = out.concat(deepAll(sel, el.shadowRoot));
      // same-origin frames: their elements sit in the snap tree and are
      // drivable in place — CSS resolution must reach them (stress: click
      // iframe.html #kid-btn → 'element not found' while @ref worked)
      if ((el.tagName === 'IFRAME' || el.tagName === 'FRAME') && el.contentDocument?.body) {
        try { out = out.concat(deepAll(sel, el.contentDocument.body)); } catch {}
      }
    }
    return out;
  };
  const deepQuery = (sel) => {
    if (sel.startsWith('@')) return window.__bridgeRefs?.[sel.slice(1)] || null;
    return document.querySelector(sel) || deepAll(sel, document)[0] || null;
  };
  // deepQuery + the canonical miss error in one place — every action script
  // embeds this; the '@' suffix teaches the recovery move (refs expire on
  // navigation). A CSS miss gets the same hint style for consistency.
  const queryErr = (sel) => 'element not found: ' + sel + (sel.startsWith('@') ? ' — refs expire on navigation; run snap again' : ' — check the selector against a fresh snap');
  const mustQuery = (sel) => {
    const el = deepQuery(sel);
    if (!el) throw new Error(queryErr(sel));
    return el;
  };
  // React-safe value write: the native setter, so React's value tracker sees
  // a real change. fill/type/paste all go through this.
  const nativeSet = (el, val) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
  };
`;
// fill on a checkbox/radio would set .value without toggling checked and
// report 'filled' — fake success. Fail loudly toward click instead.
const CHECK_RADIO_GUARD = `if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) throw new Error('checkbox/radio — fill cannot toggle checked; use: click <match> ' + sel);`;

// Same-origin frame plumbing: an element inside an <iframe> has getBoundingClientRect
// relative to ITS OWN frame's viewport, while elementFromPoint / the top document
// / CDP Input all speak top-viewport coords. Without the hop, an iframe child was
// unclickable ('click covered by <body>' — stress) and --trusted input went to the
// wrong point. toTop translates element coords up the frame chain; pierceFromPoint
// is elementFromPoint that descends INTO same-origin frames (a cross-origin frame
// is a wall, matching the "one frame line, not drivable" rule).
const FRAME_SRC = `
  const toTop = (el, x, y) => {
    let d = el.ownerDocument;
    while (d !== document) {
      const f = d.defaultView?.frameElement;
      if (!f) break;
      const r = f.getBoundingClientRect();
      x += r.left; y += r.top;
      d = f.ownerDocument;
    }
    return [x, y];
  };
  const pierceFromPoint = (x, y) => {
    let hit = document.elementFromPoint(x, y);
    while (hit && (hit.tagName === 'IFRAME' || hit.tagName === 'FRAME') && hit.contentDocument?.body) {
      const r = hit.getBoundingClientRect();
      x -= r.left; y -= r.top;
      hit = hit.contentDocument.elementFromPoint(x, y);
    }
    return hit;
  };
`;

// Coverage preflight (shared by the synthetic click and --trusted input):
// fail loudly when an overlay intercepts the click point instead of letting
// a click silently land on the wrong element. elementFromPoint never pierces
// shadow roots — for a point inside one it returns the HOST, and
// host.contains() walks light DOM only, so a target inside a shadow tree
// whose host covers the point used to read as a stranger overlay (LinkedIn:
// every modal element lives in one shadow tree). Walk the target's composed
// chain: a host whose shadow subtree contains the target is a container, not
// an occluder. The walk only ever CLEARS hosts on the target's own chain —
// a real stranger overlay still fails. Requires cx/cy/el in scope.
const COVERAGE_SRC = `
  // toTop/pierceFromPoint come from FRAME_SRC, embedded by the calling src
  const [covX, covY] = toTop(el, cx, cy);
  const top = pierceFromPoint(covX, covY);
  let covered = !!(top && top !== el && !el.contains(top) && !top.contains(el) && !top.closest('#bridge-banner'));
  if (covered) {
    for (let n = el, root = n.getRootNode(); root instanceof ShadowRoot; n = root.host, root = n.getRootNode())
      if (root.host === top) { covered = false; break; }
  }
  if (covered) {
    const cls = typeof top.className === 'string' && top.className.trim() ? '.' + top.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    const txt = (top.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    throw new Error('click covered by <' + top.tagName.toLowerCase() + cls + '>' + (txt ? ' "' + txt + '"' : '') + ' — close the overlay or click that element first');
  }
`;

const clickSrc = (target, dbl) => `(() => {
  ${DEEPQ}
  ${FRAME_SRC}
  const sel = ${JSON.stringify(target)};
  const el = mustQuery(sel);
  ${FILE_INPUT_GUARD}
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  ${COVERAGE_SRC}
  ${CURSOR_SRC}
  // the cursor overlay lives in the TOP document — a frame child's center
  // must be translated or the ping shows in the wrong place
  showCursor(...toTop(el, cx, cy), true);
  const o = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0 };
  const pair = (detail) => {
    el.dispatchEvent(new PointerEvent('pointerover', o));
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.focus?.();
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', { ...o, detail })); // detail 2 = the second half of a double-click
  };
  pair(1);
  ${dbl ? `pair(2);
  el.dispatchEvent(new MouseEvent('dblclick', { ...o, detail: 2 }));` : ''}
  return 'clicked ' + sel${dbl ? ' (double)' : ''};
})()`;

const fillSrc = (target, value) => `(() => {
  ${DEEPQ}
  const sel = ${JSON.stringify(target)}, value = ${JSON.stringify(value)};
  const el = mustQuery(sel);
  ${FILE_INPUT_GUARD}
  ${CHECK_RADIO_GUARD}
  el.scrollIntoView({ block: 'center' });
  el.focus?.();
  if (el.isContentEditable) {
    el.innerText = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  } else if (el.tagName === 'SELECT') {
    // el.value = <no matching option> silently selects NOTHING and the old code
    // still returned 'filled'. Match by value or visible label first, and fail
    // loudly with the available choices instead of reporting fake success.
    const hit = [...el.options].find((o) => o.value === value || o.label === value || o.text === value);
    // The value the agent sent can be a secret (server.mjs keeps values out of
    // logs on purpose) — don't echo it back through the error into server.log
    // and the watch feed; the agent knows what it sent.
    if (!hit) throw new Error('no option matching (as sent) — options: ' + [...el.options].slice(0, 8).map((o) => '"' + (o.label || o.text) + '" (value ' + JSON.stringify(o.value) + ')').join(', ') + ' — match a label or value');
    el.value = hit.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // Native setter + events, so React's value tracker sees a real change.
    nativeSet(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return 'filled ' + sel;
})()`;

// Per-char typing: real keydown/input/keyup per character, so autocomplete and
// keystroke-driven UIs react (fill sets the value in one shot and they don't).
const typeSrc = (target, text) => `(async () => {
  ${DEEPQ}
  const sel = ${JSON.stringify(target)}, text = ${JSON.stringify(text)};
  let el = mustQuery(sel);
  ${FILE_INPUT_GUARD}
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
    const o = { bubbles: true, cancelable: true, composed: true, key: ch, code: /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : 'Digit' + ch,
      keyCode: /[a-z]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : ch.charCodeAt(0) }; // legacy e.which readers (old jQuery)
    el.dispatchEvent(new KeyboardEvent('keydown', o));
    if (el.isContentEditable) {
      document.execCommand('insertText', false, ch); // deprecated, still the only CE path that fires beforeinput correctly
    } else {
      nativeSet(el, el.value + ch);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
    }
    el.dispatchEvent(new KeyboardEvent('keyup', o));
    // The 25ms cadence is for autocomplete/keystroke UIs (short interactive
    // text). Cap the total sleep budget at ~15s — a flat 25ms × 1200 chars is
    // 30s of pure sleep before the page's own per-keystroke cost, which is
    // what blew the 70s cap on heavy composers. Long-form text is paste's job.
    await new Promise((r) => setTimeout(r, Math.min(25, 15000 / text.length)));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
  const got = el.isContentEditable ? el.innerText : el.value;
  const warn = got !== undefined && !String(got).endsWith(text) ? ' — WARNING readback is ' + JSON.stringify(String(got).slice(0, 40)) + ' (framework rewrote the value; consider fill)' : '';
  return 'typed ' + text.length + ' chars into ' + sel + warn;
})()`;

// Real-paste semantics: editors that own their content model (Quill,
// ProseMirror, Reddit/LinkedIn rich composers) revert fill writes but accept
// pastes — they install 'paste' handlers that read clipboardData and convert.
// Chrome's ClipboardEvent constructor silently ignores the clipboardData init
// key, so the only way an editor can read our payload is a plain Event with a
// duck-typed clipboardData. No handler claiming it (no preventDefault) → land
// the text the way a native paste would: caret insertion for fields,
// execCommand for contentEditable.
const pasteSrc = (target, value) => `(async () => {
  ${DEEPQ}
  const sel = ${JSON.stringify(target || '')}, text = ${JSON.stringify(value)};
  let el = document.activeElement;
  if (sel) {
    el = mustQuery(sel);
    el.scrollIntoView({ block: 'center' });
    el.focus?.();
  }
  if (!el || !(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
    throw new Error('no text field focused — pass an @ref|css target or click the field first');
  if (el.tagName === 'INPUT' && ['checkbox', 'radio', 'file'].includes(el.type))
    throw new Error('not a text field: <input type=' + el.type + '>');
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  ev.clipboardData = { types: ['text/plain'], getData: (t) => (t === 'text/html' ? null : text) };
  const handled = !el.dispatchEvent(ev);
  if (!handled) {
    if (el.isContentEditable) {
      document.execCommand('insertText', false, text); // deprecated, still the only CE path that fires beforeinput correctly
    } else {
      const start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? start;
      nativeSet(el, el.value.slice(0, start) + text + el.value.slice(end));
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  return 'pasted ' + text.length + ' chars into ' + (sel || '<' + el.tagName.toLowerCase() + '>') + (handled ? ' (editor paste handler)' : '');
})()`;

// snap --find: Nano-picked shortlist.
// The agent asks in natural language ("the cancel button"); Nano picks
// matching lines from a fresh tree. Comes back as a shortlist to VERIFY, not
// ground truth — prototype accuracy was ~2/3 on a 227-element page, with a
// confident wrong pick, so --find never acts and the matched lines are shown
// verbatim for the agent to confirm. Refs-only output keeps the call ~2s
// (a JSON-array-output variant measured 11s).
// ponytail: 48KB candidate cap — probed Nano's quota at ~60-80KB, so 48KB
// covers whole trees on typical pages with margin; chunk + pick-per-chunk
// is the upgrade path for true monsters.
const FIND_SRC = (scope, find) => `(async () => {
  ${NANO_GUARD}
  const tree = ${SNAP_SRC(scope, false, false)};
  const lines = tree.split('\\n').filter((l) => /@e\\d+/.test(l));
  let listing = '';
  let listed = 0;
  for (const l of lines) {
    if (listing.length + l.length > 48000) break;
    listing += l + '\\n';
    listed++;
  }
  const session = await LanguageModel.create();
  try {
    const out = await session.prompt(
      'The UI elements of a page, one per line:\\n' + listing +
      '\\nWhich lines match: ' + ${JSON.stringify(find)} +
      '? Reply with ONLY their refs (@eN), best first, comma-separated. If none match, reply none.'
    );
    const picked = [];
    for (const m of out.matchAll(/e(\\d+)/g)) {
      const ref = '@e' + m[1];
      const line = lines.find((l) => l.includes(ref + ' ') || l.trimEnd().endsWith(ref));
      if (line && !picked.includes(line)) picked.push(line);
    }
    let tail = listed < lines.length ? ' (tree capped at 48KB — scope the snap to reach the rest)' : '';
    // The 300-node snap cap drops the tail of big pages before Nano ever sees
    // them — without this note, 'no matches' reads as 'not on the page' when
    // the truth is 'not reached'. (The truncation line itself has no @eN ref,
    // so the lines filter above already removed it from the listing.)
    if (tree.includes('truncated at')) tail += ' (tree truncated at 300 nodes — the target may be past the cut; scope: snap <match> <css>)';
    if (!picked.length) return 'no matches in ' + listed + ' ref lines — nano said: ' + out.slice(0, 120) + tail;
    return picked.map((l) => l.trim()).join('\\n') +
      '\\n(' + listed + ' ref lines scanned · nano pre-filter — verify before acting)' + tail;
  } finally {
    session.destroy();
  }
})()`;

// measure/grid: small evals that used to live in the CLI as page-JS strings
// with a `label` back-channel for the pill — they're commands, so the source
// lives here with every other page script and ACT_VERBS carries the label.
const measureSrc = (sel) =>
  `JSON.stringify((()=>{${DEEPQ}return deepAll(${JSON.stringify(sel)}, document);})().map(e=>{const r=e.getBoundingClientRect();const c=getComputedStyle(e);return{text:(e.textContent||'').trim().slice(0,30),x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),display:c.display,alignItems:c.alignItems,justifyContent:c.justifyContent,textAlign:c.textAlign,gap:c.gap,padding:c.padding,radius:c.borderRadius,bg:c.backgroundColor,color:c.color,font:c.fontSize+'/'+c.fontWeight}}))`;
const GRID_SRC = `(()=>{const g=document.getElementById('bridge-grid');if(g){g.remove();return 'grid off'}const d=document.createElement('div');d.id='bridge-grid';d.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none;background-image:repeating-linear-gradient(0deg,rgba(255,0,0,.25) 0 1px,transparent 1px 8px),repeating-linear-gradient(90deg,rgba(255,0,0,.25) 0 1px,transparent 1px 8px)';document.body.appendChild(d);return 'grid on'})()`;

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

// Bot-wall / login-wall detection (#8, folded into the verdict pipeline): a
// short scan of iframe srcs, URL, title and page text. Captcha walls →
// needs_human (the human solves them — wait --human); rate-limit patterns →
// blocked (retrying blindly or waiting for a human won't help); login walls →
// needs_human. Signatures are deliberately cheap substring matches — naming
// the wall is worth far more than classifying it perfectly.
const WALL_SRC = `(() => {
  const hay = (
    [...document.querySelectorAll('iframe')].map((f) => f.src || '').join(' ') + ' ' + location.href + ' ' + (document.title || '') + ' ' +
    (document.body?.innerText || '').slice(0, 3000)
  ).toLowerCase();
  const out = {};
  const walls = [
    [/recaptcha/, 'reCAPTCHA'],
    [/challenges\\.cloudflare\\.com|turnstile/, 'Cloudflare Turnstile'],
    [/datadome/, 'DataDome'],
    [/perimeterx|humansecurity|px-captcha/, 'PerimeterX'],
    [/arkose|funcaptcha/, 'Arkose'],
  ];
  const hit = walls.filter(([re]) => re.test(hay)).map(([, n]) => n);
  if (hit.length) out.captcha = hit.join(', ');
  if (/unusual traffic|too many requests|rate.?limit|access denied|request blocked/.test(hay)) out.block = 'rate limit / bot wall';
  if (/(\\/|^)log[-_]?in|\\/sign[-_]?in|accounts\\.google\\.com/.test(location.href.toLowerCase())) out.login = true;
  return out;
})()`;

// --- pixel diff: decode PNGs in the service worker (OffscreenCanvas) ---------
// The a11y tree can't see canvas or plain-text changes (bklapholz's
// salesforce pilot watched the screen at 1 FPS for exactly this reason).
// Zero-dep: createImageBitmap + OffscreenCanvas run in the SW — no page round
// trip, no permission. shotBaselines holds the last --diff capture per tab
// (memory-only: an SW restart re-baselines, like the rest of the SW state).
const shotBaselines = new Map(); // tabId -> { b64, clip } of the last --diff shot
const navSeq = new Map(); // tabId -> navigation counter — an in-flight shot --diff detects a mid-capture/diff navigation at COMMIT time (onUpdated deletes the baseline, but the diff may be past its identity check by then)

async function pngBitmap(b64) {
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return await createImageBitmap(new Blob([buf], { type: 'image/png' }));
}

// Compare two captures (channel-sum tolerance 24 ≈ antialiasing jitter).
// Returns stats in CAPTURE pixel coordinates plus the second bitmap, for
// cropping the changed region without a re-capture. Bitmap ownership: the
// caller owns bmpB on success (close it when done); the error path closes
// bmpB here, and pixelDiff's wrapper always closes bmpA.
async function diffBmp(bmpA, bmpB) {
  if (bmpA.width !== bmpB.width || bmpA.height !== bmpB.height) {
    bmpB.close();
    return { error: 'viewport size changed between shots — no pixel diff; the new shot is now the baseline' };
  }
  const read = (bmp) => {
    const oc = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = oc.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  };
  const A = read(bmpA);
  const B = read(bmpB);
  let changed = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0, px = 0; i < A.length; i += 4, px++) {
    if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) <= 24) continue;
    changed++;
    const x = px % bmpB.width;
    const y = (px / bmpB.width) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!changed) return { changed: 0, pct: '0.0', bmp: bmpB };
  return { changed, pct: ((changed / (A.length / 4)) * 100).toFixed(1), minX, minY, maxX, maxY, bmp: bmpB };
}

// b64 convenience wrapper — the waitPixel poll loop decodes its baseline ONCE
// and calls diffBmp directly instead of re-decoding a multi-MB png per poll.
async function pixelDiff(b64A, b64B) {
  const bmpA = await pngBitmap(b64A);
  try {
    return await diffBmp(bmpA, await pngBitmap(b64B));
  } finally {
    bmpA.close(); // fully copied into ImageData by diffBmp — release the handle
  }
}

async function cropDataUrl(bmp, x, y, w, h) {
  const oc = new OffscreenCanvas(w, h);
  oc.getContext('2d').drawImage(bmp, x, y, w, h, 0, 0, w, h);
  const blob = await oc.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return 'data:image/png;base64,' + btoa(bin);
}

// The changed region with padding, clamped to the capture — a 1px crop is
// useless to look at.
const PAD = 12;
const changedBox = (cmp, bmp) => ({
  x: Math.max(0, cmp.minX - PAD),
  y: Math.max(0, cmp.minY - PAD),
  w: Math.min(bmp.width, cmp.maxX + PAD) - Math.max(0, cmp.minX - PAD),
  h: Math.min(bmp.height, cmp.maxY + PAD) - Math.max(0, cmp.minY - PAD),
});

// Changed-box capture px → viewport-relative CSS coords. measure and --crop
// both speak viewport-relative, and box.x is an offset into cap's bitmap
// whose page origin is cap.clip.x. For diff captures the pin follows the
// CURRENT viewport origin (clip.x === v.pageX, so the subtraction is 0);
// the plain-capture path still carries a real origin, so the formula stays.
const cssBox = (cap, box) => {
  const k = cap.s * cap.dpr; // capture px → CSS px
  return {
    x: Math.round(cap.clip.x - cap.v.pageX + box.x / k),
    y: Math.round(cap.clip.y - cap.v.pageY + box.y / k),
  };
};

// Remove the pill+viewport-frame banner for the duration of captures. It is
// page DOM at inset:0 (z-index max) and poisons captures three ways, all found
// live: the pill's elapsed-seconds label changes pixels every second (a
// wait --pixel-change on a marked static tab self-triggered from its own
// pill); the ACTIVE purple border renders as a phantom full-width band in
// captureBeyondViewport frames whose clip starts below the viewport top
// (crop/full/diff — a 1280×24 strip on a static page); and visibility:hidden
// does NOT keep it out of those frames (the wait fired with the banner
// 'hidden' — some cached/compositor path still paints it). Only DOM removal
// is invisible to every render path. Cost: the pill is absent while a shot
// runs (sub-second) and for the length of a pixel-change wait — favicon ⏳
// and the 🟣 tab group still show driven-ness; a pill that fabricates the
// very change being watched is worse.
// Tabs whose banner is currently removed for a capture window. The
// tabs.onUpdated re-banner hook fires status 'complete' ~0.5-1s after the
// debugger attaches (not just on loads — caught live via a page-side
// MutationObserver mid-wait --pixel-change) and would re-inject the banner
// straight into the diff frame, re-poisoning the very capture the removal
// was for. The hook checks this set.
const bannerSuppressed = new Set();
const removeBannerForCapture = async (tabId) => {
  bannerSuppressed.add(tabId); // BEFORE the removal — the onUpdated race is async
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const b = document.getElementById('bridge-banner');
        if (!b) return false;
        b.remove();
        return true;
      },
    });
    return !!r?.[0]?.result;
  } catch {
    return false; // chrome:// page etc. — no banner to worry about
  }
};
const restoreBanner = async (tabId, existed) => {
  // Re-inject only if the banner existed before the capture window AND the
  // tab is still driven: the ✕ promise ("hidden until the next navigation")
  // must survive a shot, a chrome:// tab never had one, and a release that
  // landed mid-capture (release takes no CDP lock; parallel agent calls are
  // a supported pattern) must stick — restoring onto a released tab
  // resurrects the pill with no cleanup path left (found by the flow review).
  // The suppression flag ALWAYS clears — a stuck flag would silence the
  // onUpdated re-banner forever after.
  if (existed && drivenTabs.has(tabId)) {
    await chrome.scripting.executeScript({ target: { tabId }, func: injectBanner }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, func: pillInject, args: [idleLabel(tabId), tabActivity.get(tabId) || [], null, false] }).catch(() => {});
  }
  bannerSuppressed.delete(tabId);
};

// Shared capture budget helpers — captureViewport and shot's --full/--crop
// paths must agree on dpr and the --max scale budget, one derivation each.
const dprOf = (m) => (m.visualViewport?.clientWidth && m.cssVisualViewport?.clientWidth ? m.visualViewport.clientWidth / m.cssVisualViewport.clientWidth : 1);
const maxOf = (msg) => {
  const n = Number(msg.max);
  return msg.max == null || Number.isNaN(n) ? 1280 : n === 0 ? Infinity : Math.abs(n);
};

// Whole-viewport capture shared by shot's viewport path and the pixel-diff
// machinery. Caller owns the debugger session (withCdp + attachDbg).
async function captureViewport(tabId, msg, reuseClip, forceClip) {
  const params = { format: msg.format === 'jpeg' ? 'jpeg' : 'png' };
  if (params.format === 'jpeg') params.quality = msg.quality ?? 80;
  const m = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
  const v = m.cssVisualViewport;
  const dpr = dprOf(m);
  const max = maxOf(msg);
  // Captures render at devicePixelRatio, so budget max/dpr CSS px to keep
  // the OUTPUT long edge <= max.
  const s = Math.min(msg.scale || 1, max / (Math.max(v.clientWidth, v.clientHeight) * dpr));
  // reuseClip: the --diff/--pixel-change machinery re-pins SIZE+SCALE and
  // re-captures the CURRENT viewport origin — agents scrollIntoView between
  // shots, so a page-absolute pin would diff off-screen pixels while the
  // visible page moved ("no change" on a 100%-changed viewport). The infobar
  // appearing/vanishing resizes the viewport, and the pinned size is what
  // covers that. forceClip: the diff machinery takes the clip path even at
  // s === 1, so the FIRST baseline renders in the same capture mode
  // (captureBeyondViewport) as every later pinned capture — a plain baseline
  // vs a beyond-viewport compare renders the scrollbar differently and
  // reports a phantom changed strip on a static page (found live: 30×407px
  // right-edge band, two consecutive --diff --max 0 calls, nothing moved).
  // The origin is ROUNDED to whole CSS px: it's the one unpinned input on
  // pinned re-captures, and its fractional part drifts when the debugger
  // infobar's visual-viewport offset settles (variable timing, 0.5-7s after
  // attach — found live: the flip re-AA'd a fixed header's dark-on-white
  // bottom edge, a 1280×1px row, and false-fired the wait; channel-sum
  // tolerance can't absorb a high-contrast edge). Whole-px origins keep
  // consecutive renders deterministic no matter when the settle lands.
  const ox = Math.round(v.pageX), oy = Math.round(v.pageY);
  const clip = reuseClip ? { ...reuseClip, x: ox, y: oy } : { x: ox, y: oy, width: v.clientWidth, height: v.clientHeight, scale: s };
  if (forceClip || reuseClip || s !== 1) {
    params.captureBeyondViewport = true;
    params.clip = clip;
  }
  // Remove the banner again RIGHT AT the capture: the markTab/banner
  // executeScripts are fire-and-forget and can land mid-capture (a first-ever
  // shot fires markTab from findTab and its injection queues behind grouping
  // round trips) — a caller's single removal at the start leaves a
  // several-round-trip window for the pill to sneak into the saved shot and
  // false-fire --diff. Enforcement at the capture is the only timing-proof
  // invariant (found live by the flow review; waitPixel used to do this at
  // every poll — now every capture does).
  await removeBannerForCapture(tabId);
  const res = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', params);
  return { b64: res.data, format: params.format, v, dpr, s: clip.scale, clip };
}

// --- trusted input (--trusted): CDP Input.dispatch* ---------------------------
// isTrusted=true events — the one thing synthetic dispatchEvent can't fake
// (canvas tools, Figma, browser defaults like Enter submitting a form).
// Opt-in: this path attaches the debugger, which the synthetic path never
// does (see the detectability gotcha) — the caller decides when a trusted
// event is worth the infobar.

// Page-side prep: resolve the target, scroll it into view, run the coverage
// preflight (click/drag), show the cursor, hand viewport coordinates back
// for CDP dispatch.
const trustedPointSrc = (target, coverage, ripple) => `(() => {
  ${DEEPQ}
  ${FRAME_SRC}
  const sel = ${JSON.stringify(target)};
  const el = mustQuery(sel);
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  ${coverage ? COVERAGE_SRC : ''}
  ${CURSOR_SRC}
  // CDP Input speaks TOP-viewport coords — a frame child's rect is its own
  // frame's viewport; without the hop --trusted clicks inside iframes land
  // at the wrong point
  const [cxTop, cyTop] = toTop(el, cx, cy);
  showCursor(cxTop, cyTop, ${ripple ? 'true' : 'false'});
  return JSON.stringify({ cx: Math.round(cxTop), cy: Math.round(cyTop), inBanner: !!el.closest('#bridge-banner') });
})()`;

// Page-side focus for press/type: the key events go to whatever holds focus.
const trustedFocusSrc = (target) => `(() => {
  ${DEEPQ}
  const sel = ${JSON.stringify(target || '')};
  const el = sel ? deepQuery(sel) : document.activeElement;
  if (sel) {
    if (!el) throw new Error(queryErr(sel));
    el.scrollIntoView({ block: 'center' });
    el.focus?.();
  }
  if (!el || !(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
    throw new Error('no text field focused — pass an @ref|css target or click the field first');
  return '<' + el.tagName.toLowerCase() + (el.isContentEditable ? ' contenteditable' : '') + '>';
})()`;

// SW-side CDP dispatch. Modifier combos keep press semantics: 'Control+k'
// sets the modifier bits on the k event, which is what app handlers match.
const CDP_KEYCODE = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Insert: 45, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32, Shift: 16, Control: 17, Alt: 18, Meta: 91, CapsLock: 20 };
async function cdpKeyEvent(tabId, keyIn) {
  const BITS = { alt: 1, control: 2, meta: 4, shift: 8 };
  const MODS = { Control: 'control', Ctrl: 'control', Shift: 'shift', Alt: 'alt', Meta: 'meta', Cmd: 'meta', Command: 'meta' };
  let key = keyIn;
  let bits = 0;
  if (keyIn.includes('+') && keyIn !== '+') {
    const parts = keyIn.split('+');
    key = parts.pop();
    for (const m of parts) {
      if (!MODS[m]) throw new Error('unknown modifier ' + JSON.stringify(m) + ' in ' + JSON.stringify(keyIn) + ' — use Control/Ctrl, Shift, Alt, Meta/Cmd');
      bits |= BITS[MODS[m]];
    }
  }
  const isChar = key.length === 1;
  // Same typo guard as the synthetic path — a keyCode-0 noop reads as success.
  if (!isChar && !CDP_KEYCODE[key]) throw new Error('unknown key ' + JSON.stringify(key) + ' — named keys: Enter, Tab, Escape, Backspace, Delete, Insert, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, or a single character (space = " ")');
  const vk = isChar ? (/[a-z]/i.test(key) ? key.toUpperCase().charCodeAt(0) : key.charCodeAt(0)) : CDP_KEYCODE[key] || 0;
  const base = {
    key,
    code: isChar ? (/[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : 'Digit' + key) : key,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers: bits,
  };
  // keyDown with `text` is what inserts the character (DevTools does the same).
  // With Ctrl/Meta held it is NOT text entry — it's an accelerator
  // (Cmd+V paste, Cmd+A select all): send rawKeyDown without text, or Chrome
  // treats it as modified typing and the command never fires (Cmd+V inserted
  // nothing). Alt-ONLY chords stay text entry: Option+letter is glyph entry
  // on macOS and Alt+letter a menu mnemonic on Windows — and the EDIT commands
  // below would fire destructively on them (Alt+x cutting the selection).
  const accel = isChar && (bits & (BITS.control | BITS.meta)) !== 0;
  if (accel) {
    // Accelerators need the MODIFIER KEYS themselves held, not just the bits
    // on the char event — Blink matches editing commands (paste, select all)
    // from the accumulated modifier state. Wrap the char event in real
    // modifier down/up events (Puppeteer does the same), and drop the char's
    // nativeVirtualKeyCode: vk is a WINDOWS keycode, and a wrong mac keycode
    // breaks the binding lookup.
    const MODKEYS = [];
    if (bits & BITS.meta) MODKEYS.push({ bit: BITS.meta, key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: CDP_KEYCODE.Meta, nativeVirtualKeyCode: 55 }); // 55 = kVK_Command
    if (bits & BITS.control) MODKEYS.push({ bit: BITS.control, key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: CDP_KEYCODE.Control, nativeVirtualKeyCode: 59 }); // kVK_Control
    if (bits & BITS.alt) MODKEYS.push({ bit: BITS.alt, key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: CDP_KEYCODE.Alt, nativeVirtualKeyCode: 58 }); // kVK_Option
    // Modifier state accumulates like a physical keyboard — each down adds its
    // bit, each up drops it. Claiming every bit on every event hands the page
    // modifier states no keyboard produces (altKey set on the Meta keydown).
    let held = 0;
    for (const { bit, ...ev } of MODKEYS) await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { ...ev, modifiers: (held |= bit), type: 'rawKeyDown' });
    const { nativeVirtualKeyCode, ...noNative } = base;
    // Modifier events alone still don't fire Blink's editing commands — name
    // the command explicitly via CDP's `commands` field (Chrome ≥ 94). Never
    // with Alt held (Ctrl+Alt = AltGr text entry on Windows): no platform
    // binds Alt+letter to these edits.
    const EDIT = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: bits & BITS.shift ? 'redo' : 'undo' };
    const editCmd = bits & BITS.alt ? undefined : EDIT[key.toLowerCase()];
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { ...noNative, type: 'rawKeyDown', ...(editCmd ? { commands: [editCmd] } : {}) });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { ...noNative, type: 'keyUp' });
    for (const { bit, ...ev } of MODKEYS.reverse()) await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { ...ev, modifiers: (held &= ~bit), type: 'keyUp' });
    return;
  }
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { ...base, type: 'keyDown', ...(isChar ? { text: key, unmodifiedText: key } : {}) });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

async function cdpMouseClick(tabId, x, y, dbl) {
  const pair = async (count) => {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: count });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: count });
  };
  await pair(1);
  if (dbl) await pair(2);
}

// Trusted drag: pressed → interpolated moves (buttons held) → released. Real
// pointer input, so legacy HTML5 dragstart/drop fire too — the synthetic
// drag never did (constructed DataTransfer stayed an eval recipe).
async function cdpDrag(tabId, x1, y1, x2, y2) {
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i++) {
    const x = Math.round(x1 + ((x2 - x1) * i) / 8), y = Math.round(y1 + ((y2 - y1) * i) / 8);
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
  }
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
}

async function trustedInput(tab, msg) {
  const point = (target, coverage, ripple) => runEval(tab.id, trustedPointSrc(target, coverage, ripple)).then((s) => JSON.parse(s));
  let res;
  // First-ever command on a fresh tab: let the in-flight auto-mark land
  // BEFORE the suppression window below, or its injectBanner can arrive
  // mid-dispatch and put the pill back under the coords.
  await awaitMark(tab.id);
  await withCdp(tab.id, async () => {
    await attachDbg(tab.id);
    // CDP input hits whatever is topmost at the coords, and the pill is
    // pointer-events:auto with live ✕/⏏ — a trusted click landing on it can
    // self-release the tab behind a false 'clicked' success (the coverage
    // preflight exempts #bridge-banner, so it would not warn). So: resolve
    // the target FIRST, then suppress the banner between resolution and
    // dispatch — unless the target IS inside the pill (clicking ⏏/✕ is a
    // legitimate escape hatch; removing the banner would remove the target
    // mid-command — the stress suite drives exactly that click). Keyboard
    // paths (press/type) have no coords — no suppression needed.
    // null = window never opened (inBanner target). Otherwise
    // removeBannerForCapture's return — and it sets bannerSuppressed
    // UNCONDITIONALLY, so restoreBanner (the only clearer of that flag) must
    // run whenever the window opened, even when no banner existed: skipping
    // it on a ✕-hidden tab wedges the flag and kills the pill for the tab's
    // lifetime (found by the verify fleet).
    let suppression = null;
    try {
      if (msg.type === 'click') {
        const p = await point(msg.target, true, true);
        if (!p.inBanner) suppression = await removeBannerForCapture(tab.id);
        await cdpMouseClick(tab.id, p.cx, p.cy, msg.dbl);
        res = `clicked ${msg.target} (trusted${msg.dbl ? ', double' : ''})`;
      } else if (msg.type === 'hover') {
        const p = await point(msg.target, false, false);
        if (!p.inBanner) suppression = await removeBannerForCapture(tab.id);
        await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.cx, y: p.cy });
        res = `hovered ${msg.target} (trusted)`;
      } else if (msg.type === 'drag') {
        const p1 = await point(msg.from, true, false);
        const p2 = await point(msg.to, false, false);
        if (!p1.inBanner && !p2.inBanner) suppression = await removeBannerForCapture(tab.id);
        await cdpDrag(tab.id, p1.cx, p1.cy, p2.cx, p2.cy);
        res = `dragged ${msg.from} onto ${msg.to} (trusted)`;
      } else if (msg.type === 'press') {
        const what = await runEval(tab.id, trustedFocusSrc(msg.target));
        await cdpKeyEvent(tab.id, msg.key);
        res = `pressed ${msg.key} on ${what} (trusted)`;
      } else if (msg.type === 'type') {
        const what = await runEval(tab.id, trustedFocusSrc(msg.target));
        const delay = Math.min(25, 15000 / (msg.value.length || 1));
        for (const ch of msg.value) {
          await cdpKeyEvent(tab.id, ch);
          await new Promise((r) => setTimeout(r, delay));
        }
        res = `typed ${msg.value.length} chars into ${what} (trusted)`;
      }
    } finally {
      if (suppression !== null) await restoreBanner(tab.id, suppression);
      await detachDbg(tab.id);
    }
  });
  return res;
}

// Key press on the focused element (or a target). Synthetic keys are untrusted:
// they reach JS listeners but don't trigger browser defaults (form submit).
// Modifier combos: 'Control+k' splits into ctrlKey + key 'k' — 'press Control+k'
// dispatches key='k' with the flag set, which is what app handlers match.
const pressSrc = (keyIn, target) => `(() => {
  ${DEEPQ}
  const sel = ${JSON.stringify(target || '')}, keyIn = ${JSON.stringify(keyIn)};
  let el = document.activeElement || document.body;
  if (sel) {
    el = mustQuery(sel);
    el.focus?.();
  }
  const MODS = { Control:'ctrlKey', Ctrl:'ctrlKey', Shift:'shiftKey', Alt:'altKey', Meta:'metaKey', Cmd:'metaKey', Command:'metaKey' };
  const o = { bubbles: true, cancelable: true, composed: true };
  let key = keyIn;
  if (keyIn.includes('+') && keyIn !== '+') {
    const parts = keyIn.split('+');
    key = parts.pop();
    for (const m of parts) if (!MODS[m]) throw new Error('unknown modifier ' + JSON.stringify(m) + ' in ' + JSON.stringify(keyIn) + ' — use Control/Ctrl, Shift, Alt, Meta/Cmd');
    for (const m of parts) o[MODS[m]] = true;
  }
  o.key = key;
  o.code = key.length === 1 ? (/[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : 'Digit' + key) : key;
  // Legacy listeners (old jQuery keymaps etc.) read e.which/e.keyCode — the
  // constructor leaves them 0. Chrome derives which from keyCode in the dict;
  // on keypress, which is the charCode.
  const KEYCODE = { Enter:13, Tab:9, Escape:27, Backspace:8, Delete:46, Insert:45, ArrowUp:38, ArrowDown:40, ArrowLeft:37, ArrowRight:39, Home:36, End:35, PageUp:33, PageDown:34, ' ':32, Shift:16, Control:17, Alt:18, Meta:91, CapsLock:20 };
  // A typoed key name ('Entr') would dispatch a keyCode-0 noop and read as
  // success — fail loud, the error doubles as the accepted-keys list.
  if (key.length > 1 && !KEYCODE[key]) throw new Error('unknown key ' + JSON.stringify(key) + ' — named keys: Enter, Tab, Escape, Backspace, Delete, Insert, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, or a single character (space = " ")');
  o.keyCode = key.length === 1 ? (/[a-z]/i.test(key) ? key.toUpperCase().charCodeAt(0) : key.charCodeAt(0)) : (KEYCODE[key] || 0);
  el.dispatchEvent(new KeyboardEvent('keydown', o));
  el.dispatchEvent(new KeyboardEvent('keypress', { ...o, charCode: key.length === 1 ? key.charCodeAt(0) : 0 }));
  el.dispatchEvent(new KeyboardEvent('keyup', o));
  return 'pressed ' + keyIn + ' on <' + el.tagName.toLowerCase() + '>';
})()`;

const hoverSrc = (target) => `(() => {
  ${DEEPQ}
  ${FRAME_SRC}
  const sel = ${JSON.stringify(target)};
  const el = mustQuery(sel);
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  ${CURSOR_SRC}
  showCursor(...toTop(el, r.left + r.width / 2, r.top + r.height / 2), false);
  const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new PointerEvent('pointerover', o));
  el.dispatchEvent(new MouseEvent('mouseover', o));
  el.dispatchEvent(new MouseEvent('mouseenter', { ...o, bubbles: false }));
  return 'hovered ' + sel;
})()`;

// Drag one element onto another: a real pointerdown, interpolated pointermove
// steps dispatched on the element under the pointer (dnd-kit/Sortable hit-test
// that way), pointerup at the destination. Synthetic — legacy HTML5 DnD needs
// a constructed DataTransfer (an eval recipe), and isTrusted-checking apps
// (canvas tools) ignore this entirely.
const dragSrc = (from, to) => `(async () => {
  ${DEEPQ}
  ${FRAME_SRC}
  const sel = ${JSON.stringify(from)}, sel2 = ${JSON.stringify(to)};
  const el = mustQuery(sel);
  const el2 = mustQuery(sel2);
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el2.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect(), r2 = el2.getBoundingClientRect();
  // frame-relative centers → top-document coords, so the interpolated path,
  // the cursor and the move targets are all in one coordinate system
  const [x1, y1] = toTop(el, r.left + r.width / 2, r.top + r.height / 2);
  const [x2, y2] = toTop(el2, r2.left + r2.width / 2, r2.top + r2.height / 2);
  ${CURSOR_SRC}
  showCursor(x1, y1, false);
  const mk = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, clientX: x, clientY: y });
  el.dispatchEvent(mk('pointerdown', x1, y1));
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x1, clientY: y1 }));
  for (let i = 1; i <= 8; i++) {
    const x = x1 + ((x2 - x1) * i) / 8, y = y1 + ((y2 - y1) * i) / 8;
    showCursor(x, y, false);
    // pierceFromPoint: a path across an iframe must move inside the frame
    // (its own listeners), not stop at the <iframe> element in the top doc
    pierceFromPoint(x, y)?.dispatchEvent(mk('pointermove', x, y));
    await new Promise((res) => setTimeout(res, 16));
  }
  // a cross-document drop goes to the element the agent named — the top doc's
  // elementFromPoint can't reach inside the frame
  const dst = el2.ownerDocument === document ? (document.elementFromPoint(x2, y2) || el2) : el2;
  dst.dispatchEvent(mk('pointerup', x2, y2));
  dst.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x2, clientY: y2 }));
  return 'dragged ' + sel + ' onto ' + sel2;
})()`;

// Instant (not CSS-smooth) scrolling, so the position readback is true even on
// pages with scroll-behavior: smooth. up/down page by 85% of the scroller.
// App shells (Linear, Gmail) scroll an inner panel, not the window — when the
// document itself can't move, scroll the tallest visible overflow panel instead.
const scrollSrc = (what) => `(() => {
  ${DEEPQ}
  const what = ${JSON.stringify(what)};
  const o = { behavior: 'instant' };
  if (!['top', 'bottom', 'up', 'down'].includes(what)) {
    const el = mustQuery(what);
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
  ${DEEPQ}
  const sel = ${JSON.stringify(selector || null)}, text = ${JSON.stringify(text || null)}, timeout = ${Number(timeout) || 10000};
  const t0 = Date.now();
  const check = () => {
    if (sel) {
      const el = deepQuery(sel);
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
  // The bridge's own UI mutates the DOM on a schedule (pill ticker every 5s,
  // cursor ripple, grid) — a settle that counts it can never reach 100ms of
  // quiet on a driven tab and every --diff observation eats the full 3s cap.
  const BRIDGE_SEL = '#bridge-banner, #bridge-grid, #bridge-cursor, link[data-bridge-made]';
  const inBridge = (n) => {
    const el = n.nodeType === 1 ? n : n.parentElement; // characterData mutations target text nodes
    return !!el?.closest?.(BRIDGE_SEL);
  };
  const t0 = Date.now();
  await new Promise((resolve) => {
    const done = () => { try { mo.disconnect(); } catch {} clearTimeout(t); clearInterval(iv); resolve(); };
    let t = null;
    const mo = new MutationObserver((muts) => {
      if (Date.now() - t0 >= 3000) return done();
      if (muts.some((m) => !inBridge(m.target) || [...m.addedNodes, ...m.removedNodes].some((n) => !inBridge(n)))) {
        clearTimeout(t);
        t = setTimeout(done, 100);
      }
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
const NANO_GUARD = `if (typeof LanguageModel === 'undefined') throw new Error('no Prompt API in this Chrome (needs 138+) — developer.chrome.com/docs/ai/get-started');
  const avail = await LanguageModel.availability();
  if (avail !== 'available') throw new Error('Gemini Nano not ready (availability: ' + avail + ') — the first LanguageModel.create() downloads it (~2GB), then ask works');`;

const askSrc = (question) => `(async () => {
  ${NANO_GUARD}
  const text = (${PAGE_TEXT}).replace(/\\s+/g, ' ').trim().slice(0, 3000);
  const session = await LanguageModel.create();
  try {
    return await session.prompt('Answer from this page text. Page ' + location.href + ':\\n' + text + '\\n\\nQuestion: ' + ${JSON.stringify(question)});
  } finally {
    session.destroy();
  }
})()`;

// Nano over text the service worker already holds (console logs) — the page
// only lends its LanguageModel; the content rides in as a string literal.
const nanoSrc = (context, question) => `(async () => {
  ${NANO_GUARD}
  const session = await LanguageModel.create();
  try {
    return await session.prompt(${JSON.stringify(context + '\n\nQuestion: ' + question)});
  } finally {
    session.destroy();
  }
})()`;

// In-page fetch riding the logged-in session: the request runs in the page
// (credentials: include), so the cookies ride it. Body capped at 512KB — a
// bigger body belongs in --out, and an unbounded one would ride the WS frame
// regardless. Binary comes back base64 (a JS string can't hold the bytes
// honestly); the CLI decodes it into --out.
const fetchSrc = (url) => `(async () => {
  const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
  const ct = res.headers.get('content-type') || '';
  if (!/text|json|xml|javascript|csv/i.test(ct)) {
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { status: res.status, ct, binary: true, body: btoa(bin).slice(0, 700_000), truncated: buf.length > ${BODY_CAP} };
  }
  const body = await res.text();
  return { status: res.status, ct, binary: false, body: body.slice(0, ${BODY_CAP}), truncated: body.length > ${BODY_CAP} };
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
          // e.message, not String(e): String(Error) re-includes 'Error:', so
          // wait timeouts read 'async: Error: timeout after…' (stress-finding)
          (e) => ({ ok: false, error: `async: ${e?.message || String(e)}` })
        );
      }
      return { ok: true, value: value === undefined ? null : value };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  };
  const run = async (w) => {
    try {
      return await chrome.scripting.executeScript({
        target: { tabId },
        world: w,
        func: injected,
        args: [code],
      });
    } catch (e) {
      // After a debugger session dies EXTERNALLY (infobar cancel, DevTools
      // opening, a debugger-hostile page like console.cloud.google.com),
      // Chrome leaves the tab reporting its http(s) URL while injection fails
      // as if the document were another extension's page — every command then
      // dies with Chrome's misleading error until a reload. Name it and the
      // remedy instead. A tab genuinely ON another extension's page keeps the
      // original error (its URL is chrome-extension://).
      if (/Cannot access a chrome-extension:\/\/ URL/.test(String(e))) {
        const url = (await chrome.tabs.get(tabId).catch(() => null))?.url || '';
        if (/^https?:/.test(url))
          throw new Error('tab wedged after an external debugger detach — reload it (nav <match> <its url>) and retry');
      }
      throw e;
    }
  };

  // Cached world first; on CSP failure fall through to the full ladder.
  const worlds = world === 'auto' ? [...new Set([worldCache.get(tabId), 'ISOLATED', 'MAIN'])] : [world];
  for (const w of worlds) {
    if (!w) continue;
    const r = (await run(w))?.[0]?.result;
    // Anchored: CSP refusal is always a sync 'EvalError: Refused to evaluate…' —
    // a bare /eval/ would re-run user code whose own error message mentions 'eval'.
    if (r && r.ok === false && r.error.startsWith('EvalError:')) continue; // CSP — try next
    if (!r) throw new Error('no injection result');
    if (r.ok === false) throw new Error(r.error);
    if (world === 'auto') worldCache.set(tabId, w);
    return r.value;
  }

  // Page CSP blocks eval() in both scripting worlds; CDP Runtime.evaluate is exempt.
  // CDP runs in the page's MAIN world — fine for 'auto'/'MAIN', but a caller who
  // asked for ISOLATED must not silently get page-context execution.
  if (world === 'ISOLATED') throw new Error('ISOLATED world blocked by page CSP — refusing CDP fallback (it would run in the main world)');
  await attachDbg(tabId);
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
    await detachDbg(tabId);
  }
}

// --- --diff on actions: observe in the same round trip ----------------------
// The core agent loop collapses from click → wait → snap --diff (3 shell
// calls, ~1s harness round trip each) to `click <match> @e3 --diff` (1 call):
// settle, then diff-snap, appended to the action result. playwright-mcp and
// BrowserMCP return a post-action snapshot with every action for the same
// reason; a diff costs fewer tokens than the full snap it replaces.
async function observeDiff(tabId, actionResult, url0) {
  try {
    const url = () => chrome.tabs.get(tabId).then((t) => t.url).catch(() => null);
    // Navigation verdict: an executeScript on an uncommitted navigation pends
    // FOREVER (open()'s lesson) — wait for the load, then read the NEW page.
    const navVerdict = async (u1) => {
      await waitForLoad(tabId, 8000, true);
      const wall = await runEval(tabId, WALL_SRC).catch(() => ({}));
      if (wall.captcha) return `needs_human · ${actionResult} — bot wall: ${wall.captcha} — hand off: wait <match> --human`;
      if (wall.block) return `blocked · ${actionResult} — ${wall.block}`;
      if (wall.login) return `needs_human · ${actionResult} — login/2FA wall — hand off: wait <match> --human`;
      const snap = await runEval(tabId, SNAP_SRC(null, false, false));
      return `succeeded · ${actionResult} — navigated to ${u1.slice(0, 60)} — fresh snap (refs are new):\n${snap}`;
    };
    let url1 = await url();
    if (url1 && url0 && url1 !== url0) return await navVerdict(url1);
    // Bound the settle: a click that starts a navigation mid-settle leaves the
    // eval pending on the dying document — race it, then re-check the URL.
    // 4s: the settle itself caps at 3s, so anything past that is a pend.
    await Promise.race([runEval(tabId, SETTLE_SRC).catch(() => null), new Promise((r) => setTimeout(r, 4_000))]);
    url1 = await url();
    if (url1 && url0 && url1 !== url0) return await navVerdict(url1);
    const wall = await runEval(tabId, WALL_SRC);
    const snap = await runEval(tabId, SNAP_SRC(null, true, false));
    // Verdict (neobrowser VERIFIED-ACTIONS style): the first word of the
    // result. Order matters — a wall overrides anything the diff says, and
    // uncertain is never promoted to succeeded: a bare return must never be
    // readable as "ok".
    let status, why;
    if (wall.captcha) {
      status = 'needs_human';
      why = 'bot wall: ' + wall.captcha + ' — hand off: wait <match> --human';
    } else if (wall.block) {
      status = 'blocked';
      why = wall.block;
    } else if (/^\(no changes since last snap\)/.test(snap)) {
      status = 'uncertain';
      why = 'no observable change after the action — the event dispatched; verify via console/net/shot, or act again with a different target';
    } else {
      status = 'succeeded';
    }
    return `${status} · ${actionResult}${why ? ' — ' + why : ''}${status === 'uncertain' || /^\(no changes since last snap\)/.test(snap) ? '' : '\n' + snap}`;
  } catch (e) {
    // The action worked; only the observation failed. Don't turn a success
    // into an error — but never claim the verdict either.
    return 'uncertain · ' + actionResult + ' — observation unavailable: ' + String(e).slice(0, 120) + ' — re-snap; refs expired on navigation';
  }
}

// --diff sequences (baseline snap → act → observe) share the in-page snap
// store (window.__bridgeSnapLines) with every other snap on the tab — a plain
// snap (or a second --diff action) landing between baseline and observe
// rewrites the store, and the action diffs against the WRONG baseline: false
// 'uncertain', or A's effects showing in B's diff (stress-review finding).
// The snap family serializes per tab; non-snap commands keep full parallelism.
const snapQ = new Map(); // tabId -> chain (self-pruning, groupChain-style)
function withSnap(tabId, fn) {
  const run = (snapQ.get(tabId) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  snapQ.set(tabId, tail);
  tail.then(() => snapQ.get(tabId) === tail && snapQ.delete(tabId));
  return run;
}

// --diff actions run baseline → act → observe: the diff then reads exactly the
// ACTION's effects. It used to diff against "whatever the agent last snapped"
// — click A, then click B --diff showed A's effects in B's diff, and with no
// prior snap it returned a full tree labeled as a diff.
async function actAndVerify(tabId, msg, run) {
  if (!msg.diff) return await run();
  return await withSnap(tabId, async () => {
    const url0 = (await chrome.tabs.get(tabId)).url;
    await runEval(tabId, SNAP_SRC(null, false, false)); // pre-action baseline
    const result = await run();
    return await observeDiff(tabId, result, url0);
  });
}

// Bounded wait for a tab to reach status 'complete' — nav/open then read as
// loaded instead of the agent paying a separate `wait` round trip (playwright
// caps goto the same way). 8s ceiling; `loaded: false` means still loading.
function waitForLoad(tabId, timeout = 8000, recheck = false) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpd); resolve(false); }, timeout);
    const onUpd = (tid, info) => {
      if (tid !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpd);
      resolve(true);
    };
    chrome.tabs.onUpdated.addListener(onUpd);
    // open(): a fresh tab can commit before this listener attaches (about:blank,
    // cached data:/file: URLs) — re-check status so the event isn't missed and
    // paid for with the full 8s timeout. Never for nav: there the tab's OLD
    // page is already complete, so a pre-nav recheck would resolve instantly.
    if (recheck) chrome.tabs.get(tabId).then((t) => onUpd(tabId, { status: t.status })).catch(() => {});
  });
}

// --- wait --human: hand the tab to the human, watch what they do -------------
// CAPTCHA/2FA/login walls are THE failure mode of real-logged-in automation:
// synthetic events can't answer them (and shouldn't — the human's password
// belongs to the human). The command blocks in the SERVICE WORKER, not an
// in-page promise: a login navigation tears the page down mid-await, and
// navigation is exactly one of the things being waited for. Completion is
// trusted input — e.isTrusted on a listener armed in the ISOLATED world
// (page JS can forge neither the event nor the flag) — or the tab navigating.
async function waitHuman(tab, msg) {
  const timeout = msg.timeout || 120_000;
  const t0 = Date.now();
  const url0 = tab.url;
  // Baseline snap for the after-diff (a full snap stores the lines the --diff
  // pass reads back; both sides go through runEval, so the world matches).
  await runEval(tab.id, SNAP_SRC(null, false, false));
  // Arm the trusted-input flag: dedicated func injection (not the eval ladder
  // — page CSP can't block a scripting-API func) into the ISOLATED world.
  await chrome.scripting
    .executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: () => {
        window.__bridgeHumanActed = false; // every handoff re-arms — a repeat wait on the same page must not auto-pass on the previous one's flag
        if (window.__bridgeHumanArmed) return;
        window.__bridgeHumanArmed = true;
        const mark = (e) => {
          if (e.isTrusted) window.__bridgeHumanActed = true;
        };
        for (const t of ['pointerdown', 'keydown', 'wheel']) addEventListener(t, mark, { capture: true, passive: true });
      },
    })
    .catch(() => {}); // injection failed (chrome:// page) — navigation is still a signal
  const how = await new Promise((resolve) => {
    const iv = setInterval(async () => {
      try {
        const t = await chrome.tabs.get(tab.id);
        if (t.url !== url0) { clearInterval(iv); resolve('nav'); return; }
        const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => !!window.__bridgeHumanActed });
        if (r?.[0]?.result) { clearInterval(iv); resolve('input'); return; }
      } catch {
        // The tick's executeScript pends across a just-started navigation and
        // rejects when the old frame dies ('frame removed') — that IS the human
        // acting (a login redirect), not a closed tab. Re-check before 'gone'.
        const t = await chrome.tabs.get(tab.id).catch(() => null);
        if (!t) {
          clearInterval(iv);
          resolve('gone'); // tab really closed mid-handoff
          return;
        }
        if (t.url !== url0) {
          clearInterval(iv);
          resolve('nav');
          return;
        }
        // Same URL, transient injection failure — the next tick decides.
      }
      if (Date.now() - t0 >= timeout) { clearInterval(iv); resolve('timeout'); }
    }, 1000);
  });
  if (how === 'timeout') throw new Error('timeout after ' + timeout + 'ms — the human did not act in this tab; nudge them (note <match> …) or re-run with a longer --timeout');
  if (how === 'gone') throw new Error('the tab was closed while waiting for the human');
  // A login usually navigates: the whole page (and every ref, and the diff
  // baseline) died with the old document. Fresh full snap instead of a diff.
  if (how === 'nav' || (await chrome.tabs.get(tab.id).catch(() => null))?.url !== url0) {
    await waitForLoad(tab.id, 8000, true);
    const snap = await runEval(tab.id, SNAP_SRC(null, false, false));
    return 'the human navigated to ' + (await chrome.tabs.get(tab.id)).url + ' — fresh snap (refs are new):\n' + snap;
  }
  // In-page action (checkbox, puzzle): settle, then diff against the baseline.
  await runEval(tab.id, SETTLE_SRC);
  return 'the human acted:\n' + (await runEval(tab.id, SNAP_SRC(null, true, false)));
}

// wait --pixel-change: the canvas watcher — polls the viewport until pixels
// move (the a11y tree can't see canvas; bklapholz's salesforce pilot watched
// at 1 FPS for exactly this). Attaches CDP for the duration (infobar +
// detectability gotcha). Text-only result: the region is reported, shot
// --crop shows it — wait stays image-free.
async function waitPixel(tab, msg) {
  const timeout = msg.timeout || 10000;
  // First-ever command on a fresh tab: the auto-mark's injectBanner must land
  // BEFORE the suppression window — else it can paint the pill into the
  // baseline frame (every banner-free poll then diffs nonzero against it: a
  // static page self-fires) or flicker against each poll's at-capture removal.
  await awaitMark(tab.id);
  const t0 = Date.now(); // after the mark await: a slow first mark must not burn the watch budget
  return await withCdp(tab.id, async () => {
    await attachDbg(tab.id);
    // PLAIN native captures, not the pinned clip: captureBeyondViewport
    // renders are not pixel-stable on background windows (found live — the
    // AA of a fixed header's edge flipped once, persistently, 0.9-7.1s after
    // attach, surviving origin-rounding, settling, and confirmation). The
    // live-compositor plain path is byte-stable (verified: 5 captures, 1s
    // apart, identical md5). A viewport resize mid-wait — the thing the clip
    // pin was invented for — is handled as re-baseline-and-continue below.
    const pngMsg = { ...msg, format: 'png', max: 0 };
    const bannered = await removeBannerForCapture(tab.id); // the pill ticks pixels — keep it out of the baseline AND the polls
    let bmp0 = null;
    try {
      const cap0 = await captureViewport(tab.id, pngMsg);
      // Decode the baseline ONCE — re-decoding a multi-MB png every 800ms poll
      // was pure waste (found by review).
      bmp0 = await pngBitmap(cap0.b64);
      for (;;) {
        if (Date.now() - t0 >= timeout) throw new Error('timeout after ' + timeout + 'ms — no pixel change detected');
        await new Promise((r) => setTimeout(r, 800));
        // Plain capture: the frame is whatever the viewport is NOW — scroll
        // and resize follow natively, no pin to maintain. (No manual banner
        // removal here: captureViewport removes at the capture itself.)
        const cap = await captureViewport(tab.id, pngMsg);
        const cmp = await diffBmp(bmp0, await pngBitmap(cap.b64));
        if (cmp.error) {
          // Viewport resized mid-wait (window resize / infobar settle where
          // Chrome resizes): a diff across geometries is meaningless — adopt
          // the new frame as baseline and keep watching, instead of dying
          // the way the old pinned path did.
          bmp0.close();
          bmp0 = await pngBitmap(cap.b64);
          continue;
        }
        if (cmp.changed) {
          // Confirm before firing: background-window raster state is not
          // pixel-stable over time — a focus/occlusion change re-AA's
          // high-contrast edges ONCE (found live: a fixed header's 1px
          // bottom edge, 1280px row, 0.2% false fire — and whole-px clip
          // origins did NOT prevent it). A real change persists; a transient
          // raster flip is gone by the next capture. One confirmation
          // capture (~200ms) instead of chasing render determinism.
          const cap2 = await captureViewport(tab.id, pngMsg);
          const cmp2 = await diffBmp(bmp0, await pngBitmap(cap2.b64));
          if (!cmp2.error && !cmp2.changed) {
            cmp2.bmp.close();
            cmp.bmp.close();
            continue; // transient render flip — keep watching
          }
          if (cmp2.changed) cmp2.bmp.close(); // confirmed; region reported from the first detection
          const box = changedBox(cmp, cmp.bmp);
          const { x: cssX, y: cssY } = cssBox(cap, box);
          const k = cap.s * cap.dpr; // capture px → CSS px
          cmp.bmp.close();
          return `pixels changed after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${cmp.pct}% of the viewport — region ${box.w}×${box.h}px at CSS x=${cssX}, y=${cssY} (see it: shot <match> out.png --crop ${cssX},${cssY},${Math.max(1, Math.round(box.w / k))},${Math.max(1, Math.round(box.h / k))})`;
        }
        cmp.bmp.close();
      }
    } finally {
      bmp0?.close();
      await restoreBanner(tab.id, bannered);
      await detachDbg(tab.id);
    }
  });
}

// --- Commands ---------------------------------------------------------------

// Commands that act as the user or run code in the page. Auto-MARKING is no
// longer this set's job — findTab marks on every command it resolves, reads
// included (owner's call: the pill shows on any tab the agent looks at, not
// just the ones it changes). What the set still decides (onmessage): a
// successful MUTATING command clears the pill's "failed since last ok"
// counter — a read must not (a failed click followed by a passing snap is
// still a failure the human needs to see). fetch is in the set for the same
// reason it used to auto-mark: it issues a request in the user's name (a GET
// can be a mutation on some servers).
// Adding a command? SEVEN registries stay in sync (a missing one fails SILENTLY):
// cli.mjs USAGE · cli.mjs run() · server.mjs CLI_LINES · server.mjs route() (only if it
// needs special routing) · background.js handle() · ACT_VERBS (pill narration) · MUTATING.
const MUTATING = new Set(['click', 'fill', 'paste', 'type', 'press', 'upload', 'eval', 'hover', 'scroll', 'grid', 'emulate', 'resize', 'drag', 'dialog', 'fetch']);

// <match> is a URL/title substring — or id:<tabId>, the exact reference the
// toolbar popup copies (also shown in tabs/open output). ONE predicate for
// findTab / probe / close --all — the three copies this replaced had to be
// kept in sync by comment.
const tabMatches = (t, m) => {
  const id = /^id:(\d+)$/.exec(m || '');
  return id ? t.id === Number(id[1]) : (t.url || '').includes(m) || (t.title || '').includes(m);
};

// Takes the whole msg: records _tabId so the onmessage finally can flip a
// driven tab's favicon to ✅, and marks a driven tab busy (⏳) for the command
// about to run. `open` sets msg._tabId itself — it creates rather than finds.
async function findTab(msg) {
  // A flag where <match> belongs can never match a URL — say so instead of
  // 'no tab matching "--max"'. One guard here covers every command.
  if (msg.urlMatch?.startsWith('--')) throw new Error(`"${msg.urlMatch}" is a flag, not a tab match — <match> goes first (check the command's usage)`);
  const tabs = await chrome.tabs.query({});
  // URL or title substring (or an exact id:<tabId> reference) — the same
  // predicate `cli tabs <match>` filters with, so the list the agent picked
  // from and the resolver never disagree.
  const matches = tabs.filter((t) => tabMatches(t, msg.urlMatch));
  if (!matches.length) {
    if (/^id:\d+$/.test(msg.urlMatch || ''))
      throw new Error(`no tab with ${msg.urlMatch} — tab ids die on browser restart and change on prerender; re-copy it from the toolbar popup`);
    throw new Error(`no tab matching "${msg.urlMatch}" — the tab may have navigated (the match is a URL/title substring); run tabs to re-find it`);
  }
  // Never choose one tab from an ambiguous substring match. The old
  // driven-then-most-recently-active tie-breaker was only a heuristic: a
  // newly opened lookalike, a navigation race, or stale lastAccessed metadata
  // could make a normal command act on the wrong tab before its warning was
  // returned. Refuse before marking, recording activity, or dispatching any
  // page/CDP operation; the caller must provide a narrower match.
  if (matches.length > 1) {
    const host = (t) => {
      try {
        const u = new URL(t.url);
        // file:// (and friends) parse fine but have an EMPTY host — the
        // warning used to read 'acting on ; also matched: .'. Name the
        // last path segment instead (stress: two file:// tabs).
        return u.host || u.pathname.split('/').pop() || String(t.url).slice(0, 40);
      } catch {
        return String(t.url).slice(0, 40);
      }
    };
    throw new Error(
      `⚠ ${matches.length} tabs match "${msg.urlMatch}" — refusing to choose one; matched: ` +
        matches.slice(0, 4).map(host).join(', ') +
        (matches.length > 4 ? ` (+${matches.length - 4} more)` : '') +
        '. Re-run with a longer <match>.'
    );
  }
  msg._tabId = matches[0].id;
  // Every command resolving here marks the tab, reads included (owner's
  // call: the pill must show on any tab the agent is LOOKING at, not just
  // the ones it changes — a read-only session used to leave the browser
  // looking untouched). Cleanup exceptions: release (removing the pill is
  // its whole job), mark (explicit), unemulate (only meaningful on an
  // already-driven tab). Fire-and-forget like open(): the banner injection
  // can hang on an uncommitted navigation, and drivenTabs updates
  // synchronously, so the block below already sees the tab as driven. The
  // mark is tracked per-tab in markInflight — handlers that must not beat
  // the banner in (note's probe; shot / wait --pixel-change / trusted
  // input's suppression windows) awaitMark() it, which also sees a SIBLING
  // command's mark that a per-message handle would miss.
  if (!['release', 'mark', 'unemulate'].includes(msg.type) && !drivenTabs.has(matches[0].id)) markTab(matches[0].id).catch(() => {});
  // Not `release`: it would flash ⏳ on the still-driven tab right before
  // releaseTab restores the site's own favicon. Fire-and-forget for the same
  // uncommitted-nav reason as open() — an awaited executeScript there can
  // pend forever and eat the whole command timeout.
  if (msg.type !== 'release' && drivenTabs.has(matches[0].id)) {
    setFavicon(matches[0].id, '⏳').catch(() => {});
    recordActivity(matches[0].id, msg);
  }
  return matches[0];
}

async function cmdFetch(tab, msg) {
  // In-page fetch first — the page's session rides it. A page CSP
  // (connect-src) or a cross-origin CORS refusal falls back to the
  // browser-network read: Network.loadNetworkResource fetches outside the
  // page's JS walls with the profile's credentials — the same wall
  // net --body reads bodies through. Shape handled defensively; a Chrome
  // version that answers differently fails loudly here, not silently.
  try {
    return await runEval(tab.id, fetchSrc(msg.url));
  } catch (e) {
    const read = await withCdp(tab.id, async () => {
      await attachDbg(tab.id);
      try {
        // Chrome 152 tightened loadNetworkResource: options.disableCache is
        // mandatory AND frameId must be provided (stress: the fallback died
        // on both — 'Failed to deserialize options.disableCache', then
        // 'Parameter frameId must be provided for frame targets').
        const tree = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.getFrameTree');
        const frameId = tree?.frameTree?.frame?.id;
        const out = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.loadNetworkResource', { url: msg.url, frameId, options: { includeCredentials: true, disableCache: false } });
        const rec = out?.resource || {};
        if (!rec.success)
          throw new Error('browser-network read failed (' + (rec.netErrorName || rec.netError || 'unknown') + ') — in-page fetch said: ' + String(e).replace(/^(Error:\s*)+/, '').slice(0, 120));
        // The body now STREAMS (rec.stream, Chrome 152) instead of riding
        // rec.content — read it via IO.read or the CLI writes a 0-byte
        // --out (stress: 200 application/json, 0 KB file).
        let binary = !!rec.base64Encoded;
        let body = rec.content ?? '';
        let truncated = false;
        if (rec.stream) {
          let b64 = '', text = '';
          const t0 = Date.now();
          for (;;) {
            const c = await chrome.debugger.sendCommand({ tabId: tab.id }, 'IO.read', { handle: rec.stream });
            if (c.base64Encoded) { binary = true; b64 += c.data; } else text += c.data || '';
            if (c.eof) break;
            // A huge body used to accumulate unbounded — and outlive the
            // withCdp timeout, which can't cancel this loop from outside.
            if (b64.length + text.length > BODY_CAP || Date.now() - t0 > 60_000) {
              truncated = true;
              break;
            }
          }
          await chrome.debugger.sendCommand({ tabId: tab.id }, 'IO.close', { handle: rec.stream }).catch(() => {});
          truncated = truncated || (!binary && text.length > BODY_CAP);
          body = binary ? b64 : text.slice(0, BODY_CAP);
        }
        return {
          status: rec.httpStatusCode ?? rec.statusCode ?? 200,
          ct: rec.mime || rec.headers?.['Content-Type'] || '',
          binary,
          body: binary ? String(body) : String(body).slice(0, BODY_CAP),
          truncated,
        };
      } finally {
        await detachDbg(tab.id);
      }
    });
    return read;
  }
}

// A JS dialog (alert/confirm/prompt) blocks the renderer: every eval and
// synthetic key wedges to the server's 70s timeout, so the agent cannot
// rescue itself without CDP — the one channel that answers a dialog.
async function cmdDialog(tab, msg) {
  // Ground truth (live, Chrome 152): handleJavaScriptDialog only answers a
  // dialog when the session's Page domain was enabled BEFORE the dialog
  // opened. After the fact, Page.enable wedges on the dialog-blocked
  // renderer, and a no-enable handle answers "No dialog is showing" while
  // the box sits on screen. CDP cannot rescue a stuck tab — but NAVIGATION
  // drops the dialog and revives the renderer (verified against a real
  // 40-minute-stuck alert: nav <match> <url> unwedged it instantly).
  return await withCdp(tab.id, async () => {
    try {
      await attachDbg(tab.id);
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.handleJavaScriptDialog', {
        accept: msg.accept !== false,
        ...(msg.text ? { promptText: msg.text } : {}),
      });
    } catch (e) {
      if (!/No dialog is showing/.test(String(e))) throw e;
      // "No dialog is showing" + a BLOCKED renderer = a native dialog CDP
      // can't touch. Distinguish it from the honest no-dialog case with a
      // short probe: a blocked renderer can't run any script.
      const alive = await Promise.race([
        chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => true }).then((r) => !!r?.[0]?.result?.value, () => false),
        new Promise((r) => setTimeout(() => r(null), 1500)),
      ]);
      if (alive === null)
        throw new Error(
          'a dialog IS showing but cannot be answered over CDP on this Chrome (the debugger must have attached before the dialog opened). ' +
            'Dismiss it by navigating — nav <match> <any url> drops the dialog and revives the tab — or: close <match>'
        );
      throw e; // renderer alive → genuinely no dialog
    } finally {
      await detachDbg(tab.id);
    }
    return (msg.accept === false ? 'dismissed' : 'accepted') + ' dialog on tab ' + tab.id;
  });
}

// File upload: eval can't touch <input type=file> (JS-set values are ignored
// for security), but CDP DOM.setFileInputFiles is the DevTools path and fires
// real input/change events, so frameworks see a genuine selection. The target
// is tagged page-side (refs live in whatever world snap ran in, but the DOM
// is shared), found via CDP querySelector, then untagged. Hidden inputs work
// — the common "pretty label wrapping a display:none input" pattern is
// exactly why the descendant search below exists.
async function cmdUpload(tab, msg) {
  const TAG = 'data-bridge-upload';
  // The whole body rides actAndVerify so the verdict baseline precedes the
  // CDP mutation (setFileInputFiles fires real input/change events).
  return await actAndVerify(tab.id, msg, async () => {
    const mode = await runEval(
      tab.id,
      `(() => {
      ${DEEPQ}
      const sel = ${JSON.stringify(msg.target)};
      const el = mustQuery(sel);
      const input = el.tagName === 'INPUT' && el.type === 'file' ? el : el.querySelector?.('input[type=file]');
      // No parent-subtree fallback: from a stray target (a heading) it would
      // silently pick some unrelated input on the page. Fail loud instead.
      if (!input) throw new Error('no file input at or inside ' + sel + ' — target the <input type=file> or an element wrapping it');
      input.setAttribute(${JSON.stringify(TAG)}, '');
      return input.multiple ? 'multiple' : 'single';
    })()`
    );
    if (mode === 'single' && msg.files.length > 1) {
      await runEval(tab.id, `document.querySelector('[${TAG}]')?.removeAttribute('${TAG}')`).catch(() => {});
      throw new Error('input has no "multiple" attribute — pass one file');
    }
    try {
      await withCdp(tab.id, async () => {
        try {
          await attachDbg(tab.id);
          const { root } = await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.getDocument', { depth: 1 });
          const { nodeId } = await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.querySelector', {
            nodeId: root.nodeId,
            selector: `[${TAG}]`,
          });
          if (!nodeId) throw new Error('tagged input vanished mid-upload — re-snap and retry');
          await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.setFileInputFiles', { nodeId, files: msg.files });
        } finally {
          await detachDbg(tab.id);
        }
      });
    } finally {
      await runEval(tab.id, `document.querySelector('[${TAG}]')?.removeAttribute('${TAG}')`).catch(() => {});
    }
    const names = msg.files.map((f) => f.split('/').pop()).join(', ');
    return `uploaded ${msg.files.length} file(s) to ${msg.target}: ${names}`;
  });
}

  // No tab activation here: CDP captureScreenshot works on background tabs,
  // and activating would steal the user's view. Only the fallback below needs it.
const shotFallbackQ = new Map(); // windowId -> captureVisibleTab fallback chain (see cmdShot's catch)
async function cmdShot(tab, msg) {
  const format = msg.format === 'jpeg' ? 'jpeg' : 'png';
  // First-ever shot on a fresh tab: let the in-flight auto-mark LAND before
  // the banner-free capture window — its injectBanner queues behind groupTab's
  // round trips and could otherwise arrive between removeBannerForCapture and
  // captureScreenshot, baking the pill into the PNG (and, for --diff, into
  // the baseline every later shot compares against).
  await awaitMark(tab.id);
  return await withCdp(tab.id, async () => {
    try {
      await attachDbg(tab.id);
      // Every CDP capture below (viewport/crop/full/diff) and even the
      // cdp-less fallback runs banner-free: the pill and its active purple
      // frame border are bridge UI and must not be in the shot (the band
      // artifact, the self-triggering pill — see removeBannerForCapture).
      const bannered = await removeBannerForCapture(tab.id);
      try {
        const params = { format };
        if (format === 'jpeg') params.quality = msg.quality ?? 80;
        // Downscale to a long edge of `max` px (0 = native). Claude resizes
        // anything past ~1568px on read anyway, so a native-res capture of a big
        // window buys file size, never detail — smaller capture, same answer.
        const max = maxOf(msg);
        // Captures render at devicePixelRatio, so budget max/dpr CSS px to keep
        // the OUTPUT long edge <= max (visualViewport is in device px).
        let dpr = 1;
        const cap = (w, h) => Math.min(msg.scale || 1, max / (Math.max(w, h) * dpr));
        if (msg.full) {
          // Full page: render beyond the viewport, clip to the CSS content size.
          const m = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.getLayoutMetrics');
          const c = m.cssContentSize;
          dpr = dprOf(m);
          params.captureBeyondViewport = true;
          const w = Math.ceil(c.width), h = Math.min(Math.ceil(c.height), 16384);
          params.clip = { x: 0, y: 0, width: w, height: h, scale: cap(w, h) };
        } else if (msg.crop) {
          // --crop x,y are viewport-relative (measure output); clip is page-absolute.
          // Same whole-px rounding as captureViewport — fractional viewport
          // offsets (infobar settle) would otherwise re-AA high-contrast edges
          // between captures.
          const m = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.getLayoutMetrics');
          const v = m.cssVisualViewport;
          dpr = dprOf(m);
          params.captureBeyondViewport = true;
          params.clip = { x: Math.round(msg.crop[0] + v.pageX), y: Math.round(msg.crop[1] + v.pageY), width: msg.crop[2], height: msg.crop[3], scale: cap(msg.crop[2], msg.crop[3]) };
        } else {
          // Viewport: cssVisualViewport fields are pageX/pageY/clientWidth/
          // clientHeight (no x/y/width/height — that's what broke --scale).
          if (msg.diff) {
            // --diff: whole-viewport png compared against the previous --diff
            // shot of this tab (baseline updates every call, like snap --diff).
            // On change the saved file is the CHANGED REGION only — the one
            // thing a canvas-watcher actually wants to look at.
            const prev = shotBaselines.get(tab.id);
            const nav0 = navSeq.get(tab.id) || 0; // commit-time guard below: a mid-capture/diff navigation must not let the OLD document's frame become the NEW one's baseline
            // --scale/--max cannot apply while a baseline exists (the diff is
            // pinned to the baseline's frame) — say so instead of a silent no-op.
            const ignored = prev && (msg.max !== undefined || msg.scale !== undefined) ? ' (--scale/--max ignored — the diff reuses the baseline frame)' : '';
            const cap = await captureViewport(tab.id, { ...msg, format: 'png' }, prev?.clip, true);
            const full = 'data:image/png;base64,' + cap.b64;
            // Commit guards: a release mid-capture (it takes no CDP lock — a
            // supported interleaving) cleared the baselines, a navigation
            // bumped navSeq — either way re-adding pins OLD-document pixels
            // as the next session's baseline. Returns whether it committed;
            // the notes must not claim a save that didn't happen.
            const setBase = () => {
              if (!drivenTabs.has(tab.id) || (navSeq.get(tab.id) || 0) !== nav0) return false;
              shotBaselines.set(tab.id, { b64: cap.b64, clip: cap.clip });
              return true;
            };
            if (!prev) {
              const kept = setBase();
              return { note: kept ? 'diff: baseline saved — run the action, then shot <match> <out> --diff again; this file is the full capture' : 'diff: page navigated or tab released mid-capture — no baseline kept; this file is the full capture', data: full };
            }
            // A navigation (or release) that landed mid-capture already
            // deleted the baseline (onUpdated / releaseTab) — prev is the OLD
            // document's pixels and diffing against them is the cross-document
            // garbage diff the delete exists to prevent. Bail; the next
            // --diff re-baselines. (setBase can't help here: navSeq moved.)
            if (shotBaselines.get(tab.id) !== prev) {
              return { note: 'diff: page navigated or tab released mid-capture — no baseline kept; run the action, then shot <match> <out> --diff again', data: full };
            }
            // Commit the baseline only once the comparison (and the crop) has
            // actually run — a throw mid-diff must not swallow the observed
            // change into the baseline, or the retry would report 'no change'
            // (found by review).
            const cmp = await pixelDiff(prev.b64, cap.b64);
            if (cmp.error) {
              const kept = setBase();
              return { note: 'diff: ' + cmp.error + (kept ? '' : ' — but the baseline was NOT saved (page navigated or tab released mid-diff)') + ignored, data: full };
            }
            if (!cmp.changed) {
              cmp.bmp.close();
              const kept = setBase();
              return { note: 'diff: no pixel change since the previous shot' + (kept ? ' (baseline updated)' : ' (page navigated or tab released mid-diff — baseline NOT updated)') + ignored, data: full };
            }
            const box = changedBox(cmp, cmp.bmp);
            const data = await cropDataUrl(cmp.bmp, box.x, box.y, box.w, box.h);
            cmp.bmp.close();
            const kept = setBase();
            const { x: cssX, y: cssY } = cssBox(cap, box);
            return {
              note: `diff: ${cmp.pct}% of pixels changed — the saved file is the changed region (${box.w}×${box.h}px; CSS offset x=${cssX}, y=${cssY} for measure/crop). ` + (kept ? 'Baseline is now THIS shot.' : 'Page navigated or tab released mid-diff — baseline NOT updated.') + ignored,
              data,
            };
          }
          const cap = await captureViewport(tab.id, msg);
          return `data:image/${cap.format};base64,${cap.b64}`;
        }
        // Raw path (full/crop): captureViewport re-removes at its own capture;
        // this sendCommand doesn't go through it — same timing-proof removal.
        await removeBannerForCapture(tab.id);
        const res = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.captureScreenshot', params);
        return `data:image/${format};base64,${res.data}`;
      } finally {
        await restoreBanner(tab.id, bannered);
      }
    } catch (e) {
      // debugger unavailable (chrome:// pages etc.) — fall back to captureVisibleTab
      // (viewport only, native res — crop/max/scale can't be honored there)
      console.warn('[bridge] cdp shot failed, falling back (crop/max/scale ignored):', e);
      // captureVisibleTab grabs the window's ACTIVE tab — must activate first,
      // otherwise we'd screenshot whatever the user is looking at. Restore the
      // tab the human WAS on after: stealing their view is the one promise
      // this path must not break (the CDP path above never activates).
      // Serialized PER WINDOW: two concurrent fallbacks on different tabs of
      // one window used to interleave activate→sleep→capture, and A captured
      // B's tab (stress-review finding) — withCdp is per-tab and can't help.
      const run = (shotFallbackQ.get(tab.windowId) || Promise.resolve()).then(async () => {
        const prev = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
        await chrome.tabs.update(tab.id, { active: true });
        try {
          await new Promise((r) => setTimeout(r, 400));
          const png = await chrome.tabs.captureVisibleTab(tab.windowId, { format, ...(format === 'jpeg' ? { quality: msg.quality ?? 80 } : {}) });
          // --diff can't run without CDP — say so instead of silently handing
          // back a plain shot the agent would read as a completed diff cycle.
          if (msg.diff) return { note: 'diff skipped — cdp unavailable on this page; this file is a plain fallback shot and the baseline is unchanged', data: png };
          return png;
        } finally {
          if (prev && prev.id !== tab.id) await chrome.tabs.update(prev.id, { active: true }).catch(() => {});
        }
      });
      const tail = run.catch(() => {});
      shotFallbackQ.set(tab.windowId, tail);
      tail.then(() => shotFallbackQ.get(tab.windowId) === tail && shotFallbackQ.delete(tab.windowId));
      return await run;
    } finally {
      await detachDbg(tab.id);
    }
  });
}

// Adding a command? SEVEN registries stay in sync (a missing one fails SILENTLY):
// cli.mjs USAGE · cli.mjs run() · server.mjs CLI_LINES · server.mjs route() (only if it
// needs special routing) · background.js handle() · ACT_VERBS (pill narration) · MUTATING.
async function handle(msg) {
  // State maps hydrate from storage.session — no command may run against
  // half-empty maps (cheap: storage read is sub-ms once warm).
  await ready;
  // open/nav with a non-URL: tabs.create resolves it RELATIVE TO THE EXTENSION
  // (stress: open "::x" created a driven chrome-extension://… tab and reported
  // ok, unmatchable until it committed). Validate before any tab exists — one
  // guard here covers both creators and every caller of them.
  if (msg.type === 'open' || msg.type === 'navigate') {
    let u;
    try {
      u = new URL(msg.url);
    } catch {}
    if (!u || !/^(https?|file|about|chrome|view-source|data):/i.test(u.protocol))
      throw new Error('invalid URL ' + JSON.stringify(String(msg.url).slice(0, 60)) + ' — give a full URL (http(s)://…)');
  }

  if (msg.type === 'ping') {
    return 'pong';
  }

  if (msg.type === 'swlogs') {
    return swLogs;
  }

  if (msg.type === 'extreload') {
    // Reload from disk — picks up unpacked-extension code changes without the
    // manual chrome://extensions click. Reply FIRST: the reload kills this
    // worker, so the ack must be on the wire before we go. storage.session
    // wipes with the worker — driven-tab memory (marks, pill history) is GONE
    // after reconnect: tabs keep their 🟣 group (Chrome-side) but the bridge
    // forgets they're driven (the group is not a source of truth — the merge
    // was removed on purpose). Chrome clears emulation on debugger detach.
    setTimeout(() => chrome.runtime.reload(), 250);
    return 'reloading from disk — the extension reconnects in a few seconds. NOT surviving: driven-tab memory (marks, pill history — re-mark tabs you were driving; they keep the 🟣 group but the bridge forgets them), emulation, in-flight debugger commands';
  }

  if (msg.type === 'tabs') {
    const tabs = await chrome.tabs.query({});
    const gTitles = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g.title]));
    return tabs.map((t) => ({
      id: t.id,
      url: t.url, // whole — agents pick their <match> substring from this
      title: (t.title || '').slice(0, 80),
      ...(t.groupId !== -1 ? { group: gTitles.get(t.groupId) ?? '' } : {}), // strip visibility: the Bridge group is one of the driven-tab markers
      ...(t.active ? { active: true } : {}),
      ...(drivenTabs.has(t.id) ? { driven: true } : {}),
    }));
  }

  // Multi-profile routing: does THIS profile have tabs matching? The server
  // probes every connected profile before sending the real command, so an
  // ambiguous cross-profile match can be refused instead of acting blind.
  // Read-only, no findTab, no marking.
  if (msg.type === 'probe') {
    const tabs = await chrome.tabs.query({});
    return tabs
      .filter((t) => tabMatches(t, msg.urlMatch))
      .map((t) => ({ id: t.id, url: (t.url || '').slice(0, 80), lastAccessed: t.lastAccessed || 0 }));
  }

  if (msg.type === 'open') {
    // Reuse-beats-fresh nudge: opening the exact URL an existing tab already
    // shows is almost always a skipped `tabs` check — the fresh copy has no
    // state (scroll, forms, SPA position). Warn on the result; the tab still
    // opens — sometimes a clean copy is exactly what's wanted.
    try {
      const want = new URL(msg.url).href;
      const dupe = (await chrome.tabs.query({})).some((t) => {
        try {
          return new URL(t.url || '').href === want;
        } catch {
          return false;
        }
      });
      if (dupe)
        msg._warn = '⚠ another tab already shows this exact URL — drive it directly (tabs → snap/click) to keep its state; this opened a fresh copy anyway';
    } catch {} // URL shape already validated in handle()'s prelude
    // chrome.tabs.create resolves promptly — the HANG is the marking below:
    // executeScript sits pending forever on an uncommitted navigation (an
    // unreachable URL never gets a document), which used to blow the 8s cap
    // to the server's 70s timeout. So: don't await the marking — setFavicon
    // and markTab set their SW-side state synchronously, the pill/favicon
    // land when the page commits (onUpdated re-applies both after load),
    // and the 8s waitForLoad below keeps the documented cap by itself.
    const tab = await chrome.tabs.create({ url: msg.url, active: false });
    msg._tabId = tab.id;
    // Listener before the favicon/banner work: those are two executeScript
    // round trips, and a fast page can hit 'complete' inside that window
    // (observed with example.com) — the load event would be missed. The
    // recheck covers the tighter race: committed before this listener attached.
    const complete = waitForLoad(tab.id, 8000, true);
    setFavicon(tab.id, '⏳').catch(() => {});
    markTab(tab.id).catch(() => {});
    recordActivity(tab.id, msg);
    const loaded = await complete;
    const { url } = await chrome.tabs.get(tab.id); // "" while pending
    // url falls back to the requested one: a still-pending tab can't be
    // matched by its (empty) URL, and the agent needs a usable <match>.
    return { id: tab.id, url: url || msg.url, loaded };
  }

  if (msg.type === 'navigate') {
    const tab = await findTab(msg);
    // nav to the URL the tab ALREADY shows is a reload — SPA state, scroll,
    // form inputs die. Agents do it to "make sure"; name the cost. (The
    // dialog-rescue nav is a deliberate reload — the warning is accurate
    // there too.)
    try {
      if (new URL(tab.url).href === new URL(msg.url).href)
        msg._warn =
          '⚠ the tab was already at this URL — nav just reloaded it (state, scroll, form inputs reset). Skip nav to drive the existing page; when you want a refresh, this is it';
    } catch {} // empty/unparseable url (still-pending tab) — no opinion
    // Listener before update: a fast page can hit 'complete' before
    // tabs.update resolves, and a missed event would mean a wasted 8s wait.
    const loaded = waitForLoad(tab.id);
    await chrome.tabs.update(tab.id, { url: msg.url });
    // Fire-and-forget, like every other mark site: markTab's injectBanner can
    // pend on the uncommitted navigation tabs.update just started (the same
    // trap findTab's comment documents) — awaiting it would strand the whole
    // command at the server's 70s cap while waitForLoad's 8s sat unawaited.
    // onUpdated re-banners on 'complete' regardless.
    markTab(tab.id).catch(() => {});
    const complete = await loaded;
    // nav --diff carries the verdict too — no baseline diff (the page is
    // replaced), so: walls first, then a fresh snap as the body.
    if (msg.diff) {
      const wall = await runEval(tab.id, WALL_SRC).catch(() => ({}));
      if (wall.captcha) return `needs_human · navigated — bot wall: ${wall.captcha} — hand off: wait <match> --human`;
      if (wall.block) return `blocked · navigated — ${wall.block}`;
      if (wall.login) return 'needs_human · navigated to a login/2FA wall — hand off: wait <match> --human';
      const snap = await runEval(tab.id, SNAP_SRC(null, false, false));
      return `succeeded · navigated${complete ? '' : ' (still loading)'} — fresh snap (refs are new):\n${snap}`;
    }
    return { id: tab.id, loaded: complete };
  }

  if (msg.type === 'close') {
    // --all drains EVERY same-profile match. findTab's refusal leaves no way
    // to address identical-URL tabs (no longer <match> can tell them apart),
    // and a broad one-at-a-time close loop is exactly the ambiguity the
    // refusal exists to stop — an explicit plural close is not a guess. No
    // marking/recording: the tabs are about to not exist.
    if (msg.all) {
      const ts = await chrome.tabs.query({});
      const matches = ts.filter((t) => tabMatches(t, msg.urlMatch));
      if (!matches.length) throw new Error(`no tab matching "${msg.urlMatch}" — already closed? (the match is a URL/title substring)`);
      await chrome.tabs.remove(matches.map((t) => t.id));
      return { closed: matches.length };
    }
    const tab = await findTab(msg);
    await chrome.tabs.remove(tab.id);
    return { id: tab.id };
  }

  // Agent → human narration: the pill label becomes the note text for its
  // duration, and it lands in the history ring like any action. Driven tabs
  // only — a note nobody can see is wasted agent tokens, so fail loudly.
  if (msg.type === 'note') {
    const tab = await findTab(msg);
    // First-ever command on a fresh tab: the auto-mark (this command's OR a
    // sibling's — the banner lands only after groupTab's Chrome API round
    // trips either way) is still in flight, so an immediate probe would beat
    // it and throw a spurious 'pill not visible'. Await the in-flight mark —
    // NOT a fresh markTab: re-marking a ✕-hidden driven tab would resurrect
    // the pill the human dismissed, and the probe must keep failing loudly.
    await awaitMark(tab.id);
    // The pill the human hid (✕) or a chrome:// page silently swallows the
    // note while the agent believes the human was warned — probe and say so.
    // (Banner lookup is DOM — world-agnostic; no world option needed.)
    let seen = null;
    try {
      seen = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => !!document.getElementById('bridge-banner') });
    } catch {} // injection itself failed — chrome:// page etc.
    if (!seen?.[0]?.result) {
      // A sibling's screenshot/pixel-wait/trusted-input window has the banner
      // down RIGHT NOW — transient, not the durable ✕/chrome:// case; a
      // 'the human hid the pill' misread sends the agent down a wrong path.
      if (bannerSuppressed.has(tab.id)) throw new Error('pill temporarily down — a capture or trusted-input window is in flight on this tab; retry the note in a moment');
      throw new Error("pill not visible on this tab (hidden via ✕ or non-injectable page) — the human won't see this note");
    }
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

  if (msg.type === 'fetch') {
    const tab = await findTab(msg);
    return await cmdFetch(tab, msg);
  }

  if (msg.type === 'measure') {
    const tab = await findTab(msg);
    return await runEval(tab.id, measureSrc(msg.selector));
  }

  if (msg.type === 'grid') {
    const tab = await findTab(msg);
    return await runEval(tab.id, GRID_SRC);
  }

  if (msg.type === 'snap') {
    const tab = await findTab(msg);
    if (msg.find) return await runEval(tab.id, FIND_SRC(msg.scope, msg.find));
    // Chained: every snap writes the in-page diff store — see withSnap.
    return await withSnap(tab.id, () => runEval(tab.id, SNAP_SRC(msg.scope, msg.diff, msg.href, msg.skeleton)));
  }

  // --trusted: route click/press/type/hover/drag through CDP Input.dispatch*
  // (isTrusted=true events). Before the synthetic group so the flag wins.
  if (msg.trusted && ['click', 'press', 'type', 'hover', 'drag'].includes(msg.type)) {
    const tab = await findTab(msg);
    return await actAndVerify(tab.id, msg, () => trustedInput(tab, msg));
  }

  if (['click', 'fill', 'type', 'press', 'hover'].includes(msg.type)) {
    const tab = await findTab(msg);
    const src =
      msg.type === 'click' ? clickSrc(msg.target, msg.dbl) :
      msg.type === 'fill' ? fillSrc(msg.target, msg.value) :
      msg.type === 'type' ? typeSrc(msg.target, msg.value) :
      msg.type === 'press' ? pressSrc(msg.key, msg.target) :
      hoverSrc(msg.target);
    return await actAndVerify(tab.id, msg, () => runEval(tab.id, src));
  }

  if (msg.type === 'paste') {
    const tab = await findTab(msg);
    return await actAndVerify(tab.id, msg, () => runEval(tab.id, pasteSrc(msg.target, msg.value)));
  }

  if (msg.type === 'drag') {
    const tab = await findTab(msg);
    return await actAndVerify(tab.id, msg, () => runEval(tab.id, dragSrc(msg.from, msg.to)));
  }

  if (msg.type === 'dialog') {
    const tab = await findTab(msg);
    return await cmdDialog(tab, msg);
  }

  if (msg.type === 'scroll') {
    const tab = await findTab(msg);
    // --diff shines here: lazy-loaded content is DOM mutations, so the
    // settle + snap-diff returns exactly what the scroll revealed.
    return await actAndVerify(tab.id, msg, () => runEval(tab.id, scrollSrc(msg.target)));
  }

  if (msg.type === 'upload') {
    const tab = await findTab(msg);
    return await cmdUpload(tab, msg);
  }

  if (msg.type === 'ask') {
    const tab = await findTab(msg);
    return await runEval(tab.id, askSrc(msg.question));
  }

  if (msg.type === 'net') {
    const tab = await findTab(msg);
    return await withCdp(tab.id, () => captureNetwork(tab.id, msg.duration, msg.filter, msg.body, msg.har, msg.ws));
  }

  if (msg.type === 'wait') {
    const tab = await findTab(msg);
    if (msg.human) return await waitHuman(tab, msg);
    if (msg.pixel) return await waitPixel(tab, msg);
    return await runEval(tab.id, waitSrc(msg));
  }

  if (msg.type === 'console') {
    const tab = await findTab(msg);
    const log = await runEval(tab.id, consoleSrc(msg.clear), 'MAIN');
    if (!msg.ask) return log;
    if (/^\(empty/.test(log)) return log; // nothing to triage
    // --ask: Nano reads the noise locally; only its verdict costs cloud tokens.
    // Newest-last buffer, so the tail is the fresh end — cap from the left.
    const question =
      msg.ask === true
        ? 'Which of these are real problems worth investigating? Most severe first, one line each. If nothing matters, say "all noise".'
        : msg.ask;
    return await runEval(tab.id, nanoSrc('Browser console messages from ' + tab.url + ' (newest last):\n' + log.slice(-3000), question));
  }

  if (msg.type === 'emulate') {
    const tab = await findTab(msg);
    await withCdp(tab.id, () => setEmulation(tab.id, msg));
    return {
      id: tab.id,
      ...(msg.focus ? { focus: true } : { width: msg.width, height: msg.height, mobile: !!msg.mobile }),
    };
  }

  if (msg.type === 'unemulate') {
    const tab = await findTab(msg);
    await withCdp(tab.id, () => clearEmulation(tab.id));
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
    return await cmdShot(tab, msg);
  }

  throw new Error(`unknown type "${msg.type}"`);
}
