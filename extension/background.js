// The CLI's command grammar (parse/render/registry), shared with the cloud
// link so a command line means the same thing on both. Classic script →
// globalThis.BridgeCommands; must load before anything below runs.
importScripts('commands.js');

// Port 9333 is hardcoded in FOUR places: here, cli.mjs, server.mjs, popup.js. The extension
// can't read BRIDGE_PORT — change all four together (README 'Install detail').
const WS_URL = 'ws://127.0.0.1:9333/ws';

// Section map (each '// ---' banner, in order):
//   Service-worker log ring · Links (one WebSocket per command source) ·
//   Cloud arm (the hub link: MCP tools over the commands module) ·
//   Driven-tab marking (pill/banner injection) ·
//   Live status in the corner pill (narration, ticker, activity ring) ·
//   Status favicon · CDP debugger refcount · Device emulation · Boot hydration
//   (storage.session restore) · Network capture · Page-side scripts (every
//   injected JS template: snap/click/fill/…/find/measure/console/wall) ·
//   pixel diff + capture (banner suppression lives here) · trusted input ·
//   eval machinery · --diff on actions · wait --human · Commands (handle()).

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

// Store install or unpacked? getSelf is the one chrome.management method that
// needs no permission. Rides the WS handshake so health/extreload can stop
// telling store users to reload from disk (that only works for unpacked).
let INSTALL_TYPE = '';
const installReady = chrome.management
  .getSelf()
  .then((i) => {
    INSTALL_TYPE = i.installType === 'development' ? 'dev' : 'store';
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

// Boot timestamp for the stale-CODE guard (#63): set once per LOADED instance
// and kept in storage.session — it survives service-worker restarts (which do
// NOT re-read the script Chrome has cached) and is wiped by an extension
// reload / browser restart, so it stays "when this build was loaded". The
// server compares it with the newest mtime under <repo>/extension and warns
// when the disk moved on after the load — the version compare can't see
// same-version drift (a since-reverted spike kept running once).
const BOOT_TS_P = chrome.storage.session
  .get('bootTime')
  .then(({ bootTime }) => bootTime || (chrome.storage.session.set({ bootTime: Date.now() }), Date.now()))
  .catch(() => Date.now());

// --- Links -------------------------------------------------------------------
// A link is one outbound WebSocket to something that sends commands. Today the
// only one is `local` (the server on 127.0.0.1); the Cloud Bridge hub joins as
// a second link and both run at the same time. Every command is tagged with
// the link it came in on (msg._link): the reply goes back on that socket, the
// tab it marks belongs to that link, and the other links may only read that
// tab (assertLinkMayDrive).
//   id       stable key, and the owner tag on the tabs the link drives
//   url      where to dial — dial() returns it with the per-connect query
//   label    how errors and `tabs` name the link to an agent
//   policy   'full' runs everything (local); the hub's Allow/Ask/Off map lands here
//   socket   the live WebSocket, or null
//   backoff  next reconnect delay in ms: doubles per drop from retry[0] up to
//            retry[1], back to retry[0] once open (local: a flat 500ms)
const links = new Map();
function addLink(def) {
  const link = { policy: 'full', retry: [500, 500], ...def, socket: null, wasOffline: false, offlinePainted: false };
  link.backoff = link.retry[0];
  links.set(link.id, link);
  return link;
}
const linkOpen = (id) => links.get(id)?.socket?.readyState === WebSocket.OPEN;
// Fire-and-forget: false when the link is down (the caller decides whether
// to queue), never a throw.
function linkSend(id, data) {
  if (!linkOpen(id)) return false;
  try {
    links.get(id).socket.send(data);
    return true;
  } catch {
    return false;
  }
}
// Local AI agents switch (popup → ⚙ Settings), on unless the human turned it
// off. Off, the local link never dials: agents on this computer can't see or
// reach this profile until it's on again. Cloud AI apps don't depend on it.
// Off until the stored switch is read: a keepalive alarm that wakes a cold
// worker runs before that read lands and must not dial a profile the human
// switched off (found by review). The boot watchdog sets it if the read wedges.
let localOn = true;
let localLoaded = false;
const LOCAL_OFF_ERROR = "Local AI agents was switched off in this Chrome profile's chrome-bridge popup — ask the user to switch it on (⚙ Settings → Local AI agents)";
const localReady = chrome.storage.local
  .get('localAgents')
  .then(({ localAgents }) => {
    if (localAgents !== false) return;
    localOn = false;
    // A read slower than the boot watchdog: it already connected with the
    // default (on) — hang up like the toggle does, or the open socket
    // refuses every command, the server's routing probes included (found by
    // review).
    if (linkOpen('local')) linkSend('local', JSON.stringify({ type: 'event', kind: 'local-off' }));
    links.get('local')?.socket?.close();
  })
  .catch(() => {})
  .finally(() => {
    localLoaded = true;
  });
addLink({
  id: 'local',
  label: 'local',
  url: WS_URL,
  enabled: () => localLoaded && localOn,
  async dial() {
    // ?boot= feeds the server's stale-code check (#63) — see BOOT_TS_P.
    let boot = null;
    try {
      boot = await BOOT_TS_P;
    } catch {}
    // ?v= lets `cli health` catch a stale extension after git pull; ?id= names
    // which profile holds the seat in the server log and /health.
    return (
      this.url +
      '?v=' +
      chrome.runtime.getManifest().version +
      (PROFILE_ID ? '&id=' + PROFILE_ID : '') +
      (PROFILE_NAME ? '&name=' + PROFILE_NAME : '') +
      (INSTALL_TYPE ? '&install=' + INSTALL_TYPE : '') +
      (boot ? '&boot=' + boot : '')
    );
  },
});

// Lifecycle journal — one WS event per marker-affecting transition (mark,
// release, reap, boot, …) so server.log can answer "why is this tab still
// marked?" after the fact. Fire-and-forget like self-release, except events
// fired while the socket is down (boot, extreload) queue briefly and flush
// on the next connect — losing boot events would defeat the point. Local
// link only: server.log is the local server's, and a remote hub has no use
// for this profile's marker bookkeeping.
const pendingJournal = [];
const pendingDiagnostics = new Map();

// Logging settings live on the local server (the one link with a disk).
function requestDiagnostics(msg) {
  const ws = links.get('local').socket;
  if (!linkOpen('local')) return Promise.resolve({ ok: false, error: 'Bridge not connected. Start the server and reopen settings.' });
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingDiagnostics.delete(requestId);
      resolve({ ok: false, error: 'Settings request timed out. Update/restart the server, then reopen settings to check its state.' });
    }, 4000);
    pendingDiagnostics.set(requestId, (response) => {
      clearTimeout(timer);
      pendingDiagnostics.delete(requestId);
      resolve(response);
    });
    try {
      ws.send(JSON.stringify({ type: 'diagnostics', requestId, action: msg.action, enabled: msg.enabled, limitMiB: msg.limitMiB }));
    } catch {
      pendingDiagnostics.get(requestId)({ ok: false, error: 'Bridge disconnected. Reopen settings to check its state.' });
    }
  });
}

function journal(kind, tabId, detail) {
  const line = JSON.stringify({ type: 'event', kind, tabId: tabId ?? null, detail: String(detail || '').slice(0, 120) });
  if (!linkSend('local', line)) {
    pendingJournal.push(line);
    if (pendingJournal.length > 50) pendingJournal.shift();
  }
}

// One command from any link: strip caller-supplied _fields, tag the link, run
// it with the pill/favicon bookkeeping, and answer with the reply envelope
// {ok, result | error, pageErrors?} (the local link sends it as-is with its id;
// the cloud arm renders it).
async function runCommand(link, msg) {
  // Underscore fields (_tabId, _pill, _markedByMe, _warn, …) are INTERNAL —
  // set while handling a command, and trusted by onmessage's catch/finally
  // and the ownership gate. The server strips them at /cmd, but that guards
  // one ingress: strip on every link, THEN tag the command with the link it
  // came in on (a peer can't claim to be another link).
  for (const k of Object.keys(msg)) if (k.startsWith('_')) delete msg[k];
  msg._link = link.id;
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
    // A separate field, never merged into result: eval output stays byte-identical for scripts parsing it.
    const pageErrors = await pageErrorsFor(msg);
    return { ok: true, result, ...(pageErrors ? { pageErrors } : {}) };
  } catch (err) {
    failed = true;
    let wrapped = wrapErr(err); // raw Chrome tab-gone noise → named cause + recovery
    // #37: a command that MARKED the tab (this command, just now) and then
    // hit Chrome's permanent "nothing here is drivable" wall (chrome://,
    // Web Store, PDF, another extension's page, an unattachable debugger)
    // must not leave its fresh mark behind — the tab would sit in the
    // 🟣 Bridge group with no pill and no owner. Undo THIS command's claim
    // through the normal release path — never a pre-existing one (a
    // transient failure on a tab the agent has been driving is not this).
    if (msg._markedByMe && msg._tabId != null && /off-limits to extensions|another extension's page|Cannot access a chrome|cannot be scripted|extensions gallery|Cannot attach/i.test(errText(err) + ' ' + wrapped)) {
      releaseTab(msg._tabId).catch(() => {});
      wrapped += ' — nothing on that page is drivable, so the tab was released again (no markers left)';
    }
    // Failures belong in the human-visible history too — a red-ink line in
    // the pill log, not just an error back to the agent.
    if (msg._tabId != null && currentActivity(msg._tabId, msg)) {
      const { done } = activityPhrases(msg);
      // Same 'Error: Error:' dedup the CLI and the watch feed got (756df17)
      // — the pill history is the third place this line lands.
      const lines = pushActivity(msg._tabId, '✗ ' + done + ' — ' + humanizeErr(wrapped));
      // Same world as the success path: refs live in the world snap ran
      // in, so on CSP/MAIN-world pages this resolves the @ref to a name
      // instead of narrating agent-speak ('✗ clicked @e4').
      pillWrite(msg._tabId, ['✗ ' + done, lines, msg.target || null, false], 'MAIN');
    }
    const pageErrors = await pageErrorsFor(msg);
    return { ok: false, error: wrapped, ...(pageErrors ? { pageErrors } : {}) };
  } finally {
    // ✅ when a command on a driven tab lands, ✗ when it failed — the strip
    // icon must not claim success on an error. Non-driven tabs are left
    // alone — otherwise any stray command would stick an icon on them with
    // no release to ever restore it. Release restores in releaseTab.
    const tabId = msg._tabId;
    // Decrement only an EXISTING entry: a tab closed mid-command already
    // had its entry deleted by onRemoved — recreating it as a deadId->0
    // pair leaks one inert entry per such command until the SW restarts.
    if (msg._pill && inflight.has(tabId)) {
      const n = (inflight.get(tabId) || 1) - 1;
      if (n > 0) inflight.set(tabId, n);
      else inflight.delete(tabId);
    }
    if (tabId != null && currentActivity(tabId, msg)) {
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
      if (!(inflight.get(tabId) > 0)) {
        stopTick(tabId);
        pillBusy.delete(tabId); // the tab is idle — restoreBanner goes back to idleLabel
      } // a still-running sibling keeps the ticker (and its label) going
      // Pill back to neutral after a beat — the in-flight label needs
      // ~800ms to be glanceable, and the tooltip ring keeps the history.
      // A note holds ~4s instead: its label IS the message, and the note
      // command itself runs in ~100ms — the standard beat would flash it
      // too briefly to ever be seen (found live in v1.5.0 testing).
      // The seq guard skips the reset if a newer command already started;
      // the inflight guard skips it if a sibling command is STILL running
      // (its own reset will fire when it finishes). The pillQ chain (not a
      // guard) is what orders this reset behind a tick that was injected
      // just before the command ended — the #41 frozen-label race.
      const seq = pillSeq.get(tabId) || 0;
      setTimeout(() => {
        if (!currentActivity(tabId, msg)) return;
        if ((pillSeq.get(tabId) || 0) !== seq) return;
        if ((inflight.get(tabId) || 0) > 0) return;
        // A gone pill (page wiped it; a first mark gated by a capture
        // window) gets rebuilt inside pillWrite's revivePill — this reset
        // can be the last guaranteed pill touch on the tab.
        pillWrite(tabId, [idleLabel(tabId), tabActivity.get(tabId) || [], null, false]);
      }, msg.type === 'note' ? 4000 : 800);
    }
  }
}

// Async: awaits link.dial() (BOOT_TS_P for local) before dialing. Callers
// fire-and-forget, and the double-connect guard runs synchronously at entry,
// so the await can't wedge a second connect behind a first one — only the
// dial itself moves later.
async function connect(link) {
  // Two connects in flight on one link (reconnect timer + keepalive alarm)
  // means two sockets; the server seats the first and rejects the second.
  // Reply on the socket that received the message (s), never link.socket —
  // after a race those differ, and replying on the rejected socket leaves
  // every command unanswered while health still says "connected".
  try {
    link.socket?.close();
  } catch {}
  // A link that isn't set up (cloud: not paired, or switched off) never dials.
  if (link.enabled && !link.enabled()) return;
  let s;
  try {
    const url = await link.dial();
    // Switched off while the dial awaited (the human's toggle, or a link
    // whose setting just loaded as off): don't open a socket nobody closes.
    if (link.enabled && !link.enabled()) return;
    s = link.socket = new WebSocket(url, link.protocols?.());
  } catch {
    return;
  }
  s.onopen = () => {
    link.backoff = link.retry[0];
    if (link.rpc) cloudOpen(link, s);
    if (link.id === 'local') for (const l of pendingJournal.splice(0)) s.send(l);
    // Back online after a server outage: pills that painted "offline" go back
    // to the honest current state (a command still running keeps its label —
    // local page-side work survives a server blip).
    link.wasOffline = false; // disarms the grace timer below
    if (link.offlinePainted) {
      link.offlinePainted = false;
      for (const tabId of drivenTabs) {
        if (ownerOf(tabId) !== link.id) continue; // another link's tabs never painted offline
        const busy = (inflight.get(tabId) || 0) > 0;
        pillWrite(tabId, [busy ? pillBusy.get(tabId) || idleLabel(tabId) : idleLabel(tabId), tabActivity.get(tabId) || [], null, busy]);
      }
    }
  };
  s.onmessage = async (e) => {
    if (link.rpc) return cloudMessage(link, s, e.data);
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
    if (msg.type === 'diagnostics-result' && link.id === 'local') {
      pendingDiagnostics.get(msg.requestId)?.(msg);
      return;
    }
    if (msg.type === 'seat-taken') {
      // This profile already holds a live socket (a service-worker reconnect
      // race — the server keeps ONE seat per profile). Intercept BEFORE
      // handle() (an unknown type there throws) and mark the socket: the
      // 500ms hot reconnect in onclose would churn the server at 2Hz — let
      // the 30s keepalive alarm re-probe instead.
      // Drop the queued journal lines too: the seat HOLDER journals its own
      // transitions — a loser that queued boot lines (two extension builds in
      // one profile share the storage keys and the profile id) flushes
      // duplicate boot events into server.log before it ever reads this.
      if (link.id === 'local') pendingJournal.length = 0;
      s._seatTaken = true;
      if (link.socket === s) link.socket = null;
      // The losing side was silent — a cloned profile dir (machine migration)
      // bounced this worker forever and nothing anywhere said why.
      logLine('seat taken — another live connection holds this profile id (SW reconnect race, or a cloned Chrome profile dir); standing down, the keepalive re-probes');
      return;
    }
    // Switched off while this socket was still open: run nothing more.
    if (link.enabled && !link.enabled()) {
      try {
        s.send(JSON.stringify({ id: msg.id, ok: false, error: LOCAL_OFF_ERROR }));
      } catch {}
      return;
    }
    const reply = await runCommand(link, msg);
    try {
      s.send(JSON.stringify({ id: msg.id, ...reply }));
    } catch {} // the socket closed mid-command: onclose reconnects
  };
  s.onclose = (ev) => {
    if (link.rpc) {
      clearInterval(s._ping);
      cloudDropPending(s);
    }
    if (link.socket !== s) return; // a newer socket already took over — don't double-reconnect
    link.socket = null;
    if (s._seatTaken) return;
    if (link.rpc && ev?.code === CLOUD_UNPAIRED) return cloudUnpaired(ev.reason); // lost the seat race — the 30s keepalive alarm re-probes
    // Say so in the pill: 'AI idle' during a bridge outage reads as "done,
    // waiting" — the human can't tell a dead server from a resting agent.
    // But a sub-second reconnect blip must not flash ⚠ on every driven tab
    // either: paint only if the link is still down after a short grace
    // (link.wasOffline arms now so a second onclose can't stack paints;
    // onopen disarms). link.offlinePainted: the ⚠ paint actually landed, so
    // onopen only re-paints tabs that showed it. Only this link's tabs — a
    // tab another link drives is still live.
    if (!link.wasOffline) {
      link.wasOffline = true;
      setTimeout(() => {
        if (!link.wasOffline) return; // reconnected inside the grace — stay calm
        if (link.enabled && !link.enabled()) return; // switched off on purpose, not an outage
        link.offlinePainted = true;
        for (const tabId of drivenTabs) {
          if (ownerOf(tabId) !== link.id) continue;
          pillWrite(tabId, ['⚠ bridge offline — reconnecting…', tabActivity.get(tabId) || [], null, false]);
        }
      }, 2500);
    }
    // Reconnect right away (local: a flat 500ms); the alarm is only a
    // backstop for a killed SW.
    const delay = link.backoff;
    link.backoff = Math.min(link.backoff * 2, link.retry[1]);
    setTimeout(() => connect(link), delay);
  };
}

// --- Cloud arm ---------------------------------------------------------------
// The Cloud Bridge hub as a second link, running beside `local`: same
// commands, spoken as MCP over JSON-RPC text frames (arm/hello → arm/policy,
// tools/list, tools/call; the text frame `ping` every 20s, answered `pong`).
// Dormant until this profile is paired from the popup: no hub URL and token,
// no dial. Command lines go through commands.js — the CLI's own grammar,
// validation and rendering — then runCommand, so a cloud command is marked,
// narrated and refused exactly like a local one (plus this link's policy).
const CLOUD_PROTOCOL = 'cloud-bridge.v1';
const CLOUD_UNPAIRED = 4401; // the hub's "unknown or revoked arm token" close code
// unrevoked: tokens signed out here while their hub was unreachable, kept only
// to retry the sign-out there (see cloudRevokePending).
let cloudCfg = { hub: '', token: '', enabled: false, pairing: null, notice: '', unrevoked: [] };
const cloudReady = chrome.storage.local
  .get('cloud')
  .then(({ cloud }) => {
    if (cloud && typeof cloud === 'object') cloudCfg = { ...cloudCfg, ...cloud };
    cloudBadge(); // a pairing that outlived the worker keeps its badge; none clears a stale one
  })
  .catch(() => {});
function saveCloud(patch) {
  cloudCfg = { ...cloudCfg, ...patch };
  if ('pairing' in patch) cloudBadge();
  return chrome.storage.local.set({ cloud: cloudCfg }).catch(() => {});
}
// While a pairing waits, the toolbar icon shows the code's first 4 characters:
// the hub's confirm page says to compare them, and the popup (which shows the
// whole code) closes the moment that page opens (Ivan, live: "where i see that
// number?"). Global badge: per-tab driven markers (•) still win on their tabs.
function cloudBadge() {
  const code = cloudCfg.pairing?.code;
  chrome.action?.setBadgeText({ text: code ? String(code).slice(0, 4) : '' })?.catch(() => {});
  if (code) chrome.action?.setBadgeBackgroundColor({ color: '#7c3aed' })?.catch(() => {});
  chrome.action?.setTitle({ title: code ? `chrome-bridge — Cloud Bridge code ${code}` : 'chrome-bridge' })?.catch(() => {});
}
function cloudArmUrl(hub) {
  const u = new URL('/arm', hub);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href;
}
addLink({
  id: 'cloud',
  label: 'Cloud Bridge',
  rpc: true,
  retry: [1000, 60000],
  // Replaced by the hub's arm/policy: per-command 'allow' | 'ask' | 'off'.
  policy: { commands: {}, blockedDomains: [] },
  enabled: () => !!(cloudCfg.enabled && cloudCfg.hub && cloudCfg.token),
  async dial() {
    return cloudArmUrl(cloudCfg.hub);
  },
  // Browsers can't set headers on a WebSocket: the token rides as a subprotocol.
  protocols: () => [CLOUD_PROTOCOL, 'cbtoken.' + cloudCfg.token],
});

function cloudOpen(link, s) {
  const version = chrome.runtime.getManifest().version;
  s.send(JSON.stringify({ jsonrpc: '2.0', method: 'arm/hello', params: {
    kind: 'chrome', name: PROFILE_NAME, version, selector: 'profile',
    offlineHint: `Ask the user to open Chrome (the profile chrome-bridge calls "${PROFILE_NAME}") and check that Cloud AI apps is on in the chrome-bridge popup's ⚙ Settings`,
  } }));
  s._lastPong = Date.now();
  s._ping = setInterval(() => {
    try {
      s.send('ping');
    } catch {}
  }, 20000);
  if (cloudCfg.notice) saveCloud({ notice: '' });
}

// The hub forgot this arm (revoked in its UI, or a reset hub): drop the token
// and stay down — redialing with it would only be refused again.
function cloudUnpaired(reason) {
  logLine('cloud: the hub refused this profile (' + (reason || 'revoked') + ') — unpaired; pair again from the popup');
  saveCloud({ token: '', enabled: false, notice: 'The hub no longer knows this Chrome profile. Pair it again.' });
}

// The tools live in commands.js (the hub syncs its pre-pairing list from
// there). A typed tool whose command the user turned Off isn't offered; the
// call is still refused if a client cached it.
const CLOUD_TOOLS = (link) =>
  globalThis.BridgeCommands.TOOLS.filter((t) => !(t.command && link?.policy?.commands?.[t.command] === 'off')).map(({ command, ...t }) => t);

const cloudText = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });
// The dispatch deadline the local server stamps on every command (server.mjs
// ask()): a --diff action queued past it refuses to run rather than act late.
// Without one, every cloud --diff action expired before running (found live).
// Inside the hub's own 120s call timeout; a human hand-off gets its timeout.
const cloudDeadline = (msg) => Date.now() + (msg.human ? Math.min(Number(msg.timeout) || 120000, 280000) + 5000 : 70000);
// The module's errors are worded for the CLI; the cloud has no cli.mjs.
const cloudWords = (text) => String(text).replace(' (see: cli.mjs profiles)', ': pick the Chrome with the tool\'s profile argument instead');

// Requests this arm sends the hub (arm/download, arm/file), answered by id.
let cloudSeq = 0;
const cloudPending = new Map(); // id -> { resolve, reject, timer, socket }
function cloudRequest(link, method, params, ms = 45000) {
  const s = link.socket;
  if (!s || s.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Cloud Bridge is not connected right now; try again in a few seconds'));
  const id = 'arm-' + ++cloudSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cloudPending.delete(id);
      reject(new Error(`Cloud Bridge didn't answer within ${ms / 1000}s`));
    }, ms);
    cloudPending.set(id, { resolve, reject, timer, socket: s });
    try {
      s.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    } catch (err) {
      clearTimeout(timer);
      cloudPending.delete(id);
      reject(err);
    }
  });
}
function cloudDropPending(s) {
  for (const [id, p] of cloudPending) {
    if (p.socket !== s) continue;
    cloudPending.delete(id);
    clearTimeout(p.timer);
    p.reject(new Error('the connection to Cloud Bridge dropped before it answered'));
  }
}

// upload over the cloud: no disk, so a file is a public http(s) URL or a
// data: URL (#fragment = file name). URLs are downloaded by the HUB, never
// here: this browser can reach the user's LAN (router, NAS, the local bridge)
// and page content can steer the AI's URL — no hostname check stops a DNS
// name that points there (review). The hub only reaches public addresses.
const CLOUD_UPLOAD_MAX = 10 * 1024 * 1024;
const CLOUD_FILE_HELP = "Cloud Bridge can't read files on the user's computer: give a public http(s) URL, or the bytes as data:<type>;base64,<data>#<name> (chrome_upload takes files: [{url}] or [{name, base64, mimeType}]).";
function b64FromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const tooBig = (n) => `the file is ${(n / 1048576).toFixed(1)} MB — Cloud Bridge uploads take up to ${CLOUD_UPLOAD_MAX / 1048576} MB`;
function cloudDataFile(token) {
  const hash = token.lastIndexOf('#');
  let name = 'file';
  try {
    if (hash > 0) name = decodeURIComponent(token.slice(hash + 1)) || 'file';
  } catch {}
  const body = hash > 0 ? token.slice(0, hash) : token;
  const m = /^data:([^,]*),(.*)$/is.exec(body);
  if (!m) throw new Error('unreadable data: URL — ' + CLOUD_FILE_HELP);
  const meta = m[1].split(';');
  const mimeType = meta[0] || 'application/octet-stream';
  let data;
  if (meta.some((p) => p.toLowerCase() === 'base64')) {
    data = m[2].replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error(`the base64 for ${name} has characters base64 doesn't use (URL-safe -_ ? convert to +/)`);
  } else {
    let text;
    try {
      text = decodeURIComponent(m[2]);
    } catch {
      throw new Error(`the data: URL for ${name} has a broken %-escape — send it as base64`);
    }
    data = b64FromBytes(new TextEncoder().encode(text));
  }
  if (data.length * 0.75 > CLOUD_UPLOAD_MAX) throw new Error(tooBig(data.length * 0.75));
  return { name: name.replace(/[\\/]/g, '_'), mimeType, data };
}
function cloudIo(link) {
  return {
    async resolveFile(token) {
      if (/^data:/i.test(token)) return cloudDataFile(token);
      if (!/^https?:\/\//i.test(token)) throw new Error(`${token} is not a URL. ${CLOUD_FILE_HELP}`);
      let file;
      try {
        file = await cloudRequest(link, 'arm/download', { url: token });
      } catch (err) {
        const m = errMsg(err);
        if (/^Method not found/.test(m)) throw new Error("this Cloud Bridge can't download files for uploads yet (an older hub) — send the file as base64 instead");
        throw new Error(m);
      }
      if (!file || typeof file.data !== 'string' || typeof file.name !== 'string') throw new Error('Cloud Bridge sent back no file for ' + token);
      if (file.data.length * 0.75 > CLOUD_UPLOAD_MAX) throw new Error(tooBig(file.data.length * 0.75));
      return { name: file.name, mimeType: typeof file.mimeType === 'string' ? file.mimeType : 'application/octet-stream', data: file.data };
    },
  };
}

// fetch --out / net --har over the cloud: there is no disk here, so the hub
// keeps the file for an hour and answers with a link that opens only for the
// signed-in Cloud Bridge account (a HAR carries cookies). The AI app gets it as
// a resource_link it can read back with resources/read.
async function cloudKeep(link, path, mimeType, body, detail) {
  const name = String(path).split(/[\\/]/).pop() || 'download';
  let file;
  try {
    file = await cloudRequest(link, 'arm/file', { name, mimeType, ...body });
  } catch (err) {
    const m = errMsg(err);
    if (/^Method not found/.test(m)) throw new Error(`this Cloud Bridge can't keep files yet (an older hub), so ${name} wasn't saved — run the command without --out/--har: the result comes back here`);
    throw new Error(`${name} wasn't saved: ${m}`);
  }
  if (!file || typeof file.url !== 'string') throw new Error(`Cloud Bridge sent back no link for ${name}`);
  const kb = Math.max(1, Math.round((Number(file.size) || 0) / 1024));
  return [
    { type: 'text', text: `saved ${file.name || name} (${kb} KB, ${detail}) → ${file.url}\nThe link works for an hour, only for the user signed in to Cloud Bridge; resources/read on it returns the file to you.` },
    { type: 'resource_link', uri: file.url, name: file.name || name, mimeType: file.mimeType || mimeType, ...(Number.isFinite(file.size) ? { size: file.size } : {}), description: `${detail}; expires ${file.expiresAt || 'in an hour'}` },
  ];
}

// The user's Allow/Ask/Off rule for a command, as refusal text (null = allowed).
// Every command the arm runs goes through it — including the open/close/
// release it runs itself for fetch and doctor --fix.
function policyRefusal(link, name) {
  const rule = link.policy?.commands?.[name];
  if (rule === 'off') return `${name} is turned off for Cloud Bridge in the user's settings, nothing ran. Do the task without it, or ask the user to allow it.`;
  if (rule === 'ask') return `${name} needs the user's confirmation, which this extension version can't ask for yet, so nothing ran. Ask the user to set ${name} to Allow in Cloud Bridge settings.`;
  return null;
}
const errMsg = (err) => String(err?.message ?? err).replace(/^(Error:\s*)+/, '');

async function cloudMessage(link, s, data) {
  if (data === 'pong') {
    s._lastPong = Date.now();
    return;
  }
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    logLine('cloud: unreadable hub frame ignored');
    return;
  }
  if (!msg || typeof msg !== 'object') return;
  if (msg.method === 'arm/policy') {
    link.policy = { commands: {}, blockedDomains: [], ...(msg.params && typeof msg.params === 'object' ? msg.params : {}) };
    return;
  }
  if (msg.id === undefined || msg.id === null) return; // a notification this version doesn't know
  if (!msg.method && cloudPending.has(msg.id)) {
    const p = cloudPending.get(msg.id);
    cloudPending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(String(msg.error.message || 'Cloud Bridge refused the request')));
    else p.resolve(msg.result || {});
    return;
  }
  if (!msg.method) return; // an answer nobody waits for any more (timed out, or its socket closed)
  const reply = (body) => {
    try {
      s.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }));
    } catch {} // gone: the hub tells its caller the arm dropped
  };
  if (msg.method === 'tools/list') return reply({ result: { tools: CLOUD_TOOLS(link) } });
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params || {};
    let result;
    try {
      result = await cloudCall(link, name, args && typeof args === 'object' ? args : {});
    } catch (err) {
      result = cloudText(errMsg(err), true);
    }
    return reply({ result });
  }
  if (msg.method === 'ping') return reply({ result: {} });
  reply({ error: { code: -32601, message: 'Method not found: ' + msg.method } });
}

async function cloudCall(link, name, args) {
  if (name === 'chrome') return cloudLine(link, String(args.command ?? ''));
  if (name === 'chrome_batch') {
    const lines = (Array.isArray(args.lines) ? args.lines : []).map((l) => String(l).trim()).filter((l) => l && !l.startsWith('#'));
    if (!lines.length) return cloudText('chrome_batch needs lines, e.g. ["tabs", "snap <match>"].', true);
    const content = [];
    for (const [i, line] of lines.entries()) {
      const r = await cloudLine(link, line);
      content.push({ type: 'text', text: '$ ' + line }, ...r.content);
      if (r.isError) {
        if (i < lines.length - 1) content.push({ type: 'text', text: `stopped here: the ${lines.length - 1 - i} line(s) after it did not run` });
        return { content, isError: true };
      }
    }
    return { content, isError: false };
  }
  let argv;
  try {
    argv = globalThis.BridgeCommands.toolArgv(name, args);
  } catch (err) {
    return cloudText(errMsg(err), true);
  }
  if (argv) return cloudArgv(link, argv);
  return cloudText(`Unknown tool ${name}: this Chrome offers ${CLOUD_TOOLS(link).map((t) => t.name).join(', ')}. Call tools/list to refresh.`, true);
}

// One command line → MCP content, the way cli.mjs would run and print it.
async function cloudLine(link, line) {
  let split;
  try {
    split = globalThis.BridgeCommands.splitLine(line);
  } catch (err) {
    return cloudText(cloudWords(errMsg(err)), true);
  }
  const { profile, argv } = split;
  if (profile && profile !== PROFILE_NAME && !(PROFILE_ID && PROFILE_ID.startsWith(profile)))
    return cloudText(`--profile ${profile} is not this Chrome ("${PROFILE_NAME}"). Pick the Chrome with the tool's profile argument instead.`, true);
  return cloudArgv(link, argv);
}

async function cloudArgv(link, argv) {
  const C = globalThis.BridgeCommands;
  let parsed;
  try {
    if (!argv[0]) return cloudText('Empty command. Start with: tabs', true);
    const entry = C.lookup(argv[0]);
    if (!entry) return cloudText(`Unknown command: ${argv[0]}. Commands: ${C.REGISTRY.filter((c) => c.scope === 'browser').map((c) => c.name).join(', ')}.`, true);
    if (entry.scope !== 'browser') return cloudText(`${entry.name} manages the user's local chrome-bridge install; it isn't available through Cloud Bridge.`, true);
    // shot's <out> is a file on the CLI's disk; the cloud returns the image, so the name is optional.
    if (entry.name === 'shot' && argv[1] && (argv[2] === undefined || argv[2].startsWith('--'))) argv = [argv[0], argv[1], 'shot.png', ...argv.slice(2)];
    // Policy before parse: parse downloads upload files, and an Off command must not fetch anything.
    const early = policyRefusal(link, entry.name);
    if (early) return cloudText(early, true);
    parsed = await C.parse(argv, cloudIo(link)); // no stdin or clipboard here: parse names the alternative
    // wait --js runs page code like eval, so eval's rule covers it too.
    const refused = parsed.name === 'wait' && parsed.msg.js ? policyRefusal(link, 'eval') : null;
    if (refused) return cloudText(refused, true);
  } catch (err) {
    return cloudText(cloudWords(errMsg(err)), true);
  }
  if (parsed.name === 'fetch') return cloudFetch(link, parsed);
  const reply = await runCommand(link, { ...parsed.msg, deadlineAt: cloudDeadline(parsed.msg) });
  const warnings = C.replyWarnings(reply);
  if (!reply.ok) return cloudText([String(reply.error), ...warnings].join('\n'), true);
  if (parsed.name === 'doctor') {
    // The extension answers {rows, stale}; server.mjs flattens that into the
    // rows render() and cli.mjs expect (one profile here, so no profile tags).
    const { rows = [], stale = [] } = reply.result || {};
    reply.result = [...rows, ...(stale.length ? [{ staleMemory: stale, pruned: !!parsed.msg.fix }] : [])];
  }
  if (parsed.name === 'doctor' && parsed.msg.fix) {
    // cli.mjs's doctor --fix: one release per residue row, never a driven tab.
    for (const row of reply.result) {
      if (row.driven || row.error || row.staleMemory) continue;
      if (!(row.grouped || row.status || row.emulated || row.debugger)) continue;
      const refused = policyRefusal(link, 'release');
      const r = refused ? { ok: false, error: refused } : await runCommand(link, { type: 'release', urlMatch: 'id:' + row.id });
      row.fixed = r.ok ? 'released' : 'release failed: ' + r.error;
    }
  }
  if (parsed.name === 'net' && parsed.view?.har) {
    const { lines, har } = reply.result || {};
    const text = { type: 'text', text: [String(lines ?? ''), ...warnings].join('\n') };
    if (!har?.log) return { content: [text, { type: 'text', text: 'the extension returned no HAR for this capture' }], isError: true };
    try {
      const kept = await cloudKeep(link, parsed.view.har, 'application/json', { text: JSON.stringify(har, null, 1) }, `HAR 1.2, ${har.log.entries.length} entries — contains cookies/tokens: treat it as a secret`);
      return { content: [text, ...kept], isError: false };
    } catch (err) {
      return { content: [text, { type: 'text', text: errMsg(err) }], isError: true };
    }
  }
  if (parsed.name === 'shot') {
    const result = reply.result;
    const note = result && typeof result === 'object' ? result.note : null;
    const dataUrl = String(note ? result.data : result);
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
    const content = [{ type: 'image', data: m ? m[2] : dataUrl, mimeType: m ? m[1] : 'image/png' }];
    const text = [note, ...warnings].filter(Boolean).join('\n');
    if (text) content.unshift({ type: 'text', text });
    return { content, isError: false };
  }
  let out;
  try {
    out = C.render(parsed, reply.result);
  } catch (err) {
    return cloudText(errMsg(err), true);
  }
  return cloudText([out.text, ...out.warnings, ...warnings].join('\n'));
}

// cli.mjs's fetch: no matching tab → a scratch tab on the target's origin
// (fetching from an unrelated tab is cross-origin and dies on CORS).
async function cloudFetch(link, parsed) {
  const C = globalThis.BridgeCommands;
  const { urlMatch: match, url } = parsed.msg;
  const { keep, host, outFile } = parsed.view;
  const notes = [];
  let res = await runCommand(link, { ...parsed.msg });
  if (!res.ok && String(res.error).includes('no tab matching') && !String(res.error).includes('in any connected profile')) {
    const refused = policyRefusal(link, 'open') || (keep ? null : policyRefusal(link, 'close'));
    if (refused) return cloudText(`${res.error}\nA scratch tab on ${host} would need it: ${refused}`, true);
    notes.push(`no tab matching "${match}" — opened a scratch tab on ${host} for this fetch${keep ? ' (kept open)' : ''}`);
    const opened = await runCommand(link, { type: 'open', url });
    if (!opened.ok) return cloudText(String(opened.error), true);
    res = await runCommand(link, { ...parsed.msg, urlMatch: `id:${opened.result.id}` });
    if (!keep) await runCommand(link, { type: 'close', urlMatch: `id:${opened.result.id}` });
  }
  const warnings = C.replyWarnings(res);
  if (!res.ok) return cloudText([...notes, String(res.error), ...warnings].join('\n'), true);
  const r = res.result;
  if (r.binary && !outFile) return cloudText([...notes, `binary response (${r.ct || 'unknown type'}) — save it: fetch <match> <url> --out <name> (you get a download link)`, ...warnings].join('\n'), true);
  if (/text\/html/i.test(r.ct || '')) notes.push(`⚠ response is HTML, not the JSON you likely wanted — an unmatched dev-proxy route serves the SPA shell; check the path (status ${r.status})`);
  if (outFile) {
    const mime = String(r.ct || '').split(';')[0].trim() || (r.binary ? 'application/octet-stream' : 'text/plain');
    const pre = notes.length ? [{ type: 'text', text: notes.join('\n') }] : [];
    const post = warnings.length ? [{ type: 'text', text: warnings.join('\n') }] : [];
    try {
      const kept = await cloudKeep(link, outFile, mime, r.binary ? { data: r.body || '' } : { text: r.body || '' }, `${r.status} ${r.ct || ''}${r.truncated ? ' — page capped the body at 512KB' : ''}`.trim());
      return { content: [...pre, ...kept, ...post], isError: false };
    } catch (err) {
      return { content: [...pre, { type: 'text', text: errMsg(err) }, ...post], isError: true };
    }
  }
  const cap = 50_000;
  const body = r.body || '';
  const shown = body.length > cap ? body.slice(0, cap) + `\n… body truncated at ${cap} chars — fetch a narrower URL` : body || '(empty body)';
  return cloudText([...notes, `${r.status} ${r.ct || ''}${r.truncated ? ' (page capped the body at 512KB)' : ''}`, shown, ...warnings].join('\n'));
}

// Pairing (device code): /pair/start → the user approves the code in a tab →
// /pair/poll hands over the arm token. The pending pairing lives in storage,
// so a service worker that dies mid-pairing resumes polling on its next wake
// (keepalive alarm, popup).
function cloudState() {
  const p = cloudCfg.pairing;
  return {
    hub: cloudCfg.hub, paired: !!cloudCfg.token, enabled: !!cloudCfg.enabled, connected: linkOpen('cloud'), profile: PROFILE_NAME,
    pairing: p ? { code: p.code, verificationUri: p.verificationUri, expires: p.expires } : null, notice: cloudCfg.notice || '',
  };
}
// Signing out tells the hub too, so AI apps stop listing this profile (before,
// off → on left a second "poplar" there, offline forever). The hub can't
// replace a record by name (20 profile names, so two profiles can share one):
// a token the hub didn't confirm stays in cloudCfg.unrevoked and is retried on
// the keepalive alarm and on the next pairing until the hub answers.
async function cloudRevoke(hub, token) {
  if (!hub || !token) return true;
  try {
    const res = await fetch(new URL('/arm/revoke', hub).href, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}
let cloudRevoking = false;
async function cloudRevokePending() {
  if (cloudRevoking || !cloudCfg.unrevoked?.length) return;
  cloudRevoking = true;
  try {
    const batch = cloudCfg.unrevoked;
    const left = [];
    for (const t of batch) if (!(await cloudRevoke(t.hub, t.token))) left.push(t);
    // Entries added while these were in flight (cloudForget saves a NEW array) stay too.
    const tried = new Set(batch);
    await saveCloud({ unrevoked: [...left, ...(cloudCfg.unrevoked || []).filter((t) => !tried.has(t))] });
  } finally {
    cloudRevoking = false;
  }
}
// The hub answers every 20s "ping" with "pong". None for 70s: the socket is dead
// without having closed (calls on it hung until the hub's 120s timeout — found
// live with ChatGPT). Close it so onclose redials.
const CLOUD_PONG_STALE_MS = 70000;
function cloudHeartbeatCheck(now = Date.now()) {
  const s = links.get('cloud')?.socket;
  if (!s || s.readyState !== WebSocket.OPEN || !s._lastPong || now - s._lastPong <= CLOUD_PONG_STALE_MS) return;
  logLine('cloud: no heartbeat from the hub for ' + Math.round((now - s._lastPong) / 1000) + 's — reconnecting');
  try {
    s.close();
  } catch {}
}
// Detach before closing: the hub's own 4401 for this socket must not read as
// "the hub forgot this profile" (cloudUnpaired) while we're the ones leaving.
function cloudDrop() {
  const link = links.get('cloud');
  const s = link.socket;
  link.socket = null;
  try {
    s?.close();
  } catch {}
}
// Forget this profile's token here; tell its hub (now, or until it answers).
async function cloudForget(patch) {
  const { hub, token } = cloudCfg;
  cloudDrop();
  await saveCloud({ ...patch, token: '', enabled: false });
  if (await cloudRevoke(hub, token)) return true;
  if (hub && token) await saveCloud({ unrevoked: [...(cloudCfg.unrevoked || []), { hub, token }].slice(-5) });
  logLine('cloud: signed out here, but ' + hub + ' was unreachable — the sign-out there is retried until it answers');
  return false;
}
async function cloudSignOut() {
  if (await cloudForget({ pairing: null, notice: '' })) return { ok: true, ...cloudState() };
  return { ok: true, ...cloudState(), notice: "Signed out here. Cloud Bridge couldn't be reached, so AI apps may list this profile until it can be; chrome-bridge keeps trying." };
}
async function hubPost(hub, path, body) {
  const res = await fetch(new URL(path, hub).href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function cloudPair(hubInput) {
  let hub;
  try {
    // No fallback to the stored hub: an empty address must not pair with a
    // hub the user just chose not to use (found by review).
    hub = new URL(String(hubInput || ''));
    if (!/^https?:$/.test(hub.protocol)) throw new Error('scheme');
  } catch {
    return { ok: false, error: 'Enter the Cloud Bridge hub URL, e.g. https://cloud-bridge.<you>.workers.dev' };
  }
  // Only a hub that answered becomes this profile's hub: a typo must not
  // point the current token at another host.
  const { status, body } = await hubPost(hub.origin, '/pair/start', { kind: 'chrome', name: PROFILE_NAME });
  if (!body.code) return { ok: false, error: body.message || `The hub answered ${status}. Check the URL.` };
  // The previous token's record goes (now or on a later retry), or AI apps would list this profile twice.
  cloudForget({}).then(() => cloudRevokePending());
  await saveCloud({ hub: hub.origin, token: '', enabled: false, notice: '', pairing: { code: body.code, pollToken: body.pollToken, verificationUri: body.verificationUri, interval: body.interval || 3, expires: Date.now() + (body.expiresIn || 600) * 1000 } });
  chrome.tabs.create({ url: body.verificationUri }).catch(() => {});
  cloudPollPairing();
  return { ok: true, ...cloudState() };
}
let cloudPolling = false;
async function cloudPollPairing() {
  if (cloudPolling || !cloudCfg.pairing) return;
  cloudPolling = true;
  try {
    while (cloudCfg.pairing && Date.now() < cloudCfg.pairing.expires) {
      await new Promise((r) => setTimeout(r, cloudCfg.pairing.interval * 1000));
      const p = cloudCfg.pairing;
      if (!p) return;
      let reply;
      try {
        reply = await hubPost(cloudCfg.hub, '/pair/poll', { code: p.code, pollToken: p.pollToken });
      } catch {
        continue; // hub unreachable for a moment: keep polling until the code expires
      }
      if (cloudCfg.pairing !== p) return; // cancelled or restarted meanwhile
      if (reply.body.status === 'pending') continue;
      if (reply.body.status === 'approved' && reply.body.armToken) {
        await saveCloud({ token: reply.body.armToken, enabled: true, pairing: null, notice: '' });
        logLine('cloud: paired with ' + cloudCfg.hub);
        connect(links.get('cloud'));
        return;
      }
      await saveCloud({ pairing: null, notice: reply.body.message || 'Pairing ended. Start again.' });
      return;
    }
    if (cloudCfg.pairing) await saveCloud({ pairing: null, notice: 'The pairing code expired. Start again.' });
  } finally {
    cloudPolling = false;
  }
}

// Wait for the profile id before the first dial — otherwise this connect
// races the storage read and the seat is held with extId=null until the next
// SW cycle (days, on a healthy server). Reconnects run after idReady settled.
// Watchdog: a WEDGED storage read (profile corruption) must not keep the
// bridge offline forever — connect idless (the anon seat) and say so. Only
// when the timer WON: logging from the timer itself fired on every healthy
// boot too, 5s after the id had loaded — a false wedge in every swlogs.
Promise.race([
  Promise.all([idReady, installReady, cloudReady, localReady]),
  new Promise((r) => setTimeout(() => r('wedged'), 5000)),
]).then((won) => {
  if (won === 'wedged') logLine('profile-id storage read wedged (5s) — connecting without a stable id');
  localLoaded = true; // a wedged read keeps the default: on
  for (const link of links.values()) connect(link);
  cloudPollPairing();
});

// Keep the service worker (and its WebSockets) alive; re-dial every link
// that dropped. Chrome floors sub-30s alarm periods to 30s (and warns) — ask
// for 0.5 outright.
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  cloudHeartbeatCheck();
  for (const link of links.values()) if (!linkOpen(link.id)) connect(link);
  cloudPollPairing();
  cloudRevokePending();
});

// --- Driven-tab marking -----------------------------------------------------
// Tabs the bridge touches get a gradient frame + corner tag in-page and a
// shared "🟣 Bridge" tab group, so the user can see at a glance what's being
// driven. `release` undoes all of it.
const drivenTabs = new Set();
// tabId -> id of the link whose command marked it (see Links and
// assertLinkMayDrive). Set when a command claims a tab, dropped on release.
const tabOwner = new Map();

// The human's ⏏ reclaim, ENFORCED: tabId → reclaim time. Without this the
// next command in the agent's loop re-marks a ⏏-released tab within seconds
// (findTab auto-marks every match) — the reclaim was visible but not
// durable, and from the human's seat "nobody noticed". findTab refuses every
// command on a reclaimed tab except an explicit `mark` (the deliberate
// re-claim, which clears the flag) and `release` (cleanup — it keeps the
// flag, so an agent can't bypass the gate by releasing). No time-based lapse:
// a 60s expiry let a polling agent silently re-drive a tab the human took
// back — the gate now holds until `mark` says the human handed it back.
// Persisted like tabActivity: an SW restart used to wipe the flag and let the
// agent's next command re-drive a tab the human had taken back — the veto
// outlived its worker only by luck (the heartbeat keeps the SW warm while the
// bridge runs, but a crash or an update kills it mid-gate).
const humanReclaimed = new Map();
const ownershipSeq = new Map();

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
  // The viewport frame starts invisible: it lights up only while a command is
  // in flight (pillInject toggles opacity) — a peripheral "the agent is acting
  // RIGHT NOW" signal — while the pill carries identity + history and idle
  // tabs stay clean. pointer-events: none, covers nothing. The frame is four
  // gradient edge-stripes (a CSS border can't hold a gradient, and
  // border-image can't transition — the opacity fade keeps the on/off from
  // snapping at command boundaries); the stops chain violet→indigo→cyan
  // continuously around the perimeter, matching the pill's own gradient.
  d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;opacity:0;transition:opacity .15s ease;' +
    'background:' +
    'linear-gradient(90deg,#7c3aed,#4f46e5,#0e7490) 0 0/100% 3px no-repeat,' +
    'linear-gradient(180deg,#0e7490,#4f46e5,#7c3aed) 100% 0/3px 100% no-repeat,' +
    'linear-gradient(90deg,#0e7490,#4f46e5,#7c3aed) 0 100%/100% 3px no-repeat,' +
    'linear-gradient(180deg,#7c3aed,#4f46e5,#0e7490) 0 0/3px 100% no-repeat';
  // The pill lives in a shadow root, not the light DOM: innerText/textContent
  // never cross a shadow boundary, so `document.body.innerText` (eval, agent
  // scripts) stops scraping the pill's own narration — on an unrendered page
  // the pill was the ONLY body text and eval returned it as the result (#57).
  // OPEN mode: pillInject/flashReleased run in whatever world the tab's refs
  // live in (MAIN on CSP-fallback tabs) and must reach in via .shadowRoot — a
  // closed root's saved reference wouldn't cross worlds. The page could still
  // reach in too, but it could already remove the host outright; the ⏏ guard
  // is isTrusted, not DOM obscurity. Bonus: page CSS resets can't clobber us.
  const shadow = d.attachShadow({ mode: 'open' });
  const pill = document.createElement('div');
  // The gradient stops stay dark enough that white 12px text keeps passing
  // WCAG AA (violet #7c3aed ≈ 6.6:1, indigo #4f46e5 ≈ 6.9:1, cyan #0e7490 ≈
  // 5.2:1 — a lighter cyan would drop under 4.5:1) — the pill's whole job is
  // being read at a glance. system-ui matches the OS face (SF/Segoe) next to
  // native Chrome UI.
  pill.style.cssText =
    'position:fixed;bottom:8px;right:8px;background:linear-gradient(135deg,#7c3aed,#4f46e5,#0e7490);color:#fff;font:12px system-ui,sans-serif;padding:3px 10px;border-radius:11px;pointer-events:auto;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.4);user-select:none;display:flex;align-items:center;gap:6px';
  // The pill is the product's trust surface — make it reachable and announced
  // for keyboard/screen-reader users (this tool's own pitch is an a11y tree).
  // role=GROUP, not button: the ⏏/✕ spans are role=button children, and a
  // button inside a button hides the children from some screen readers — a
  // group exposes all three controls. tabIndex + Enter/Space stay: the pill
  // body still opens the history panel for keyboard users.
  pill.setAttribute('role', 'group');
  pill.tabIndex = 0;
  pill.setAttribute('aria-label', 'An AI agent is driving this tab (chrome-bridge) — press Enter for action history');
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
    if (shadow.querySelector('#bridge-log')) {
      shadow.querySelector('#bridge-log').remove();
      return;
    }
    const p = document.createElement('pre');
    p.id = 'bridge-log';
    // Keyboard-reachable (tabIndex + role=log so it scrolls and announces),
    // Esc closes — the panel was Enter-openable but never focusable before.
    p.tabIndex = 0;
    p.setAttribute('role', 'log');
    p.style.cssText =
      'position:fixed;bottom:36px;right:8px;width:380px;max-width:calc(100vw - 16px);max-height:50vh;overflow:auto;margin:0;background:rgba(24,12,40,.94);color:#e9d5ff;font:11px/1.6 monospace;padding:8px 10px;border-radius:8px;pointer-events:auto;white-space:pre-wrap;box-shadow:0 2px 12px rgba(0,0,0,.5)';
    p.textContent = pill.dataset.log || '(no activity yet)';
    p.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        p.remove();
      }
    });
    shadow.appendChild(p);
    p.focus();
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
  off.title = 'disconnect the agent from this tab — it stays released until deliberately re-marked';
  off.setAttribute('role', 'button');
  off.tabIndex = 0;
  off.setAttribute('aria-label', 'disconnect the agent from this tab');
  off.style.opacity = '.75';
  const selfRelease = (e) => {
    if (!e.isTrusted) return; // synthetic — page JS can't fake trusted input
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'self-release' }).catch(() => {
      // The worker is mid-reload (extreload/update) — the release died with
      // it. A dead click that changes nothing reads as broken; say so in
      // place. The new worker's boot catch-up re-asserts the pill on the
      // still-driven tab within seconds, resetting this label.
      label.textContent = '🟣 ⚠ bridge reloading — click ⏏ again in a moment';
    });
  };
  off.onclick = selfRelease;
  off.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') selfRelease(e); // Enter/Space only — Tab must keep moving focus (any-key released on keydown, found by review)
  };
  // Order: label, ⏏ release, ✕ hide LAST — the toast/notification convention
  // (dismiss is always the terminal control; Material chips, macOS banners).
  pill.append(label, off, x);
  shadow.appendChild(pill);
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
  const pill = banner?.shadowRoot?.querySelector('div');
  if (!pill) return;
  banner.dataset.fading = '1';
  banner.style.opacity = '0';
  // Honest about in-flight work: a synthetic type loop already dispatched
  // page-side keeps running to its end — the README says so, the pill must
  // not claim otherwise at the exact moment it matters.
  pill.firstChild.textContent = '🟣 ✓ released — yours again (a running action may still finish)';
  pill.title = 'released';
  pill.style.pointerEvents = 'none';
  banner.shadowRoot.querySelector('#bridge-log')?.remove();
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
// lights the viewport frame for the duration of the command. (target is
// vestigial — every @eN in label/lines resolves, not just the command's own.)
function pillInject(label, lines, target, active) {
  const banner = document.getElementById('bridge-banner');
  // Sentinels let the SW tell a page-deleted pill (rebuild it — a page or SPA
  // re-render can wipe #bridge-banner mid-session) from the user's ✕ hide
  // (respect it — bridgeHide is set only by the ✕ handler).
  if (!banner) return document.documentElement.dataset.bridgeHide === '1' ? 'hid' : 'gone';
  const pill = banner.shadowRoot?.querySelector('div');
  if (!pill) return;
  banner.style.opacity = active ? '1' : '0';
  // Every @eN — in the current label AND the 30-line history ring — resolves
  // to the element's own name: the ring is the human-readable record, and raw
  // refs are agent-speak. Refs live in this world's window.__bridgeRefs (they
  // persist across snaps in the same document); a dead ref (navigated away,
  // nameless element) stays as @eN.
  const refName = (r) => {
    const el = window.__bridgeRefs?.[r.slice(1)];
    const name = String(el?.getAttribute('aria-label') || el?.innerText || el?.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    return name ? '"' + name + '"' : r;
  };
  label = label.replace(/@e\d+/g, refName);
  lines = lines.map((l) => l.replace(/@e\d+/g, refName));
  pill.firstChild.textContent = '🟣 ' + label;
  const log = lines.join('\n');
  pill.dataset.log = log;
  // Fixed short hint naming all three affordances — a 30-line native tooltip
  // doesn't scroll and duplicates the click-to-open panel that holds the log.
  pill.title = 'AI is driving this tab — click for history · ⏏ releases · ✕ hides';
  const p = banner.shadowRoot?.querySelector('#bridge-log');
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
// tabId -> the in-flight command's 'ing…' label. restoreBanner and the
// reconnect restore repaint THIS (not 'AI idle') while a command is still
// running — a shot's banner window used to blink the pill idle mid-command.
const pillBusy = new Map();
// tabId -> chain of pill writes. Pill-bound executeScripts land whenever
// Chrome runs them: a tick fired just before its command ended used to land
// AFTER the idle reset, freezing its '… 5s' label on the pill forever (#41).
// Every narration write rides one per-tab chain so the last write SCHEDULED
// is the last to LAND. Fire-and-forget like every narration (executeScript
// can pend forever on an uncommitted navigation — never await this in a
// command path).
const pillQ = new Map();
function pillWrite(tabId, args, world) {
  const nav = navSeq.get(tabId) || 0;
  const ownership = ownershipSeq.get(tabId) || 0;
  const current = () => drivenTabs.has(tabId) && (navSeq.get(tabId) || 0) === nav && (ownershipSeq.get(tabId) || 0) === ownership;
  const document = chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: () => null })
    .then((result) => result?.[0]?.documentId).catch(() => null);
  const run = (pillQ.get(tabId) || Promise.resolve()).then(async () => {
    if (!current()) return;
    const documentId = await document;
    if (!documentId || !current()) return;
    const target = { tabId, documentIds: [documentId] };
    const inj = { target, func: pillInject, args };
    if (world) inj.world = world;
    const result = await chrome.scripting.executeScript(inj);
    if (current()) await revivePill(tabId, result, args, target, current);
  }).catch(() => {});
  const tail = run.catch(() => {});
  pillQ.set(tabId, tail);
  tail.then(() => pillQ.get(tabId) === tail && pillQ.delete(tabId)); // self-pruning, groupChain-style
  return run;
}
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
// chrome.debugger protocol errors surface with the JSON envelope AS the
// message ('Error: {"code":-32602,"message":"No dialog is showing"}') — the
// agent read the envelope instead of the cause (log-mining find).
const errText = (e) => {
  const s = String(e?.message || e);
  const m = /^(?:Error: )?\{"code":-\d+,"message":"((?:[^"\\]|\\.)*)"/.exec(s.trim());
  return m ? m[1].replace(/\\"/g, '"') : s;
};
const wrapErr = (err) => {
  const s = errText(err);
  // Case-SENSITIVE on Chrome's raw shape ("No tab with id: 123."): findTab's
  // own curated "no tab with id:… — re-copy it from the toolbar popup" must
  // survive untouched (the /i version ate it — surfaced in single-profile CI,
  // where commands skip the server's multi-profile probe and hit this path).
  if (/No tab with id: \d|The frame was removed/.test(s)) return 'the tab was closed (or navigated) mid-command — run tabs to re-find it';
  if (/Cannot access contents of/i.test(s)) return 'that page is off-limits to extensions (chrome://, Web Store, PDF) — pick another tab';
  // runEval already names the wedge case (http tab with a dead debugger);
  // what lands here is a tab genuinely ON another extension's page.
  if (/Cannot access a chrome-extension:\/\/ URL/.test(s)) return "that tab shows another extension's page — Chrome blocks cross-extension scripting; pick another tab";
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
      if (!inflight.get(tabId) || !currentActivity(tabId, msg)) return stopTick(tabId);
      const args = [`${ing}… ${Math.round((Date.now() - t0) / 1000)}s`, tabActivity.get(tabId) || [], msg.target || null, true];
      pillWrite(tabId, args, 'MAIN');
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
async function revivePill(tabId, res, args, target, current) {
  if (res?.[0]?.result !== 'gone') return;
  if (!current() || bannerSuppressed.has(tabId)) return;
  await chrome.scripting.executeScript({ target, func: injectBanner });
  if (!current() || bannerSuppressed.has(tabId)) return;
  await chrome.scripting.executeScript({ target, func: pillInject, args, world: 'MAIN' });
}

function currentActivity(tabId, msg) {
  return msg._pill && drivenTabs.has(tabId) && msg._pillNav === (navSeq.get(tabId) || 0) && msg._pillOwnership === (ownershipSeq.get(tabId) || 0);
}

function recordActivity(tabId, msg) {
  const { ing, done } = activityPhrases(msg);
  const lines = pushActivity(tabId, done);
  pillSeq.set(tabId, (pillSeq.get(tabId) || 0) + 1);
  msg._pill = true; // onmessage's finally decrements inflight only for commands that recorded
  msg._pillNav = navSeq.get(tabId) || 0;
  msg._pillOwnership = ownershipSeq.get(tabId) || 0;
  inflight.set(tabId, (inflight.get(tabId) || 0) + 1);
  pillBusy.set(tabId, ing + '…'); // what restoreBanner/reconnect repaints while a command runs
  startTick(tabId, msg, Date.now());
  // Refs live in the MAIN world (snap runs there) — inject there or the pill
  // falls back to raw '@e4' agent-speak.
  pillWrite(tabId, [ing + '…', lines, msg.target || null, true], 'MAIN');
}

// One-line command summary for the pill, in human words: present-continuous
// while the command runs ("taking screenshot…"), past tense for the tooltip
// history ring. The user glances at the tab to see what the agent is doing
// RIGHT NOW — agent-speak like "click @e4" doesn't answer that.
// Adding a command? EIGHT registries stay in sync (a missing one fails SILENTLY):
// cli.mjs USAGE · extension/commands.js REGISTRY + parse() (or cli.mjs run() for the
// commands the CLI handles itself) · server.mjs CLI_LINES · server.mjs route() (only if it
// needs special routing) · background.js handle() · ACT_VERBS (pill narration) · MUTATING.
const ACT_VERBS = {
  open: ['opening page', 'opened page'],
  navigate: ['opening page', 'opened page'],
  close: ['closing tab', 'closed tab'],
  mark: ['marking tab', 'marked tab'],
  release: ['releasing tab', 'released tab'],
  activate: ['activating tab', 'activated tab'],
  snap: ['reading page', 'read page'],
  shot: ['taking screenshot', 'took screenshot'],
  click: ['clicking', 'clicked'],
  drag: ['dragging', 'dragged'],
  dialog: ['answering a dialog', 'answered a dialog'],
  fill: ['filling in', 'filled in'],
  clear: ['clearing', 'cleared'],
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
  perf: ['measuring CPU', 'measured CPU'],
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
  // --pixel-change has no selector/text detail — bare 'waiting for' told the
  // human nothing about the longest watch the bridge runs.
  if (msg.type === 'wait' && msg.pixel) return { ing: 'watching for pixel changes', done: 'saw pixels change' };
  if (msg.type === 'wait' && msg.js) return { ing: 'waiting for a page condition', done: 'saw the page condition' };
  if (msg.type === 'emulate' && msg.focus) return { ing: 'emulating focus', done: 'emulated focus' };
  let v = ACT_VERBS[msg.type] || [msg.type, msg.type];
  // dialog's --text answer stays OUT of the pill, mirroring the server's
  // summarize() redaction — a prompt answer can be a password or a 2FA code,
  // and the pill is page DOM anyone reading the screen can see.
  const detail = msg.target || msg.key || msg.selector || msg.find || (msg.type === 'dialog' ? '' : msg.text) || msg.question || msg.url || '';
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
          chrome.scripting
            .executeScript({ target: { tabId }, func: faviconInject, args: [null] })
            .catch(() => journal('favicon-stuck', tabId, 'restore failed twice — heals on next navigation'));
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
  journal('mark', tabId);
  persist();
  // Toolbar badge on EVERY driven tab: on non-injectable pages (chrome://,
  // Web Store, PDF) the pill, the group and the favicon stamp ALL fail, and
  // the tab used to carry zero human-visible markers while the agent drove
  // it — this is the one marker that works everywhere (chrome.action needs
  // no injection). Survives navigations, cleared in releaseTab.
  chrome.action.setBadgeText({ tabId, text: '•' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#7c3aed' }).catch(() => {}); // solid-only API — the gradient's violet anchor
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
  ownershipSeq.set(tabId, (ownershipSeq.get(tabId) || 0) + 1);
  if (opts.flash) humanReclaimed.set(tabId, Date.now());
  drivenTabs.delete(tabId);
  tabOwner.delete(tabId);
  // null, not '': an empty per-tab value would hide the global badge (the
  // Cloud Bridge pairing code) on this tab for the rest of its life (review).
  chrome.action.setBadgeText({ tabId, text: null }).catch(() => {}); // the everywhere-marker (markTab) — restore it everywhere too
  // The human's ⏏ (flash) also cuts a live net capture short — the same
  // detached/wake handshake onDetach uses: the capture reports "cut short"
  // and detaches NOW instead of sleeping out its --dur on a tab it no
  // longer drives. An agent/CLI release leaves captures alone (old
  // behavior): the agent owns that timing.
  if (opts.flash) {
    const c = netCollectors.get(tabId);
    if (c) {
      c.detached = true;
      c.wake?.();
    }
  }
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
  // A leaked debugger refcount with no emulation is the one residue class
  // doctor --fix couldn't clear (the release path cleaned every marker but
  // the attached session; only a tab close freed it). Detach it, serialized
  // behind any in-flight CDP sibling. No-op on the common balanced path —
  // and a live capture is not "leaked": its own finally detaches.
  if (cdpRefs.has(tabId) && !emulatedTabs.has(tabId)) await withCdp(tabId, () => detachDbg(tabId)).catch(() => {});
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
  journal('release', tabId, opts.flash ? 'pill ⏏' : '');
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
    tabActivity.delete(tabId);
    pillBusy.delete(tabId);
    failedSinceOk.delete(tabId);
    stopTick(tabId);
    persist();
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
    // New document: re-arm the error tap now, not at the next command, so errors in between are counted.
    chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pageErrorTap, args: [false] }).catch(() => {});
    const emoji = tabStatus.get(tabId);
    if (emoji) {
      chrome.scripting
        .executeScript({ target: { tabId }, func: faviconInject, args: [emoji] })
        .catch(() => {});
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (drivenTabs.has(tabId)) journal('tab-closed', tabId, 'driven tab closed');
  drivenTabs.delete(tabId);
  tabOwner.delete(tabId);
  tabStatus.delete(tabId);
  tabActivity.delete(tabId);
  pillSeq.delete(tabId);
  inflight.delete(tabId);
  pillBusy.delete(tabId);
  pillQ.delete(tabId); // the chain self-prunes; this just doesn't wait for it
  humanWaits.delete(tabId);
  humanReclaimed.delete(tabId);
  ownershipSeq.delete(tabId);
  navSeq.delete(tabId);
  dbgSince.delete(tabId);
  markInflight.delete(tabId); // a mark whose injectBanner pends forever (uncommitted nav) never self-prunes
  failedSinceOk.delete(tabId);
  cdpRefs.delete(tabId); // debugger auto-detaches on close
  cdpQ.delete(tabId);
  emulatedTabs.delete(tabId);
  emulatedDsf.delete(tabId); // the pin died with the tab (declared below — listeners run post-eval)
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
  emulatedDsf.delete(oldTabId); // same lifetime as the override — must not follow the id (stale dpr for shot)
  tabActivity.delete(oldTabId);
  pillBusy.delete(oldTabId);
  for (const m of [failedSinceOk, shotBaselines, humanReclaimed, tabOwner]) {
    if (m.has(oldTabId)) {
      m.set(newTabId, m.get(oldTabId));
      m.delete(oldTabId);
      persist(); // a reclaimed tab is NOT driven — the persist below would skip it, and the moved veto would die with the next SW restart
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
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (['diagnostics', 'bridge-state', 'release-active', 'local-toggle', 'cloud-state', 'cloud-pair', 'cloud-toggle', 'cloud-unpair'].includes(msg?.type) &&
      (sender?.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html') || sender.tab)) {
    sendResponse({ ok: false, error: msg.type === 'diagnostics' ? 'Logging settings are restricted to the popup.' : 'Tab controls are restricted to the popup.' });
    return;
  }
  if (msg?.type?.startsWith?.('cloud-')) {
    const cloud = links.get('cloud');
    Promise.all([cloudReady, idReady])
      .then(async () => {
        if (msg.type === 'cloud-pair') return cloudPair(msg.hub);
        if (msg.type === 'cloud-toggle') {
          if (!cloudCfg.token) return { ok: false, error: 'Connect this profile first: paste your Cloud Bridge address, then Connect.', ...cloudState() };
          await saveCloud({ enabled: !!msg.enabled, notice: '' });
          if (msg.enabled) connect(cloud);
          else cloud.socket?.close();
        }
        if (msg.type === 'cloud-unpair') return cloudSignOut();
        cloudPollPairing(); // a pairing the worker forgot while it slept
        return { ok: true, ...cloudState() };
      })
      .then(sendResponse, (error) => sendResponse({ ok: false, error: 'Could not reach the hub: ' + errMsg(error), ...cloudState() }));
    return true;
  }
  if (msg?.type === 'local-toggle') {
    Promise.all([ready, localReady])
      .then(async () => {
        const local = links.get('local');
        localOn = !!msg.enabled;
        localLoaded = true;
        if (localOn) {
          await chrome.storage.local.set({ localAgents: true }).catch(() => {});
          if (!linkOpen('local')) connect(local);
          return { ok: true, local: true, released: 0 };
        }
        // Off, in this order (found by review): stop serving first — tell
        // the server why this profile is leaving (its "not connected" errors
        // name the switch), hang up, and every local claim now refuses
        // (assertLinkOn) — THEN hand back every tab a local agent drives, so
        // no pill says an AI is working when none can reach it. A command
        // that marked mid-sweep is caught by the next pass.
        linkSend('local', JSON.stringify({ type: 'event', kind: 'local-off' }));
        local.socket?.close();
        await chrome.storage.local.set({ localAgents: false }).catch(() => {});
        let released = 0;
        for (let pass = 0; pass < 3; pass++) {
          const mine = [...drivenTabs].filter((tabId) => ownerOf(tabId) === 'local');
          if (!mine.length) break;
          for (const tabId of mine) {
            try {
              await releaseTab(tabId, { flash: true });
              released++;
            } catch {}
          }
        }
        persist();
        logLine(`local AI agents switched off in the popup — released ${released} tab(s), local link down`);
        return { ok: true, local: false, released };
      })
      .then(sendResponse, (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (msg?.type === 'diagnostics') {
    Promise.resolve().then(() => requestDiagnostics(msg)).then(sendResponse, (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (msg?.type === 'self-release' && sender?.tab?.id != null) {
    logLine('self-release tab ' + sender.tab.id + ' (pill ⏏ — human)');
    // Wait for hydration like every command does: this click may be the very
    // event that woke a dead worker — releasing against the still-empty maps
    // would no-op, then hydration + the catch-up would resurrect everything
    // (found by review). On a live worker `ready` is already settled.
    // The event goes to the link that drove the tab — its agent is the one
    // whose next command the reclaim refuses. Read the owner before
    // releaseTab forgets it.
    let owner = 'local';
    ready
      .then(() => {
        owner = ownerOf(sender.tab.id) || 'local';
        return releaseTab(sender.tab.id, { flash: true });
      })
      .then(() => {
        // The reclaim is enforced, not just narrated: findTab refuses every
        // later command on this tab until a deliberate `mark` re-claim.
        humanReclaimed.set(sender.tab.id, Date.now());
        persist(); // the veto must survive an SW restart — see the map's comment
        // Tell the agent's feed (watch/history): the human took the tab back.
        // Without this the next command silently re-marks and nobody noticed.
        linkSend(owner, JSON.stringify({ type: 'event', kind: 'self-release', tabId: sender.tab.id, url: sender.tab.url || '' }));
      })
      .catch(() => {});
    return;
  }
  // The popup's surfaces — the one reclaim path that works even when a driven
  // tab can't show the pill (chrome://, Web Store, PDF). Popup-originated
  // messages have no sender.tab; extension pages are the trusted context.
  if (msg?.type === 'bridge-state') {
    // connected: THIS profile's own local socket — the popup's "Ready"
    // must not ride /health's any-seat flag (another profile's live seat says
    // nothing about this one).
    // profile: the popup shows it and puts it in the copied tab reference —
    // the human never sees the code name anywhere else.
    // cloud: the Settings → Cloud Bridge state rides along (no second round trip).
    // local: the Local AI agents switch.
    Promise.all([ready, idReady, cloudReady, localReady]).then(() => ({ count: drivenTabs.size, active: msg.tabId != null && drivenTabs.has(msg.tabId), connected: linkOpen('local'), local: localOn, profile: PROFILE_NAME, cloud: cloudState() }))
      .then(sendResponse, (error) => sendResponse({ error: String(error) }));
    return true;
  }
  if (msg?.type === 'release-active' && msg.tabId != null) {
    // The popup's ⏏ is the same human reclaim as the pill's — arm the same
    // sticky gate, or an agent mid-loop re-marks the tab seconds after the
    // human stopped it from the one surface that always exists.
    ready
      .then(() => releaseTab(msg.tabId, { flash: true }))
      .then(() => {
        humanReclaimed.set(msg.tabId, Date.now());
        persist();
        return { count: drivenTabs.size };
      })
      .then(sendResponse, (error) => sendResponse({ error: String(error) }));
    return true;
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
    // A FAILED detach on a live tab leaves the debugger attached and the
    // infobar up with no state anywhere — doctor couldn't see it (only a tab
    // close freed it). Re-enter the refcount at 0: entry present = doctor's
    // debugger row lights and doctor --fix retries the detach; 0 = no owner.
    if (await chrome.tabs.get(tabId).catch(() => null)) cdpRefs.set(tabId, 0); // a dead tab needs no tracking — Chrome auto-detached
  }
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
  if (cdpRefs.delete(src.tabId) || emulatedTabs.has(src.tabId)) {
    logLine('dbg DETACHED EXTERNALLY ' + src.tabId);
    journal('dbg-external-detach', src.tabId);
  }
  emulatedTabs.delete(src.tabId);
  // The DSF override must die with the session too — otherwise shot's dpr math
  // keeps reading a pin that no longer applies (stale after an infobar cancel
  // or a foreign-DevTools detach). Memory-only, so no hydration catch-up
  // below: nothing of it is restored from storage.session.
  emulatedDsf.delete(src.tabId);
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
              ? // The 65s budget starts at ENQUEUE — a command that queued 60s
                // behind a long wait --pixel-change dies mid-work, and 'stuck
                // (dropped callback?)' sent the agent down a debugger-wedge
                // theory when the truth was budget arithmetic. Name both.
                'CDP command timed out in flight — its 65s budget includes time queued behind a long CDP command on this tab (wait --pixel-change?); a dropped callback is the other cause. The queue advanced; check the tab before retrying'
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

// The common CDP shape: queue, attach, run, detach — with the detach in a
// finally that only runs when the attach SUCCEEDED. The hand-copied
// attach/try/finally at every site had the detach run after a FAILED attach
// too (the attach had already rolled its own share back): the extra detach
// reached a real chrome.debugger.detach, failed, and re-entered the refcount
// at 0 — a permanent phantom debugger row in doctor. Site-specific cleanup
// (restoreBanner, flags) stays in each fn's own try/finally.
const withDbg = (tabId, fn) =>
  withCdp(tabId, async () => {
    await attachDbg(tabId);
    try {
      return await fn();
    } finally {
      await detachDbg(tabId);
    }
  });

// --- Device emulation (CDP) -------------------------------------------------
// DevTools-device-toolbar behavior without resizing the window. Attaches
// chrome.debugger (shows the "debugging this browser" infobar while active);
// `unemulate` clears and detaches. Survives navigations while attached.
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const emulatedTabs = new Set();
const emulatedDsf = new Map(); // tabId -> live DSF override — shot's dpr math (see setEmulation)

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
      humanReclaimed: Object.fromEntries(humanReclaimed),
      tabOwner: Object.fromEntries(tabOwner),
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
    // Watchdog: a wedged storage.session read (profile corruption) used to
    // hang EVERY command to the server's 70s cap with a "may have run" lie —
    // proceed with empty maps (the fresh-profile path) and say so in swlogs.
    const s = await Promise.race([
      chrome.storage.session.get(['drivenTabs', 'emulatedTabs', 'tabStatus', 'tabActivity', 'tabOwner', 'humanReclaimed', 'swLogs']),
      new Promise((r) => setTimeout(() => r(null), 5000)),
    ]);
    if (s === null) logLine('storage.session read wedged (5s) — starting with empty state');
    for (const id of s?.drivenTabs || []) drivenTabs.add(id);
    for (const id of s?.emulatedTabs || []) emulatedTabs.add(id);
    for (const [k, v] of Object.entries(s?.tabStatus || {})) tabStatus.set(Number(k), v);
    for (const [k, v] of Object.entries(s?.humanReclaimed || {})) humanReclaimed.set(Number(k), v);
    for (const [k, v] of Object.entries(s?.tabOwner || {})) tabOwner.set(Number(k), v);
    // The dead worker's log tail rides along — this worker's own lines (the
    // 'background vX loaded' marker) stay newest at the end.
    swLogs.unshift(...(s?.swLogs || []));
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
    for (const id of [...humanReclaimed.keys()]) if (!live.has(id)) humanReclaimed.delete(id);
    for (const id of [...tabOwner.keys()]) if (!live.has(id) || !drivenTabs.has(id)) tabOwner.delete(id);
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
    chrome.scripting
      .executeScript({ target: { tabId: id }, func: injectBanner, args: [true] })
      // Then reset the label — restoreBanner's two-call pattern: the dead
      // worker's last pillInject left the IN-FLIGHT label up with the gradient
      // frame lit ('clicking "Submit"… 14s', or a dead handoff's '🙋 your
      // turn'), and injectBanner early-returns on the same-version banner —
      // without this reset the "agent is acting RIGHT NOW" signal stays lit
      // on a worker that isn't running anything.
      .then(() => pillWrite(id, [idleLabel(id), tabActivity.get(id) || [], null, false]))
      .catch(() => {});
    if (tabStatus.get(id)) setFavicon(id, tabStatus.get(id));
  }
  persist(); // the ⏳ resets above became durable only now

  // Boot reconciliation — the REAP direction only (re-deriving driven state
  // FROM group membership was removed on purpose: the group is not a source
  // of truth, 5655484). A tab in a 🟣 Bridge group that hydration did NOT
  // restore as driven belongs to a dead session (extension reload / browser
  // restart wipe storage.session; Chrome keeps the group): nothing will ever
  // release it, so its markers are residue. Full release path + a journal
  // line. A tab the user dragged into the group by hand gets swept too —
  // accepted: the bridge owns the 🟣 Bridge group.
  try {
    for (const g of await chrome.tabGroups.query({ title: '🟣 Bridge' })) {
      for (const t of await chrome.tabs.query({ groupId: g.id })) {
        if (drivenTabs.has(t.id)) continue;
        journal('reap', t.id, 'in 🟣 Bridge group with no driven state — dead-session residue');
        await releaseTab(t.id).catch(() => {});
      }
    }
  } catch {}
  journal('boot', null, `v${chrome.runtime.getManifest().version} driven=${drivenTabs.size}`);
})();


async function setEmulation(tabId, { width, height, mobile, focus, dsf }) {
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
      { width, height, deviceScaleFactor: dsf || (mobile ? 2 : 1), mobile: !!mobile }
    );
    // getLayoutMetrics reports a 1:1 visualViewport ratio under a DSF override
    // (found live: dsf=2 captures came out native-size, --max never
    // downsampling) — shot's dpr math consults this instead. Not persisted:
    // an SW restart forgets it and shot merely under-downsamples, never
    // miscrops.
    emulatedDsf.set(tabId, dsf || (mobile ? 2 : 1));
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
  emulatedDsf.delete(tabId);
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
    c.set(params.requestId, { t: Date.now(), wall: params.wallTime, method: params.request.method, url: params.request.url, type: params.type, init, req: params.request, initObj: params.initiator });
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
      if (textish && (forLine || forHar) && !(c.publicOnly && netOffLimits(r.url))) {
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

// publicOnly: the caller is a cloud link (see refuseOffLimitsTab).
async function captureNetwork(tabId, duration, filter, bodyFilter, har, ws, publicOnly = false) {
  await attachDbg(tabId);
  const c = new Map();
  c.publicOnly = publicOnly;
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
          if (r.lineBody)
            // #65: name the cut and the remedy — a body silently missing its
            // tail read as the whole list (the entries past 1500 chars looked
            // absent from the API).
            r.body =
              !b ? '(body unavailable)' :
              b.base64Encoded ? '(binary body)' :
              b.body.length > 1500 ? b.body.slice(0, 1500) + ` … ${b.body.length - 1500} chars more — full body: fetch <match> <url> --out <file>` : b.body;
        }
    await chrome.debugger.sendCommand({ tabId }, 'Network.disable').catch(() => {});
  } finally {
    netCollectors.delete(tabId);
    await detachDbg(tabId);
  }
  if (publicOnly) {
    // The page itself went there during the window: everything it loaded is its.
    const landed = [...c.values()].find((r) => r.type === 'Document' && offLimitsUrl(r.url));
    const now = await chrome.tabs.get(tabId).catch(() => null);
    const where = (landed && offLimitsUrl(landed.url)) || (now && tabOffLimits(now));
    if (where) throw offLimitsError(`the tab went to ${where} during the capture, which`, 'nothing from the capture comes back');
    for (const [id, r] of c) if (netOffLimits(r.url)) c.delete(id);
    c.wsFrames = c.wsFrames.filter((f) => !netOffLimits(f.url));
  }
  const lines = [];
  for (const r of c.values()) {
    if (filter && !r.url.includes(filter)) continue;
    let u;
    try {
      const p = new URL(r.url);
      // The path tells calls apart (.../{id}/items); the query can carry
      // tokens — cut the query first, never the path (#64: the id sat past
      // the old flat 100-char cut, and every {id} line read identical).
      const path = p.pathname.length > 200 ? p.pathname.slice(0, 197) + '…' : p.pathname;
      u = path.length + p.search.length > 200 ? path + '?' + p.search.slice(1, Math.max(1, 197 - path.length)) + '…' : path + p.search;
    } catch {
      u = r.url;
    }
    if (u.length > 200) u = u.slice(0, 197) + '…';
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
// These run through runEval (MAIN world, CDP fallback on a page-CSP EvalError).
// Refs from snap live in the page's `window.__bridgeRefs`; click/fill run
// through the same pipeline, so they resolve there too.

// roleOf/nameOf, shared by TWO consumers that must never drift apart: SNAP_SRC
// mints a ref's identity key from them, and DEEPQ's @ref resolution recomputes
// them to catch a stale ref — a virtualized list (LinkedIn messaging) reuses
// the NODE for a different row after a re-sort, and a ref resolved by node
// alone then silently acts on the wrong element and reports success.
const REFKEY_SRC = `
  const ROLE_BY_TAG = { A:'link', BUTTON:'button', SELECT:'combobox', TEXTAREA:'textbox', SUMMARY:'button',
    H1:'heading', H2:'heading', H3:'heading', H4:'heading', H5:'heading', H6:'heading',
    IMG:'img', NAV:'navigation', MAIN:'main', HEADER:'banner', FOOTER:'contentinfo', ASIDE:'complementary',
    FORM:'form', DIALOG:'dialog', TABLE:'table', UL:'list', OL:'list', LI:'listitem', LABEL:'label',
    IFRAME:'frame' };
  const INPUT_ROLE = { checkbox:'checkbox', radio:'radio', range:'slider', button:'button', submit:'button', reset:'button', search:'searchbox', file:'file' };
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
  // A cut name says so — a status line read as 'radio=t' instead of 'radio=two' looked complete.
  // The cut is mid-name: breadcrumb-style names differ at the END
  // ('JavaScript / Reference / … / Array.prototype.map()'), and a head-only
  // cut made every sibling read the same.
  const clip = (s) => (s.length > 60 ? s.slice(0, 40) + '…' + s.slice(-19) : s);
  function nameOf(el, role) {
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return clip(al.trim());
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\\s+/).map((id) => document.getElementById(id)?.textContent).filter(Boolean).join(' ').trim();
      if (t) return clip(t);
    }
    if (role === 'img') return el.alt || '';
    if (el.tagName === 'IFRAME') return (el.getAttribute('src') || '').slice(0, 60); // a cross-origin frame is otherwise a black hole in the tree
    // label for= / a wrapping label: the visible name real forms rely on —
    // without it a field read as its name attribute (textbox "n") and a select
    // as all its options. The control's own text is skipped, or a wrapped
    // select would name itself after its options again.
    if (el.labels && el.labels.length && el.tagName !== 'BUTTON') {
      let t = '';
      const walk = (n) => {
        if (n === el) return;
        if (n.nodeType === 3) t += n.textContent + ' ';
        else if (n.nodeType === 1 && !/^(SELECT|TEXTAREA|INPUT|BUTTON|SCRIPT|STYLE)$/.test(n.tagName)) n.childNodes.forEach(walk);
      };
      for (const l of el.labels) walk(l);
      t = t.replace(/\\s+/g, ' ').trim();
      if (t) return clip(t);
    }
    if (el.tagName === 'INPUT') return el.placeholder || el.name || '';
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) return clip(text);
    return clip((el.getAttribute('title') || '').trim());
  }
`;

const SNAP_SRC = (scope, diff, href, skel, nofold) => `(() => {
  const MAX = 300;
  // --skeleton: depth-limited map — past the cut, count instead of emit.
  const SKEL = ${skel ? 'true' : 'false'};
  const CUT = 3;
  // width-fold threshold: near the cap, skeleton mode stops WALKING further
  // children and counts them instead — a wide tree at/below the depth cut
  // used to blow past MAX and truncate exactly like the plain snap.
  const WCUT = MAX - 40;
  // Live caps: the modal-layer pass below walks with its own budget.
  let cap = MAX, wcut = WCUT;
  // Elements the walk reached (not cut, not truncated) — the modal-layer pass
  // skips them. Visited, not emitted: a role-less aria-modal host gets no
  // line of its own, yet its content was printed.
  const visited = new Set();
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
  // roleOf/nameOf/ROLE_BY_TAG/INPUT_ROLE arrive via the DEEPQ embed below
  // (REFKEY_SRC) — declared once there so snap's minting and DEEPQ's @ref
  // staleness recheck can never drift apart. (Never write a dollar-brace
  // interpolation inside a template's comment — it still interpolates.)
  const hidden = (el) => { const s = getComputedStyle(el); return s.display === 'none' || s.visibility === 'hidden'; };
  const hasBox = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  function stateOf(el, role, name) {
    const s = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
    if (el.checked || el.getAttribute('aria-checked') === 'true') s.push('checked');
    if (el.getAttribute('aria-expanded') === 'true') s.push('expanded');
    if (el.getAttribute('aria-expanded') === 'false') s.push('collapsed');
    if (el.getAttribute('aria-selected') === 'true' || el.selected) s.push('selected');
    // a modal blocks the page under it — the first thing to know about a dialog
    if (el.getAttribute('aria-modal') === 'true' || (el.tagName === 'DIALOG' && el.matches(':modal'))) s.push('modal');
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
    if (lines.length >= cap) { truncated = true; return 0; }
    // The bridge's own UI is not page content: the pill is a role=button
    // whose label mutates every command — it would mint a ref and own the
    // --diff output. Skip it (and the cursor/grid overlays) entirely.
    if (el.id === 'bridge-banner' || el.id === 'bridge-grid' || el.id === 'bridge-cursor') return 0;
    if (hidden(el)) return 0;
    visited.add(el);
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
      if (SKEL && lines.length >= wcut) { foldCnt += countLines(c); return; }
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
  // Same staleness rules as deepQuery: a detached scope node is gone (#47).
  const scopeRef = scopeSel?.startsWith('@') ? window.__bridgeRefs?.[scopeSel.slice(1)] : undefined;
  let root;
  if (!scopeSel) root = document.body;
  else if (scopeSel.startsWith('@')) root = scopeRef?.isConnected ? scopeRef : null;
  else {
    root = document.querySelector(scopeSel) || deepAll(scopeSel, document)[0];
    // #68: [role=dialog] can not match a NATIVE <dialog> — the role is
    // implicit, there is no attribute, and it is the first selector everyone
    // tries. Retry with the bare name as a tag selector ('[role=X]' → 'X,
    // [role=X]') so the natural scope just works.
    if (!root) {
      const m = scopeSel.match(/^\\[role=([\\w-]+)\\]$/);
      if (m) root = document.querySelector(m[1] + ', ' + scopeSel) || deepAll(m[1] + ', ' + scopeSel, document)[0];
    }
  }
  if (!root)
    throw new Error(
      'scope not found: ' + scopeSel +
      (scopeSel.startsWith('@')
        ? staleRefHint()
        : ' — no element matches (native elements carry implicit roles: [role=dialog] can not match a native <dialog>; try the tag: dialog, or snap unscoped and scope with @ref)')
    );
  walk(root, 0);
  if (truncated) lines.push('… truncated at ' + MAX + ' nodes' + (scopeSel ? '' : ' — scope with: snap <match> <css>'));
  // Modal layers are never lost to a cut: a visible open dialog / role=dialog
  // / alertdialog / aria-modal that the depth cut, the width fold or the MAX
  // truncation swallowed is appended with its own budget. Found live: BBC's
  // Sourcepoint consent dialog is portaled to the END of body, so --skeleton
  // folded it into a count while it blocked every click on the page.
  const layers = [];
  for (const d of deepAll('dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]', root)) {
    if (visited.has(d) || hidden(d) || !hasBox(d) || layers.some((p) => p.contains(d))) continue;
    layers.push(d);
  }
  let header = false;
  for (const d of layers.slice(0, 5)) {
    // an earlier layer's walk may have reached this one (nested across a shadow root / frame)
    if (visited.has(d)) continue;
    if (!header) { lines.push('(modal layer past the cut — shown anyway; drill: snap <match> @ref)'); header = true; }
    cap = lines.length + 60;
    wcut = cap - 20;
    truncated = false;
    walk(d, 0);
    if (truncated) lines.push('  … layer truncated — scope with: snap <match> @ref');
  }
  // --diff: lines added/changed/removed since the last snap at THIS scope.
  const store = (window.__bridgeSnapLines = window.__bridgeSnapLines || {});
  // Key by scope AND href mode: lines embed hrefs only in --href snaps, so a
  // shared key would report every link as changed when the flag is toggled.
  const skey = (scopeSel || '') + (${href ? 'true' : 'false'} ? '|href' : '') + (${skel ? 'true' : 'false'} ? '|skel' : '');
  const prev = store[skey] || null;
  // --diff with NO baseline at this scope (the --skeleton drill-down's first
  // diff, or a --diff on a never-snapped tab) used to print the full tree
  // unlabeled — the agent asked 'what changed' and got an unmarked everything.
  // Name the shape; the marker line carries no @eN ref so the store below
  // (and any later diff) never sees it.
  if (${diff ? 'true' : 'false'} && !prev) lines.unshift('(first snap at this scope — the full tree follows, not a diff; act, then snap --diff again)');
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
  // above is built from full lines, so --diff is unaffected. --no-fold (#67):
  // the summaries move refs to the END, out of document order, so a scripted
  // 'grep | tail -1' picked the wrong row — the flag keeps every line inline.
  // (The img elision note rides the lines array below the gate, so --no-fold keeps it.)
  if (skipped) lines.push('… ' + skipped + ' unnamed img/status elided (decorative — no name, no ref)');
  if (!${diff ? 'true' : 'false'} && !${nofold ? 'true' : 'false'}) {
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
        'position:absolute;left:-14px;top:-14px;width:28px;height:28px;border:3px solid rgba(124,58,237,.9);border-radius:50%;animation:bridge-ripple .6s ease-out forwards';
      c.appendChild(r);
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.style.filter = 'drop-shadow(0 1px 1px rgba(0,0,0,.4))';
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M3 1v16l3.9-3.7 2.3 5.5 2.8-1.2-2.4-5.4 5.6-.6z');
    p.setAttribute('fill', '#7c3aed');
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
  ${REFKEY_SRC}
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
    if (sel.startsWith('@')) {
      let refEl = window.__bridgeRefs?.[sel.slice(1)] || null;
      // A re-render (SPA poll, dialog unmount) detaches the node but leaves it
      // in the refs map until the next snap prunes it — acting on it measures
      // a 0x0 rect and misreads as 'covered by overlay' at 0,0, or dispatches
      // into the void (#47). Detached = gone.
      if (refEl && !refEl.isConnected) refEl = null;
      // A re-render can also hide-but-keep the old subtree (leave transitions,
      // keep-alive caches, v-show): the husk stays connected and identity-stable,
      // so it survives the prune — and click dispatches into the void at 0,0
      // behind a 'succeeded' verdict (#58). Mint only stamps nodes with a box
      // and no display/visibility:none, so not-rendered at resolve always means
      // the page changed under the ref. checkVisibility (not a 0x0-rect test)
      // so a scrolled-off content-visibility:auto element is NOT misread as dead.
      if (refEl && refEl.checkVisibility && !refEl.checkVisibility({ checkVisibilityCSS: true })) refEl = null;
      // A ref's identity is its snap-time role+name, not the node: a re-sorted
      // virtualized list (LinkedIn messaging) keeps the NODE alive but puts a
      // different row's content in it — acting on it reports success at the
      // WRONG element (a message to the wrong conversation). Recompute the
      // key and fail loudly toward a re-snap instead.
      if (refEl?.__bridgeRefKey) {
        const r = roleOf(refEl);
        const key = (r || 'container') + ' ' + nameOf(refEl, r);
        if (key !== refEl.__bridgeRefKey)
          throw new Error(sel + ' was "' + refEl.__bridgeRefKey + '" at snap time, now resolves to "' + key + '" — the DOM re-sorted or rewrote under the ref; re-snap and use fresh refs');
      }
      return refEl;
    }
    return document.querySelector(sel) || deepAll(sel, document)[0] || null;
  };
  // deepQuery + the canonical miss error in one place — every action script
  // embeds this; the '@' suffix teaches the recovery move. The hint splits on
  // WHY the ref is dead (#47): navigation destroys the page's refs map
  // entirely; an SPA re-render (poll refetch, dialog state change) kills the
  // node while the map lives — blaming navigation sends the agent looking for
  // a nav that never happened. A CSS miss gets the same hint style.
  const staleRefHint = () =>
    window.__bridgeRefs
      ? ' — the page re-rendered since the snap (this node is gone or hidden, no navigation happened); run snap again for fresh refs'
      : ' — refs expire on navigation; run snap again';
  const queryErr = (sel) => 'element not found: ' + sel + (sel.startsWith('@') ? staleRefHint() : ' — check the selector against a fresh snap');
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

// Modal-opened detection (#51): a click whose real result is a blocking
// dialog (LinkedIn InMail's 'Share your contact info?') reads as success —
// the app even clears its composer, and a later reload loses the draft for
// good. If a modal OPENED because of the click, say so before the agent
// assumes the action completed. Shadow-piercing via deepAll (LinkedIn modals
// live in shadow roots). Requires DEEPQ in scope; shared by the synthetic
// click and the --trusted path.
const MODAL_FUNCS = `
  const bridgeVisModals = () => deepAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]', document)
    .filter((m) => { const r = m.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const bridgeModalNote = (before) => {
    const mods = bridgeVisModals();
    if (mods.length <= before) return '';
    const txt = (mods[mods.length - 1].innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    return ' — a modal dialog opened as a result' + (txt ? ' ("' + txt + '")' : '') + ' — resolve it before assuming the action completed';
  };
`;
const MODAL_COUNT_SRC = `(() => { ${DEEPQ} ${MODAL_FUNCS} return bridgeVisModals().length; })()`;
const modalNoteSrc = (before) => `(async () => {
  ${DEEPQ}
  ${MODAL_FUNCS}
  // Give the dialog a beat to animate in (the synthetic path's effect wait
  // covers this there).
  await new Promise((r) => setTimeout(r, 400));
  return bridgeModalNote(${before});
})()`;

const clickSrc = (target, dbl) => `(async () => {
  ${DEEPQ}
  ${FRAME_SRC}
  ${MODAL_FUNCS}
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
  // Effect observation (#23): a synthetic click an app ignores is
  // indistinguishable from success AT DISPATCH (LinkedIn rows take --trusted
  // only) — but a real click almost always moves SOMETHING: a mutation near
  // the target (or a body-level portal), focus, value/checked, the URL.
  // Watch briefly and say when nothing did, naming the --trusted remedy.
  // Bridge UI traffic (cursor ripple teardown, pill ticker) is excluded.
  const f0 = document.activeElement, u0 = location.href, c0 = el.checked, v0 = el.value, m0 = bridgeVisModals().length;
  let mutated = false, navigating = false;
  const mo = new MutationObserver((ms) => {
    for (const m of ms) {
      if ([...m.addedNodes, ...m.removedNodes].some((n) => n.nodeType === 1 && /^(bridge-banner|bridge-cursor|bridge-grid)$/.test(n.id || ''))) continue;
      const t = m.target;
      // Ancestor class/style churn is ambient on SPA shells (Gmail's app
      // container mutates constantly, masking the no-op) — only attributes
      // ON/INSIDE the target count. Ceiling: a click whose SOLE effect is a
      // class toggle on an ancestor (theme switch on <html>) now warns.
      if (m.type === 'attributes' && !el.contains(t)) continue;
      if (el.contains(t) || t === document.body || t === document.documentElement || t.contains?.(el)) { mutated = true; break; }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  // A navigating click tears this context down mid-wait — answer first.
  // pagehide fires only at COMMIT: a form POST or link whose server answers
  // slowly (an OAuth consent → localhost callback) stays provisional far past
  // 350ms, and the old page read as 'no observable page effect … retry with
  // --trusted' — a double submit. The Navigation API's navigate event fires
  // when the navigation STARTS — synchronously inside a link's click dispatch,
  // so both listeners are armed BEFORE dispatching.
  let settle;
  const navSeen = new Promise((r) => { settle = r; });
  const nav = window.navigation;
  const started = (e) => { if (!e.destination?.sameDocument && !e.downloadRequest) gone(); };
  const unarm = () => { removeEventListener('pagehide', gone); nav?.removeEventListener('navigate', started); settle(); };
  const gone = () => { navigating = true; unarm(); };
  addEventListener('pagehide', gone, { once: true });
  nav?.addEventListener('navigate', started);
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
  setTimeout(unarm, 350);
  await navSeen;
  mo.disconnect();
  if (navigating) return 'clicked ' + sel${dbl ? ' (double)' : ''} + ' — page navigating';
  // The dispatch's own el.focus() must not count as the page effect — a dead
  // button read as clean 'clicked' purely because focus moved onto it (#50,
  // Gmail's Search button). Focus still counts when it lands ELSEWHERE (an
  // app handler ran) or when el takes text: there focus IS the click's job.
  const ae = document.activeElement;
  const focusEffect = ae !== f0 && (ae !== el || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  const effect = mutated || focusEffect || location.href !== u0 || el.checked !== c0 || el.value !== v0;
  return 'clicked ' + sel${dbl ? ' (double)' : ''} + (effect ? '' : ' — no observable page effect: the app may ignore synthetic clicks — retry with --trusted') + bridgeModalNote(m0);
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
  // #36: a fill can land in the DOM yet never enter the app's persistence
  // pipeline — Habr's autosave tracks its own input path, the draft looked
  // filled and died silently on reload. Flag the risky targets in the reply
  // so the agent knows to verify a save before leaving the page.
  const persistHint = el.isContentEditable
    ? ' — ⚠ rich-editor field: its autosave pipeline may not track a programmatic fill — confirm a save fired (net) before nav/close'
    : (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !el.closest('form')
      ? ' — ⚠ no <form> around this field: if the app autosaves, confirm a save fired (net) before nav/close'
      : '';
  return 'filled ' + sel + persistHint;
})()`;

// Empty a field (#34). Synthetic keys can't: select-all is a browser default
// they skip, and editor-owned models (Editor.js & co) decline synthetic
// Backspace and even execCommand('delete'). Order of attempts for
// contenteditable: real Selection + execCommand (the browser's editing
// pipeline — plain CE and cooperative editors take it); if the editor blocks
// it, DOM removal + an input event (mutation-observing editors — ProseMirror,
// Slate, Editor.js — reconcile their model from that).
const clearSrc = (target) => `(() => {
  ${DEEPQ}
  const sel = ${JSON.stringify(target)};
  const el = mustQuery(sel);
  el.scrollIntoView({ block: 'center' });
  el.focus?.();
  if (el.isContentEditable) {
    getSelection().selectAllChildren(el);
    let native = false;
    try { native = document.execCommand('delete') && !el.textContent; } catch (e) {}
    if (!native) el.replaceChildren();
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    return 'cleared ' + sel + (native ? '' : ' — the editor blocked the native delete; used DOM removal + input event (mutation-observing editors reconcile — verify with snap before trusting the model)');
  }
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    if (['checkbox', 'radio', 'file'].includes(el.type)) throw new Error('clear doesn\\'t apply to ' + el.type + ' inputs — click toggles, upload sets files');
    nativeSet(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'cleared ' + sel;
  }
  throw new Error('clear needs an input, textarea, or contenteditable — got <' + el.tagName.toLowerCase() + '>');
})()`;

// Per-char typing: real keydown/input/keyup per character, so autocomplete and
// keystroke-driven UIs react (fill sets the value in one shot and they don't).
const typeSrc = (target, text) => `(async () => {
  ${DEEPQ}
  const sel = ${JSON.stringify(target)}, text = ${JSON.stringify(text)};
  // In-flight guard (#32): a type whose reply was lost to a timeout KEEPS
  // RUNNING page-side — a retried second loop interleaves keystrokes with it
  // and both garble the payload. Refuse the overlap loudly.
  if (window.__bridgeTyping) throw new Error('another type is still running on this page (its reply was likely lost to a timeout) — readback with eval, wait for it to finish, then type only the remainder');
  window.__bridgeTyping = true;
  try {
  let el = mustQuery(sel);
  ${FILE_INPUT_GUARD}
  el.scrollIntoView({ block: 'center' });
  el.focus?.();
  for (const ch of text) {
    if (!el.isConnected) {
      // Frameworks swap the node under the caret mid-typing (Wikipedia Codex
      // on first keystroke; block editors rewrite the caret's block after
      // edits — #30). Follow the LIVE focus first, then the caret: on the
      // contenteditable path chars land at the selection wherever it sits
      // (execCommand inserts there), so a caret that survived the rewrite in
      // a fresh sibling node beats aborting and dropping the rest of the
      // payload.
      const a = document.activeElement;
      if ((a && /^(INPUT|TEXTAREA)$/.test(a.tagName)) || a?.isContentEditable) el = a;
      else {
        const an = window.getSelection()?.anchorNode;
        const ce = an && (an.nodeType === 1 ? an : an.parentElement)?.closest?.('[contenteditable]');
        if (ce) el = ce;
        else throw new Error('element detached mid-typing and neither focus nor the caret is in a text field — re-snap and retry the remaining text');
      }
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
    // HIDDEN tabs need neither the pacing (nobody's watching) nor EITHER
    // naive yield: chained setTimeout clamps to ~1s/char under background
    // throttling (a 300-char type runs 5 minutes — the amplifier behind
    // #29/#32), and a pure-microtask loop starves every other injection for
    // the whole payload. A MessageChannel hop is an unthrottled macrotask.
    await (document.visibilityState === 'hidden'
      ? new Promise((r) => { const mc = new MessageChannel(); mc.port1.onmessage = r; mc.port2.postMessage(0); })
      : new Promise((r) => setTimeout(r, Math.min(25, 15000 / text.length))));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
  const got = el.isContentEditable ? el.innerText : el.value;
  const warn = got !== undefined && !String(got).endsWith(text) ? ' — WARNING readback is ' + JSON.stringify(String(got).slice(0, 40)) + ' (framework rewrote the value; consider fill)' : '';
  return 'typed ' + text.length + ' chars into ' + sel + warn;
  } finally {
    window.__bridgeTyping = false;
  }
})()`;

// Real-paste semantics: editors that own their content model (Quill,
// ProseMirror, Reddit/LinkedIn rich composers) revert fill writes but accept
// pastes — they install 'paste' handlers that read clipboardData and convert.
// Chrome's ClipboardEvent constructor silently ignores the clipboardData init
// key, so the only way an editor can read our payload is a plain Event with a
// duck-typed clipboardData. No handler claiming it (no preventDefault) → land
// the text the way a native paste would: caret insertion for fields,
// execCommand for contentEditable.
const pasteSrc = (target, value, html) => `(async () => {
  ${DEEPQ}
  const sel = ${JSON.stringify(target || '')}, text = ${JSON.stringify(value)};
  const asHtml = ${html ? 'true' : 'false'};
  let el = document.activeElement;
  if (sel) {
    el = mustQuery(sel);
    el.scrollIntoView({ block: 'center' });
  }
  // Same iframe descent as trusted focus (#53): the caret can live in a
  // same-origin editor iframe while top-frame activeElement is the <iframe>.
  // Before any focus() — focusing the frame element resets its document's
  // activeElement to <body>.
  try { let inner; while (el && el.tagName === 'IFRAME' && el.contentDocument && (inner = el.contentDocument.activeElement)) el = inner; } catch {}
  if (sel) el.focus?.();
  if (!el || !(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
    throw new Error('no text field focused — pass an @ref|css target or click the field first');
  if (el.tagName === 'INPUT' && ['checkbox', 'radio', 'file'].includes(el.type))
    throw new Error('not a text field: <input type=' + el.type + '>');
  // --html (#31): real web copy-paste carries BOTH flavors and block editors
  // (Notion/vc.ru-style, Quill, ProseMirror) parse text/html into native
  // blocks — a whole article in one event instead of type-per-paragraph.
  // Plain fallback for handlers that read only text/plain: tag-stripped via
  // a scratch div (detached — scripts in the payload never run).
  const plain = asHtml ? (() => { const d = document.createElement('div'); d.innerHTML = text; return d.innerText; })() : text;
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  ev.clipboardData = { types: asHtml ? ['text/html', 'text/plain'] : ['text/plain'], getData: (t) => (t === 'text/html' ? (asHtml ? text : null) : plain) };
  const handled = !el.dispatchEvent(ev);
  if (!handled) {
    if (el.isContentEditable) {
      el.ownerDocument.execCommand(asHtml ? 'insertHTML' : 'insertText', false, text); // deprecated, still the only CE path that fires beforeinput correctly
    } else {
      const start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? start;
      nativeSet(el, el.value.slice(0, start) + plain + el.value.slice(end));
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: plain }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  return 'pasted ' + text.length + ' chars' + (asHtml ? ' (html)' : '') + ' into ' + (sel || '<' + el.tagName.toLowerCase() + '>') + (handled ? ' (editor paste handler)' : '');
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
// Picks cap at 8: uncapped, Nano listed 160-220 lines of a page in live logs — an 8KB "shortlist" that took 30s+.
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
      '? Reply with ONLY the refs (@eN) of at most 8 best matches, best first, comma-separated. If none match, reply none.'
    );
    const picked = [];
    for (const m of out.matchAll(/e(\\d+)/g)) {
      const ref = '@e' + m[1];
      const line = lines.find((l) => l.includes(ref + ' ') || l.trimEnd().endsWith(ref));
      if (line && !picked.includes(line)) picked.push(line);
    }
    let tail = listed < lines.length ? ' (tree capped at 48KB — scope the snap to reach the rest)' : '';
    if (picked.length > 8) tail += ' (' + (picked.length - 8) + ' weaker picks dropped — narrow the query or scope the snap)';
    // The 300-node snap cap drops the tail of big pages before Nano ever sees
    // them — without this note, 'no matches' reads as 'not on the page' when
    // the truth is 'not reached'. (The truncation line itself has no @eN ref,
    // so the lines filter above already removed it from the listing.)
    if (tree.includes('truncated at')) tail += ' (tree truncated at 300 nodes — the target may be past the cut; scope: snap <match> <css>)';
    if (!picked.length) return 'no matches in ' + listed + ' ref lines — nano said: ' + out.slice(0, 120) + tail;
    return picked.slice(0, 8).map((l) => l.trim()).join('\\n') +
      '\\n(' + listed + ' ref lines scanned · nano pre-filter — verify before acting)' + tail;
  } finally {
    session.destroy();
  }
})()`;

// measure/grid: small evals that used to live in the CLI as page-JS strings
// with a `label` back-channel for the pill — they're commands, so the source
// lives here with every other page script and ACT_VERBS carries the label.
const measureSrc = (sel) =>
  `JSON.stringify((()=>{${DEEPQ}const s=${JSON.stringify(sel)};return s.startsWith('@') ? [mustQuery(s)] : deepAll(s, document);})().map(e=>{const r=e.getBoundingClientRect();const c=getComputedStyle(e);return{text:(e.textContent||'').trim().slice(0,30),x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),display:c.display,alignItems:c.alignItems,justifyContent:c.justifyContent,textAlign:c.textAlign,gap:c.gap,padding:c.padding,margin:c.margin,border:c.border||(c.borderWidth+' '+c.borderStyle+' '+c.borderColor),radius:c.borderRadius,bg:c.backgroundColor,color:c.color,font:c.fontSize+'/'+c.fontWeight,family:c.fontFamily}}))`;
const GRID_SRC = `(()=>{const g=document.getElementById('bridge-grid');if(g){g.remove();return 'grid off'}const d=document.createElement('div');d.id='bridge-grid';d.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none;background-image:repeating-linear-gradient(0deg,rgba(255,0,0,.25) 0 1px,transparent 1px 8px),repeating-linear-gradient(90deg,rgba(255,0,0,.25) 0 1px,transparent 1px 8px)';document.body.appendChild(d);return 'grid on'})()`;

// perf: running animations grouped by what they animate. Anything but
// transform/opacity/filter re-runs style+layout+paint on the main thread every
// frame — the usual answer to "idle page, busy CPU". The bridge's own UI
// (#bridge-*) is left out so the pill's fade doesn't show up as a finding.
const PERF_PAGE_SRC = `JSON.stringify((() => {
  const COMPOSITED = new Set(['transform', 'opacity', 'filter', 'translate', 'scale', 'rotate']);
  const SKIP = new Set(['offset', 'computedOffset', 'easing', 'composite']);
  const kebab = (p) => p.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  const groups = {};
  for (const a of document.getAnimations()) {
    if (a.playState !== 'running') continue;
    const t = a.effect && a.effect.target;
    if (t && t.closest && t.closest('[id^="bridge-"]')) continue;
    const props = [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k)).filter((p) => !SKIP.has(p)).map(kebab))];
    const key = props.join(',') || '(none)';
    const g = (groups[key] ||= { n: 0, onScreen: 0, composited: props.every((p) => COMPOSITED.has(p)) });
    g.n++;
    const r = t && t.getBoundingClientRect();
    if (r && r.width && r.height && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) g.onScreen++;
  }
  return { visibility: document.visibilityState, groups };
})())`;

const fmtBytes = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB');

// CDP Performance counters diffed over a window + the animation audit above.
// ProcessTime/ThreadTime are CPU seconds (whole renderer process / main
// thread); the *Duration counters are main-thread seconds per category, so
// "other" is mostly paint, GC and compile. The GPU process is out of CDP's
// reach — a compositor-heavy page reads low here.
async function capturePerf(tabId, duration) {
  const ms = Math.min(duration || 5000, 30000);
  const metrics = async () =>
    Object.fromEntries((await chrome.debugger.sendCommand({ tabId }, 'Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const [a, b] = await withDbg(tabId, async () => {
    await chrome.debugger.sendCommand({ tabId }, 'Performance.enable');
    try {
      const first = await metrics();
      await new Promise((r) => setTimeout(r, ms));
      return [first, await metrics()];
    } finally {
      await chrome.debugger.sendCommand({ tabId }, 'Performance.disable').catch(() => {});
    }
  });
  const page = JSON.parse(await runEval(tabId, PERF_PAGE_SRC));
  const secs = b.Timestamp - a.Timestamp;
  const d = (k) => (k in a && k in b ? b[k] - a[k] : null);
  const pct = (k) => (d(k) == null ? '?' : Math.round((100 * d(k)) / secs) + '%');
  const rate = (k) => (d(k) == null ? '?' : Math.round(d(k) / secs) + '/s');
  const other = d('TaskDuration') - d('ScriptDuration') - d('RecalcStyleDuration') - d('LayoutDuration');
  const anims = Object.entries(page.groups).sort((x, y) => y[1].n - x[1].n);
  const total = anims.reduce((s, [, g]) => s + g.n, 0);
  const lines = [];
  if (page.visibility !== 'visible')
    lines.push("⚠ tab is hidden — Chrome throttles hidden tabs, so these numbers don't describe the visible page. activate <match> (or drag the tab into its own window) and re-run.");
  lines.push(
    `perf ${secs.toFixed(1)}s · ${page.visibility}`,
    `cpu     renderer ${pct('ProcessTime')} · main thread ${pct('ThreadTime')}  (% of one core)`,
    `main    busy ${pct('TaskDuration')} — script ${pct('ScriptDuration')} · style ${pct('RecalcStyleDuration')} · layout ${pct('LayoutDuration')} · other ${Math.round((100 * other) / secs)}%`,
    `rate    style recalcs ${rate('RecalcStyleCount')} · layouts ${rate('LayoutCount')}`,
    `mem     heap ${fmtBytes(b.JSHeapUsedSize)} · nodes ${b.Nodes}`,
    `anims   ${total} running${total ? ' — ' : ''}${anims
      .map(([k, g]) => `${k} ×${g.n} (${g.onScreen} on screen)${g.composited ? '' : ' ⚠ not composited'}`)
      .join(' · ')}`
  );
  return lines.join('\n');
}

// --- page-error tap ----------------------------------------------------------
// Every driven tab carries a light MAIN-world tap (console.error + uncaught
// errors/rejections) so each command's reply names the errors that are NEW
// since the previous command — the eval → console --clear → eval loop was 20%
// of all real traffic. Injected as a func (not eval'd source): strict-CSP pages
// must not drag every command onto the CDP fallback. drain=false only installs.
function pageErrorTap(drain) {
  let s = window.__bridgeErrs;
  if (!s || typeof s !== 'object') {
    s = window.__bridgeErrs = { n: 0, seen: 0, ring: [] };
    const fmt = (a) => {
      try {
        return typeof a === 'string' ? a : a instanceof Error ? String(a) : JSON.stringify(a);
      } catch {
        return String(a);
      }
    };
    const push = (kind, args) => {
      s.n++;
      s.ring.push((kind + ' ' + args.map(fmt).join(' ')).replace(/\s+/g, ' ').slice(0, 300));
      if (s.ring.length > 20) s.ring.shift();
    };
    const orig = console.error;
    console.error = function (...a) {
      push('error', a);
      return orig.apply(this, a);
    };
    addEventListener('error', (e) => e.message && push('pageerror', [e.message]));
    addEventListener('unhandledrejection', (e) => push('unhandledrejection', [e.reason instanceof Error ? String(e.reason) : fmt(e.reason)]));
    return null;
  }
  if (!drain) return null;
  const fresh = Number(s.n) - Number(s.seen);
  s.seen = s.n;
  if (!(fresh > 0)) return null;
  return { count: fresh, lines: Array.from(s.ring || []).slice(-Math.min(fresh, 5)).map((l) => String(l).slice(0, 300)) };
}

// Commands that read the log themselves, give the tab up, or only narrate.
const NO_ERROR_TAP = new Set(['console', 'close', 'release', 'mark', 'note']);
async function pageErrorsFor(msg) {
  const tabId = msg._tabId;
  if (tabId == null || NO_ERROR_TAP.has(msg.type) || !drivenTabs.has(tabId)) return null;
  // Bounded: a dialog the command opened (or a mid-navigation document) pends
  // executeScript indefinitely — the reply must not wait on it.
  const read = chrome.scripting
    .executeScript({ target: { tabId }, world: 'MAIN', func: pageErrorTap, args: [true] })
    .then((r) => r?.[0]?.result || null, () => null);
  return Promise.race([read, new Promise((r) => setTimeout(() => r(null), 300))]);
}

// Console hook must run in the MAIN world — isolated worlds get their own console.
// Its first install seeds the buffer with what the error tap already caught,
// so the '⚠ N new page errors … console <match>' pointer never lands on an
// empty log; reading the console counts as seeing those errors.
const consoleSrc = (clear) => `(() => {
  if (!window.__bridgeLog) {
    const buf = (window.__bridgeLog = []);
    if (window.__bridgeErrs && Array.isArray(window.__bridgeErrs.ring)) for (const l of window.__bridgeErrs.ring) buf.push(String(l));
    const fmt = (a) => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } };
    const push = (kind, args) => { buf.push(kind + ' ' + Array.from(args).map(fmt).join(' ').slice(0, 300)); if (buf.length > 300) buf.shift(); };
    for (const k of ['error', 'warn', 'info', 'log']) {
      const orig = console[k];
      console[k] = function (...a) { push(k, a); return orig.apply(this, a); };
    }
    window.addEventListener('error', (e) => push('pageerror', [e.message]));
    window.addEventListener('unhandledrejection', (e) => push('unhandledrejection', [String(e.reason)]));
  }
  if (window.__bridgeErrs && typeof window.__bridgeErrs === 'object') window.__bridgeErrs.seen = window.__bridgeErrs.n;
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
// whose page origin is cap.clip.x. Viewport captures always frame the CURRENT
// viewport origin (clip.x === round(v.pageX), so the subtraction is ~0); the
// formula stays for capture modes with a real origin offset.
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
// pill); the ACTIVE gradient border renders as a phantom full-width band in
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
const restoreBanner = async (tabId, existed, respectHide) => {
  // Re-inject only if the banner existed before the capture window AND the
  // tab is still driven: the ✕ promise ("hidden until the next navigation")
  // must survive a shot, a chrome:// tab never had one, and a release that
  // landed mid-capture (release takes no CDP lock; parallel agent calls are
  // a supported pattern) must stick — restoring onto a released tab
  // resurrects the pill with no cleanup path left (found by the flow review).
  // The suppression flag ALWAYS clears — a stuck flag would silence the
  // onUpdated re-banner forever after.
  // respectHide: wait --pixel-change re-restores BETWEEN polls, while the
  // human can actually see (and ✕) the pill — honor a mid-watch hide.
  if (existed && drivenTabs.has(tabId)) {
    // A sibling command is still running (parallel calls are supported):
    // repaint its in-flight label, not a lying 'AI idle'.
    const busy = (inflight.get(tabId) || 0) > 0;
    await chrome.scripting.executeScript({ target: { tabId }, func: injectBanner, args: [!!respectHide] }).catch(() => {});
    pillWrite(tabId, [busy ? pillBusy.get(tabId) || idleLabel(tabId) : idleLabel(tabId), tabActivity.get(tabId) || [], null, busy]);
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
// A capture fired right after a navigation/redirect can read a
// half-composited surface (#25: a 2x2-tiled duplicate of the page). Two rAFs
// hand the compositor a full frame before we read it; the 300ms race covers
// background/occluded tabs where rAF never fires (CDP captures those fine).
// The eval can fail on non-HTML tabs (chrome://) — capture anyway.
const settleFrames = (tabId) =>
  runEval(tabId, 'new Promise((r) => { const t = setTimeout(r, 300); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(); })); })').catch(() => {});

// Downscale a capture in the SW. Page.captureScreenshot only scales via a
// captureBeyondViewport clip, and beyond-viewport emulation fires a spurious
// window resize ON THE PAGE — even at an unchanged, viewport-sized clip
// (found live: a default shot on a hidden tab resized 1456x844→1456x844;
// --max 0's plain capture did not). A resize-listening SPA remounts and loses
// its state (#52). Plain capture + canvas scale perturbs nothing, and
// waitPixel already proved the plain path byte-stable (5 captures, 1s apart,
// identical md5).
async function scaleCapture(b64, s, format, quality) {
  const bmp = await pngBitmap(b64);
  try {
    const oc = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * s)), Math.max(1, Math.round(bmp.height * s)));
    oc.getContext('2d').drawImage(bmp, 0, 0, oc.width, oc.height);
    const blob = await oc.convertToBlob({ type: format === 'jpeg' ? 'image/jpeg' : 'image/png', ...(quality != null ? { quality: quality / 100 } : {}) });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(bin);
  } finally {
    bmp.close();
  }
}

async function captureViewport(tabId, msg) {
  const params = { format: msg.format === 'jpeg' ? 'jpeg' : 'png' };
  if (params.format === 'jpeg') params.quality = msg.quality ?? 80;
  const m = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
  const v = m.cssVisualViewport;
  const dpr = emulatedDsf.get(tabId) || dprOf(m);
  const max = maxOf(msg);
  // Captures render at devicePixelRatio, so budget max/dpr CSS px to keep
  // the OUTPUT long edge <= max.
  const s = Math.min(msg.scale || 1, max / (Math.max(v.clientWidth, v.clientHeight) * dpr));
  // Remove the banner again RIGHT AT the capture: the markTab/banner
  // executeScripts are fire-and-forget and can land mid-capture (a first-ever
  // shot fires markTab from findTab and its injection queues behind grouping
  // round trips) — a caller's single removal at the start leaves a
  // several-round-trip window for the pill to sneak into the saved shot and
  // false-fire --diff. Enforcement at the capture is the only timing-proof
  // invariant (found live by the flow review; waitPixel used to do this at
  // every poll — now every capture does).
  await settleFrames(tabId);
  await removeBannerForCapture(tabId);
  // Plain capture ONLY (scale happens SW-side, see scaleCapture). A window
  // resize between diff shots surfaces as diffBmp's size-mismatch re-baseline
  // — the way waitPixel already handles it — instead of the old size pin,
  // which only a beyond-viewport clip could honor.
  const res = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', params);
  const b64 = s !== 1 ? await scaleCapture(res.data, s, params.format, params.quality) : res.data;
  return { b64, format: params.format, v, dpr, s, clip: { x: Math.round(v.pageX), y: Math.round(v.pageY), width: v.clientWidth, height: v.clientHeight, scale: s } };
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
  // inBanner must see THROUGH the pill's shadow root (closest() stops at the
  // boundary): a trusted click ON ⏏/✕ is the sanctioned escape hatch — if the
  // suppression window removed the banner it would remove the target (#57).
  return JSON.stringify({ cx: Math.round(cxTop), cy: Math.round(cyTop), inBanner: !!(el.closest('#bridge-banner') || el.getRootNode()?.host?.id === 'bridge-banner') });
})()`;

// Page-side focus for press/type: the key events go to whatever holds focus.
// The field requirement is key-aware (#46): type (no key) and text-editing
// keys (chars, Backspace/Delete/Insert) are a silent noop without a field —
// refuse. Dismissal/navigation keys (Escape closes a dialog, Enter activates
// the focused control, Tab moves focus) are meaningful on ANY focused
// element — dispatch to document.activeElement whatever it is.
const trustedFocusSrc = (target, key) => `(() => {
  ${DEEPQ}
  const sel = ${JSON.stringify(target || '')}, keyIn = ${JSON.stringify(key || '')};
  let el = sel ? deepQuery(sel) : (document.activeElement || document.body);
  if (sel) {
    if (!el) throw new Error(queryErr(sel));
    el.scrollIntoView({ block: 'center' });
  }
  // Apps like Slides/Docs keep the real caret inside a same-origin iframe's
  // contenteditable while top-frame activeElement is the <iframe> itself —
  // descend or text keys refuse a field that IS focused (CDP keys already
  // reach the focused frame; only this guard was wrong, #53). The descent
  // must come BEFORE any focus(): focusing an <iframe> whose document
  // already holds the caret resets its activeElement to <body> (verified
  // live), so the focus lands on the descended field, not the frame element.
  // Cross-origin frames throw on contentDocument — keep the iframe and let
  // the check fail.
  try { let inner; while (el.tagName === 'IFRAME' && el.contentDocument && (inner = el.contentDocument.activeElement)) el = inner; } catch {}
  if (sel) el.focus?.();
  const parts = keyIn.includes('+') && keyIn !== '+' ? keyIn.split('+') : [];
  const base = parts.length ? parts.pop() : keyIn;
  // A ctrl/alt/meta combo is a shortcut, never text entry — no field needed
  // (Shift alone still types: Shift+a = 'A').
  const shortcut = parts.some((m) => ['Control', 'Ctrl', 'Alt', 'Meta', 'Cmd', 'Command'].includes(m));
  const needsField = !keyIn || (!shortcut && (base.length === 1 || ['Backspace', 'Delete', 'Insert'].includes(base)));
  if (needsField && !(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
    throw new Error('no text field focused — pass an @ref|css target or click the field first' + (keyIn ? ' (only text-editing keys need a field; Escape/Enter/Tab/arrows dispatch to whatever holds focus)' : ''));
  return '<' + el.tagName.toLowerCase() + (el.isContentEditable ? ' contenteditable' : '') + '>';
})()`;

// SW-side CDP dispatch. Modifier combos keep press semantics: 'Control+k'
// sets the modifier bits on the k event, which is what app handlers match.
const CDP_KEYCODE = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Insert: 45, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32, Shift: 16, Control: 17, Alt: 18, Meta: 91, CapsLock: 20 };
// US-layout [VK, code, shiftBit] for printable punctuation: charCodeAt is NOT
// a Windows VK ('.' = 46 = VK_DELETE — a keyCode-filtering numeric input ate
// '.' as Delete and turned 1.62 into 162, #54). Shifted glyphs ride their
// base key with the shift bit, the way Puppeteer's layout table does.
const CDP_CHAR = {
  ' ': [32, 'Space'], '.': [190, 'Period'], ',': [188, 'Comma'], '-': [189, 'Minus'], '/': [191, 'Slash'],
  ';': [186, 'Semicolon'], '=': [187, 'Equal'], '[': [219, 'BracketLeft'], ']': [221, 'BracketRight'],
  "'": [222, 'Quote'], '`': [192, 'Backquote'], '\\': [220, 'Backslash'],
  '!': [49, 'Digit1', 8], '@': [50, 'Digit2', 8], '#': [51, 'Digit3', 8], '$': [52, 'Digit4', 8], '%': [53, 'Digit5', 8],
  '^': [54, 'Digit6', 8], '&': [55, 'Digit7', 8], '*': [56, 'Digit8', 8], '(': [57, 'Digit9', 8], ')': [48, 'Digit0', 8],
  '_': [189, 'Minus', 8], '+': [187, 'Equal', 8], ':': [186, 'Semicolon', 8], '<': [188, 'Comma', 8], '>': [190, 'Period', 8],
  '?': [191, 'Slash', 8], '~': [192, 'Backquote', 8], '{': [219, 'BracketLeft', 8], '}': [221, 'BracketRight', 8],
  '|': [220, 'Backslash', 8], '"': [222, 'Quote', 8],
};
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
  // Chars no US key produces (accented, CJK, emoji) get vk 0 — IME-style; the
  // text field still inserts them, and an invented keyCode is the #54 lie again.
  const chr = isChar ? CDP_CHAR[key] : null;
  const vk = isChar ? (chr ? chr[0] : /[a-z0-9]/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0) : CDP_KEYCODE[key] || 0;
  if (chr && chr[2]) bits |= chr[2];
  const base = {
    key,
    code: isChar ? (chr ? chr[1] : /[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : /[0-9]/.test(key) ? 'Digit' + key : '') : key,
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
  // Enter also needs `text` (DevTools/Puppeteer send '\r'): without it Blink
  // fires keydown/keyup but NO keypress and runs no default activation — an
  // implicit form submit (Gmail search) never happens and the app silently
  // ignores a 'real' Enter its keypress handler never saw (#50). Not with
  // Ctrl/Meta held: modified Enter is an accelerator, not text entry.
  const enterText = key === 'Enter' && (bits & (BITS.control | BITS.meta)) === 0;
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { ...base, type: 'keyDown', ...(isChar ? { text: key, unmodifiedText: key } : enterText ? { text: '\r', unmodifiedText: '\r' } : {}) });
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

async function trustedInput(tab, msg, beforeDispatch = () => {}) {
  // CDP Input.dispatch* on a hidden tab fires ZERO page events while the
  // command would still report success — and the coords trustedPointSrc
  // computes come from the hidden tab's stale layout, so a dispatch that does
  // land can hit an unrelated element (#33). Refuse loudly; the synthetic
  // path works fine on hidden tabs. Two hidden states, two remedies (#45):
  // hasFocus()=true + hidden = the Chrome WINDOW is fully covered by other
  // apps (macOS occlusion) — activate cannot un-occlude it, emulate focus can;
  // hasFocus()=false = a plain background tab — activate is the fix.
  const vis = await runEval(tab.id, 'document.visibilityState + "|" + document.hasFocus()').catch(() => null);
  if (vis === 'hidden|true')
    throw new Error('tab is hidden while its window has focus — the Chrome window is fully covered by other apps (macOS occlusion) or minimized; activate cannot un-occlude it. Use emulate <match> focus (flips visibilityState — trusted input then works), or drop --trusted (synthetic input works on hidden tabs)');
  if (vis?.startsWith('hidden'))
    throw new Error('tab is hidden — trusted (CDP) input reaches only the foreground tab: nothing would fire, and coordinates computed now are stale. activate <match> it first, or drop --trusted (synthetic input works on hidden tabs)');
  const point = (target, coverage, ripple) => runEval(tab.id, trustedPointSrc(target, coverage, ripple)).then((s) => JSON.parse(s));
  let res;
  // First-ever command on a fresh tab: let the in-flight auto-mark land
  // BEFORE the suppression window below, or its injectBanner can arrive
  // mid-dispatch and put the pill back under the coords.
  await awaitMark(tab.id);
  await withDbg(tab.id, async () => {
    beforeDispatch();
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
    let typing = false; // this command set the page's __bridgeTyping flag
    try {
      if (msg.type === 'click') {
        const p = await point(msg.target, true, true);
        if (!p.inBanner) suppression = await removeBannerForCapture(tab.id);
        const m0 = await runEval(tab.id, MODAL_COUNT_SRC).catch(() => 0);
        beforeDispatch();
        await cdpMouseClick(tab.id, p.cx, p.cy, msg.dbl);
        res = `clicked ${msg.target} (trusted${msg.dbl ? ', double' : ''})`;
        res += await runEval(tab.id, modalNoteSrc(m0)).catch(() => '');
      } else if (msg.type === 'hover') {
        const p = await point(msg.target, false, false);
        if (!p.inBanner) suppression = await removeBannerForCapture(tab.id);
        beforeDispatch();
        await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.cx, y: p.cy });
        res = `hovered ${msg.target} (trusted)`;
      } else if (msg.type === 'drag') {
        const p1 = await point(msg.from, true, false);
        const p2 = await point(msg.to, false, false);
        if (!p1.inBanner && !p2.inBanner) suppression = await removeBannerForCapture(tab.id);
        beforeDispatch();
        await cdpDrag(tab.id, p1.cx, p1.cy, p2.cx, p2.cy);
        res = `dragged ${msg.from} onto ${msg.to} (trusted)`;
      } else if (msg.type === 'press') {
        const what = await runEval(tab.id, trustedFocusSrc(msg.target, msg.key));
        beforeDispatch();
        await cdpKeyEvent(tab.id, msg.key);
        res = `pressed ${msg.key} on ${what} (trusted)`;
      } else if (msg.type === 'type') {
        // The synthetic loop's overlap guard (#32) must cover this path too:
        // a synthetic type whose reply was lost is STILL RUNNING page-side —
        // feeding CDP keys into it garbles both payloads, and both halves
        // would report success. Same flag, same world (both go via runEval).
        if (await runEval(tab.id, '!!window.__bridgeTyping').catch(() => false))
          throw new Error('another type is still running on this page (its reply was likely lost to a timeout) — readback with eval, wait for it to finish, then type only the remainder');
        await runEval(tab.id, 'window.__bridgeTyping = true').catch(() => {});
        typing = true;
        const what = await runEval(tab.id, trustedFocusSrc(msg.target));
        const delay = Math.min(25, 15000 / (msg.value.length || 1));
        const chars = [...msg.value];
        beforeDispatch();
        for (let i = 0; i < chars.length; i++) {
          // Released (⏏ or `release`) mid-type: stop feeding CDP keys into a
          // tab the human took back — say where it stopped so the agent can
          // readback instead of retrying the whole payload.
          if (!drivenTabs.has(tab.id))
            throw new Error('released mid-type — the tab was released (⏏?) after ' + i + '/' + chars.length + ' chars; readback with eval before deciding');
          await cdpKeyEvent(tab.id, chars[i]);
          await new Promise((r) => setTimeout(r, delay));
        }
        res = `typed ${msg.value.length} chars into ${what} (trusted)`;
      }
    } finally {
      if (typing) await runEval(tab.id, 'window.__bridgeTyping = false').catch(() => {});
      if (suppression !== null) await restoreBanner(tab.id, suppression);
    }
  });
  return res;
}

// Key press on the focused element (or a target). Synthetic keys are untrusted:
// they reach JS listeners but don't trigger browser defaults (form submit).
// Modifier combos: 'Control+k' splits into ctrlKey + key 'k' — 'press Control+k'
// dispatches key='k' with the flag set, which is what app handlers match.
const pressSrc = (keyIn, target) => `(async () => {
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
  // Effect observation (#50, same trap as #23 clicks): Gmail's search box
  // ignores synthetic Enter — no hashchange, no render — while 'pressed'
  // reads as success. Synthetic keys also never trigger browser defaults
  // (text insertion, form submit), so a noop is common. Watch briefly and
  // name the --trusted remedy when nothing moved. Scroll counts: ArrowDown /
  // PageDown on a scroller is a real effect with no DOM mutation.
  const f0 = document.activeElement, u0 = location.href, v0 = el.value, s0 = window.scrollY;
  let mutated = false;
  const mo = new MutationObserver((ms) => {
    for (const m of ms) {
      if ([...m.addedNodes, ...m.removedNodes].some((n) => n.nodeType === 1 && /^(bridge-banner|bridge-cursor|bridge-grid)$/.test(n.id || ''))) continue;
      const t = m.target;
      // Same ambient-churn filter as click: ancestor class/style mutations
      // are constant on SPA shells — only attributes ON/INSIDE el count.
      if (m.type === 'attributes' && !el.contains(t)) continue;
      if (el.contains(t) || t === document.body || t === document.documentElement || t.contains?.(el)) { mutated = true; break; }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  // An app handler that submits on Enter starts a navigation that can stay
  // provisional past the window (slow server) — the navigate event marks it
  // at start, same as click; armed before dispatch (it can fire inside it).
  let navigating = false, settle;
  const navSeen = new Promise((r) => { settle = r; });
  const nav = window.navigation;
  const started = (e) => { if (!e.destination?.sameDocument && !e.downloadRequest) gone(); };
  const unarm = () => { removeEventListener('pagehide', gone); nav?.removeEventListener('navigate', started); settle(); };
  const gone = () => { navigating = true; unarm(); };
  addEventListener('pagehide', gone, { once: true });
  nav?.addEventListener('navigate', started);
  el.dispatchEvent(new KeyboardEvent('keydown', o));
  el.dispatchEvent(new KeyboardEvent('keypress', { ...o, charCode: key.length === 1 ? key.charCodeAt(0) : 0 }));
  el.dispatchEvent(new KeyboardEvent('keyup', o));
  setTimeout(unarm, 350);
  await navSeen;
  mo.disconnect();
  if (navigating) return 'pressed ' + keyIn + ' on <' + el.tagName.toLowerCase() + '> — page navigating';
  const effect = mutated || document.activeElement !== f0 || location.href !== u0 || el.value !== v0 || window.scrollY !== s0;
  return 'pressed ' + keyIn + ' on <' + el.tagName.toLowerCase() + '>' + (effect ? '' : ' — no observable page effect: the app may ignore synthetic keys — retry with --trusted');
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

// wait --js: poll a page expression until truthy and return its value — the
// in-page replacement for agents' sleep-inside-eval and shell polling loops.
// Same mutation-driven cadence as waitSrc; an async predicate never overlaps
// itself, and a throwing one counts as falsy (its last error names a timeout).
const waitJsSrc = ({ js, timeout }) => `(async () => {
  const pred = async () => (
${js}
  );
  const timeout = ${Number(timeout) || 10000}, t0 = Date.now();
  let last = null, lastErr = null, busy = false;
  const check = async () => {
    if (busy) return false;
    busy = true;
    try { last = await pred(); lastErr = null; } catch (e) { last = null; lastErr = e; } finally { busy = false; }
    return !!last;
  };
  const shape = (v) => (typeof Element !== 'undefined' && v instanceof Element ? 'found <' + v.tagName.toLowerCase() + '>' : v === true ? 'condition met' : v);
  if (await check()) return shape(last);
  const met = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; try { mo.disconnect(); } catch {} clearInterval(iv); clearTimeout(to); resolve(v); };
    const tick = async () => { if (await check()) done(true); };
    const mo = new MutationObserver(tick);
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    const iv = setInterval(tick, 200);
    const to = setTimeout(() => done(false), Math.max(0, timeout - (Date.now() - t0)));
  });
  if (met) return shape(last);
  let lastV;
  try { lastV = JSON.stringify(last); } catch { lastV = String(last); }
  throw new Error('timeout after ' + timeout + 'ms waiting for the --js condition' + (lastErr ? ' — it last threw: ' + (lastErr.message || String(lastErr)) : ' (last value: ' + String(lastV).slice(0, 100) + ')'));
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
// honestly); the CLI decodes it into --out. headers = --header/--csrf extras
// (#43): session APIs like LinkedIn Voyager reject a bare fetch on its CSRF
// check — the session cookie rides, but the csrf-token header must too.
const fetchSrc = (url, headers) => `(async () => {
  const res = await fetch(${JSON.stringify(url)}, { credentials: 'include', headers: ${JSON.stringify(headers || {})} });
  const ct = res.headers.get('content-type') || '';
  if (!/text|json|xml|javascript|csv/i.test(ct)) {
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { url: res.url, status: res.status, ct, binary: true, body: btoa(bin).slice(0, 700_000), truncated: buf.length > ${BODY_CAP} };
  }
  const body = await res.text();
  return { url: res.url, status: res.status, ct, binary: false, body: body.slice(0, ${BODY_CAP}), truncated: body.length > ${BODY_CAP} };
})()`;

// --- eval machinery -----------------------------------------------------------
// Errors are caught in-page and returned as data so the caller sees the real
// failure (e.g. CSP EvalError) instead of a null result.
async function runEval(tabId, code, world) {
  // /cmd is a public entry point that bypasses the grammar's refusal — a raw
  // {world:'ISOLATED'} must not silently get page-world execution.
  if (world !== undefined && world !== 'auto' && world !== 'MAIN')
    throw new Error(`world ${JSON.stringify(world)} is not supported: caller code runs in the page's main world (Chrome MV3 can't eval in an extension's isolated world) — drop --world / the world field`);
  const injected = (src) => {
    try {
      eval('');
    } catch (e) {
      if (e instanceof EvalError) return { blocked: true };
      return { ok: false, error: String(e) };
    }
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
  const run = async () => {
    try {
      return await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
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

  // Caller code runs in the page's MAIN world. Never the ISOLATED world: MV3
  // pins content scripts to the extension's own CSP (no unsafe-eval) on every
  // page, so an eval there always failed — the ladder used to try it first
  // anyway (one wasted injection per tab) and `--world isolated` could only
  // error; both are gone. On page-CSP failure fall through to CDP.
  const r = (await run())?.[0]?.result;
  if (r?.blocked !== true) {
    if (!r) throw new Error('no injection result');
    if (r.ok === false) throw new Error(r.error);
    return r.value;
  }

  // Page CSP blocks eval() in the MAIN world; CDP Runtime.evaluate is exempt.
  await attachDbg(tabId);
  try {
    // A strict-CSP page (HN, MDN, GitHub) routes every action here, and a
    // link click tears the context down before CDP's reply lands: Chrome
    // rejects with 'Inspected target navigated or closed' although the code
    // ran — a raw error an agent reads as "retry" (double click). Tag it.
    const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      // Block-wrapped (#48): bare Runtime.evaluate runs at GLOBAL scope, so a
      // snippet's top-level const/let leak into the global lexical environment
      // and re-running the same snippet dies on 'Identifier already declared'.
      // A block's completion value is still its last statement's, so results
      // are unchanged; var and window.* assignments still set globals — only
      // let/const are scoped to the call (the scripting-world paths never
      // leaked: their eval runs inside the injected function).
      expression: '{\n' + code + '\n}',
      awaitPromise: true,
      returnByValue: true,
    }).catch((e) => {
      if (!/Inspected target navigated or closed/.test(String(e?.message || e))) throw e;
      const err = new Error('the page navigated while the command ran (after dispatch) — inspect the tab (tabs <match> / snap) before retrying');
      err.navigated = true;
      throw err;
    });
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails;
      // ex.text already carries the message for uncaught errors ('Uncaught
      // (in promise) Error: <msg>') and description repeats it before the
      // stack — append only the stack tail in that case, not the message
      // twice. CRs normalized: a bare \r overwrites earlier lines in a
      // terminal and the error reads as its own last stack frame (#27).
      const desc = (ex.exception?.description || '').replace(/\r\n?/g, '\n');
      const head = desc.split('\n')[0];
      const tail = desc && ex.text.endsWith(head) ? desc.slice(head.length) : desc ? ' ' + desc : '';
      throw new Error(`cdp: ${ex.text}${tail}`.trim());
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
async function observeDiff(tabId, actionResult, url0, doc0) {
  try {
    const url = () => chrome.tabs.get(tabId).then((t) => t.url).catch(() => null);
    const acted = () => actionResult.replace(/ — no observable page effect: the app may ignore synthetic \w+ — retry with --trusted/, '');
    // Navigation verdict: an executeScript on an uncommitted navigation pends
    // FOREVER (open()'s lesson) — wait for the load, then read the NEW page.
    const navVerdict = async (u1) => {
      // Navigation IS the observable effect: the page-side observer's window
      // can close before the commit lands (pagehide fires late), leaving its
      // 'no observable page effect … retry with --trusted' warning on the
      // result right next to 'navigated to' — an agent following it re-clicks
      // a link that worked (#55). The URL change proves the action did
      // something; strip the stale warning.
      await waitForLoad(tabId, 8000, true);
      const offLimits = await offLimitsLanding(tabId);
      if (offLimits) return `succeeded · ${acted()} — navigated to ${offLimits}`;
      const wall = await runEval(tabId, WALL_SRC).catch(() => ({}));
      if (wall.captcha) return `needs_human · ${acted()} — bot wall: ${wall.captcha} — hand off: wait <match> --human`;
      if (wall.block) return `blocked · ${acted()} — ${wall.block}`;
      if (wall.login) return `needs_human · ${acted()} — login/2FA wall — hand off: wait <match> --human`;
      const snap = await runEval(tabId, SNAP_SRC(null, false, false));
      return `succeeded · ${acted()} — navigated to ${u1.slice(0, 60)} — fresh snap (refs are new):\n${snap}`;
    };
    // A navigation the action STARTED but the server hasn't answered yet
    // (form POST / link to a slow endpoint — an OAuth consent whose callback
    // does a token exchange) leaves tab.url on the old page: settling and
    // snapping read the unchanged old document as 'uncertain … act again',
    // and acting again double-submits. Wait for the commit instead.
    const navigation = async () => {
      const c = await waitForCommit(tabId, url0, doc0);
      if (c?.committed) return await navVerdict(c.url);
      if (c?.pending) return `succeeded · ${acted()} — navigation to ${c.pending.slice(0, 60)} started, server still hasn't answered after 8s (refs expired) — don't repeat the action; wait <match> --text "<expected>" or snap <match> once it lands`;
      return null; // nothing ever moved (an aborted navigation, a 204) — observe the page as usual
    };
    const t0 = await chrome.tabs.get(tabId).catch(() => null);
    if (/ — page navigating\b/.test(actionResult) || t0?.pendingUrl) {
      const v = await navigation();
      if (v) return v;
      // The navigation was dropped without a new page (204, attachment) — the
      // page-side claim is void; judge the page as usual.
      actionResult = actionResult.replace(/ — page navigating\b/, '');
    }
    let url1 = await url();
    if (url1 && url0 && url1 !== url0) return await navVerdict(url1);
    // Bound the settle: a click that starts a navigation mid-settle leaves the
    // eval pending on the dying document — race it, then re-check the URL.
    // 4s: the settle itself caps at 3s, so anything past that is a pend.
    await Promise.race([runEval(tabId, SETTLE_SRC).catch(() => null), new Promise((r) => setTimeout(r, 4_000))]);
    if ((await chrome.tabs.get(tabId).catch(() => null))?.pendingUrl) {
      const v = await navigation();
      if (v) return v;
    }
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
      // The diff proves an effect the page-side observer missed (async renders) — its retry hint would contradict the verdict.
      actionResult = actionResult.replace(/ — no observable page effect: the app may ignore synthetic \w+ — retry with --trusted/, '');
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
  if (!msg.diff) {
    const url0 = (await chrome.tabs.get(tabId).catch(() => null))?.url;
    const result = await run();
    // The navigate event answers at navigation START, while tab.url still
    // shows the old page: a follow-up command matching the destination URL
    // missed the tab (stress: nav "x=cspnav" right after a CSP-page link
    // click). pagehide used to answer at about the commit — wait for it,
    // bounded, so slow servers still answer promptly.
    if (url0 && typeof result === 'string' && / — page navigating$/.test(result)) await waitForCommit(tabId, url0, null, 3000);
    return result;
  }
  const ownership = ownershipSeq.get(tabId) || 0;
  const check = () => {
    if (!Number.isFinite(msg.deadlineAt) || Date.now() >= msg.deadlineAt)
      throw new Error('queued action expired before execution — the command did not run');
    if (!drivenTabs.has(tabId) || humanReclaimed.has(tabId) || (ownershipSeq.get(tabId) || 0) !== ownership)
      throw new Error('queued action cancelled after tab release — the command did not run');
  };
  return await withSnap(tabId, async () => {
    check();
    const url0 = (await chrome.tabs.get(tabId)).url;
    const doc0 = await docId(tabId); // tells a same-URL commit from a dropped navigation
    await runEval(tabId, SNAP_SRC(null, false, false)); // pre-action baseline
    check();
    const result = await run(check);
    return await observeDiff(tabId, result, url0, doc0);
  });
}

// Commit wait for a navigation an action started: chrome.tabs.get polled, never
// executeScript while a pendingUrl shows (it pends forever on an uncommitted
// navigation). A changed committed URL is a commit (navVerdict then waits for
// the load). A pendingUrl that clears with the URL unchanged is a commit only
// if the document changed (POST/reload to the same URL) — Chrome also drops
// the pending entry WITHOUT committing (204, Content-Disposition: attachment,
// abort), and that must not read as 'navigated'. Returns {committed, url},
// {pending} if still uncommitted at the timeout, or null when nothing moved —
// the browser registers a navigation within ms of its start, so 1s with no
// pendingUrl means there is none.
async function docId(tabId) {
  try {
    // injectImmediately: only the document identity is needed — never wait for a slow page's document_idle.
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', injectImmediately: true, func: () => 0 });
    return r?.documentId || null;
  } catch {
    return null;
  }
}
async function waitForCommit(tabId, url0, doc0, timeout = 8000) {
  const t0 = Date.now();
  let moving = false;
  for (;;) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return null;
    if (!t.pendingUrl && t.url && t.url !== url0) return { committed: true, url: t.url };
    if (t.pendingUrl) moving = true;
    else if (moving) {
      if (!doc0) return null; // no baseline to compare (plain-click wait): it landed or was dropped — either way, done
      const d = await docId(tabId);
      return doc0 && d && d !== doc0 ? { committed: true, url: t.url } : null;
    }
    if (!moving && Date.now() - t0 >= 1000) return null;
    if (Date.now() - t0 >= timeout) return { pending: t.pendingUrl || t.url };
    await new Promise((r) => setTimeout(r, 100));
  }
}

// open's answer once the load wait is over: the tab's URL, or why there is no
// tab. A URL that only downloads a file never gets a page and Chrome closes
// its tab, so the generic "No tab with id" mapping ("closed mid-command — run
// tabs to re-find it") sent agents looking for a tab that can't exist (found
// live opening a Cloud Bridge file link).
async function openedTabUrl(tabId, requested) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error(`the new tab closed before a page loaded — ${requested} most likely started a download (Chrome closes a tab that only downloads a file; the file is in the browser's downloads), or someone closed the tab. There is no tab to drive`);
  }
  return tab.url || requested; // "" while pending: the requested URL is still a usable <match>
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
const humanWaits = new Set(); // tabId — ONE handoff per tab: a second wait --human re-arms the acted flag under the first waiter (it then times out lying "the human did not act" while the second returns the success)
async function waitHuman(tab, msg) {
  if (humanWaits.has(tab.id)) throw new Error('another wait --human is already in flight on this tab — one handoff at a time (let it finish or release the tab first)');
  humanWaits.add(tab.id);
  try {
    return await waitHumanRun(tab, msg);
  } finally {
    humanWaits.delete(tab.id);
  }
}
async function waitHumanRun(tab, msg) {
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
        // The human ⏏'d mid-handoff: they ended the handoff themselves — stop
        // waiting, and tell the agent (their wait errors instead of hanging to
        // its 285s budget on a tab nobody is acting in).
        if (!drivenTabs.has(tab.id)) { clearInterval(iv); resolve('released'); return; }
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
  if (how === 'released') throw new Error('the human released the tab (⏏) mid-handoff — they took it back while it was theirs to act in');
  // A login usually navigates: the whole page (and every ref, and the diff
  // baseline) died with the old document. Fresh full snap instead of a diff.
  if (how === 'nav' || (await chrome.tabs.get(tab.id).catch(() => null))?.url !== url0) {
    await waitForLoad(tab.id, 8000, true);
    const offLimits = await offLimitsLanding(tab.id);
    if (offLimits) return 'the human navigated to ' + offLimits;
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
  return await withDbg(tab.id, async () => {
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
      // The pill is down only for each capture's own removal window
      // (captureViewport re-removes at every frame) — NOT for the whole
      // watch: a minutes-long pixel wait with no visible marking broke the
      // "any tab the agent is looking at wears the pill" contract at the
      // most surveillance-like moment. respectHide: a mid-watch ✕ sticks.
      await restoreBanner(tab.id, bannered, true);
      // Decode the baseline ONCE — re-decoding a multi-MB png every 800ms poll
      // was pure waste (found by review).
      bmp0 = await pngBitmap(cap0.b64);
      for (;;) {
        // Released (⏏ or `release`) mid-watch: stop polling and drop the CDP
        // session — the tab is the human's again; a watch on it has no client.
        if (!drivenTabs.has(tab.id)) throw new Error('released mid-watch — the tab was released (⏏?) while waiting for pixels; re-mark deliberately if the human meant to hand it back');
        if (Date.now() - t0 >= timeout) throw new Error('timeout after ' + timeout + 'ms — no pixel change detected');
        await new Promise((r) => setTimeout(r, 800));
        // Plain capture: the frame is whatever the viewport is NOW — scroll
        // and resize follow natively, no pin to maintain.
        const cap = await captureViewport(tab.id, pngMsg);
        await restoreBanner(tab.id, bannered, true); // pill back between polls
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
          await restoreBanner(tab.id, bannered, true); // pill back between polls
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
      await restoreBanner(tab.id, bannered, true);
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
// Adding a command? EIGHT registries stay in sync (a missing one fails SILENTLY):
// cli.mjs USAGE · extension/commands.js REGISTRY + parse() (or cli.mjs run() for the
// commands the CLI handles itself) · server.mjs CLI_LINES · server.mjs route() (only if it
// needs special routing) · background.js handle() · ACT_VERBS (pill narration) · MUTATING.
const MUTATING = new Set(['click', 'fill', 'clear', 'paste', 'type', 'press', 'upload', 'eval', 'hover', 'scroll', 'grid', 'emulate', 'resize', 'drag', 'dialog', 'fetch']);
// What a link may run on a tab ANOTHER link drives: pure reads (selftest:
// readOnly in the commands.js registry, never MUTATING). Everything else —
// actions, nav/close, page code, waits, note, mark/release — belongs to the
// owner.
const CROSS_LINK_READS = new Set(['snap', 'shot', 'measure', 'console', 'ask', 'perf', 'net']);

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
function assertNotReclaimed(tabId, msg) {
  const reclaimed = humanReclaimed.get(tabId);
  if (reclaimed && !['mark', 'release'].includes(msg.type))
    throw new Error(
      `⚠ the human released this tab via ⏏ at ${new Date(reclaimed).toTimeString().slice(0, 8)} — they took it back. Every command on it is refused until a deliberate re-claim: ask the human, and only if they hand it back — mark <match>`
    );
}

// Tab ownership per link: a tab belongs to the link whose command marked it.
// Another link may read it (CROSS_LINK_READS) but not act on, claim or
// release it — two agents on two links must not fight over one page, and a
// prompt-injected remote agent must not drive the tab a local session is
// filling. Driven tabs with no recorded owner (state from a build before
// links) are local's. With only the local link, nothing is ever refused.
const ownerOf = (tabId) => (drivenTabs.has(tabId) ? tabOwner.get(tabId) || 'local' : null);
// A local command still in flight when the human switched Local AI agents off
// must not claim a tab after the switch handed them all back.
function assertLinkOn(msg) {
  if (msg._link === 'local' && !localOn) throw new Error(LOCAL_OFF_ERROR);
}
const linkLabel = (id) => links.get(id)?.label || id;
function assertLinkMayDrive(tabId, msg) {
  const owner = ownerOf(tabId);
  if (!owner || owner === msg._link || CROSS_LINK_READS.has(msg.type)) return;
  throw new Error(
    `⚠ this tab is driven through the ${linkLabel(owner)} link — from ${linkLabel(msg._link)} you can only read it (${[...CROSS_LINK_READS].join(', ')}), nothing ran. To act on that page, open your own tab (open <url>), or ask the user to have the other agent release this one`
  );
}

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
    // id + title per match, not just the host: the documented ambiguous case
    // is two tabs on the SAME site (identical-URL dupes), where a hosts-only
    // list reads 'github.com, github.com' and the agent pays a `tabs` round
    // trip to learn what this line could have said. id:<tabId> is the exact
    // reference every command accepts — re-run with it, no guessing.
    const row = (t) => `id:${t.id} ${host(t)}` + (t.title ? ` "${t.title.slice(0, 30)}"` : '');
    throw new Error(
      `⚠ ${matches.length} tabs match "${msg.urlMatch}" — refusing to choose one; matched: ` +
        matches.slice(0, 4).map(row).join(', ') +
        (matches.length > 4 ? ` (+${matches.length - 4} more)` : '') +
        '. Re-run with a longer <match>, or target one exactly: id:<tabId>.'
    );
  }
  msg._tabId = matches[0].id;
  // The ⏏ reclaim gate: the human took this tab back (pill ⏏) and findTab's
  // auto-mark would hand it to the next command in the agent's loop within
  // seconds — refuse everything for the window. `mark` is the deliberate
  // re-claim (passes and clears the flag); `release` passes and KEEPS it (a
  // stray agent release must not launder the tab back). `tabs`/`probe` never
  // reach findTab — listing and routing stay possible while gated.
  assertNotReclaimed(matches[0].id, msg);
  // Another link's tab: reads pass, everything else is refused here — before
  // mark's reclaim-clear, the auto-mark and any activity record.
  assertLinkMayDrive(matches[0].id, msg);
  refuseOffLimitsTab(matches[0], msg);
  if (msg.type === 'mark') {
    humanReclaimed.delete(matches[0].id);
    persist(); // the re-claim must survive an SW restart too — a resurrected veto would refuse commands on a tab the human handed back
  }
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
  if (!['release', 'mark', 'unemulate', 'activate'].includes(msg.type) && !drivenTabs.has(matches[0].id)) {
    // This command created the claim — if it then hits Chrome's permanent
    // "nothing here is drivable" wall, onmessage undoes THIS mark (#37).
    assertLinkOn(msg);
    msg._markedByMe = true;
    tabOwner.set(matches[0].id, msg._link); // markTab persists it
    markTab(matches[0].id).catch(() => {});
  }
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
  // --csrf (#43): session APIs (LinkedIn Voyager) check a csrf-token header
  // whose value is the JSESSIONID cookie — httpOnly, so no page-side read can
  // reach it. The debugger already holds the permission: Network.getCookies
  // answers httpOnly cookies for the URL. Brief attach, header attached to
  // the in-page fetch below.
  const headers = { ...(msg.headers || {}) };
  if (msg.csrf) {
    const origin = new URL(msg.url).origin;
    if (!/^https?:/.test(msg.url) || new URL(tab.url).origin !== origin)
      throw new Error('--csrf: request and tab must have the same HTTP(S) origin');
    const document = (await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: 'ISOLATED',
      func: () => location.origin,
    }))?.[0];
    if (!document?.documentId || document.result !== origin)
      throw new Error('--csrf: tab document origin changed before cookie access');
    const cookies = await withDbg(tab.id, () => chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.getCookies', { urls: [msg.url] }));
    const j = (cookies?.cookies || []).find((c) => c.name === 'JSESSIONID');
    if (!j) throw new Error('--csrf: no JSESSIONID cookie reaches ' + new URL(msg.url).host + ' — wrong origin, or the profile is not logged in');
    headers['csrf-token'] = j.value.replace(/^"|"$/g, ''); // the cookie stores the value quoted
    const result = (await chrome.scripting.executeScript({
      target: { tabId: tab.id, documentIds: [document.documentId] },
      world: 'ISOLATED',
      func: async (url, headers, origin, cap) => {
        try {
          if (location.origin !== origin || new URL(url).origin !== origin)
            throw new Error('--csrf: document and request origin must match');
          const response = await fetch(url, { credentials: 'include', headers, redirect: 'error' });
          const ct = response.headers.get('content-type') || '';
          const bytes = new Uint8Array(await response.arrayBuffer());
          const truncated = bytes.length > cap;
          const kept = bytes.subarray(0, cap);
          const binary = !/text|json|xml|javascript|csv/i.test(ct);
          let body = '';
          if (binary) {
            for (let offset = 0; offset < kept.length; offset += 0x8000)
              body += String.fromCharCode.apply(null, kept.subarray(offset, offset + 0x8000));
            body = btoa(body);
          } else body = new TextDecoder().decode(kept, { stream: truncated });
          return { ok: true, value: { status: response.status, ct, binary, body, truncated } };
        } catch (error) {
          return { ok: false, error: String(error) };
        }
      },
      args: [msg.url, headers, origin, BODY_CAP],
    }))?.[0]?.result;
    if (!result?.ok) throw new Error(result?.error || '--csrf: no isolated document result');
    return result.value;
  }
  const hasHeaders = Object.keys(headers).length > 0;
  // In-page fetch first — the page's session rides it. A page CSP
  // (connect-src) or a cross-origin CORS refusal falls back to the
  // browser-network read: Network.loadNetworkResource fetches outside the
  // page's JS walls with the profile's credentials — the same wall
  // net --body reads bodies through. Shape handled defensively; a Chrome
  // version that answers differently fails loudly here, not silently.
  try {
    const out = await runEval(tab.id, fetchSrc(msg.url, headers));
    // Where a redirect landed (url) is checked for cloud links, then dropped from
    // the reply. (The browser-network fallback below can't report it, like a
    // public name pointing into the LAN: that stays out of reach of this check.)
    const { url: landed, ...reply } = out || {};
    const where = cloudLink(msg._link) && landed ? offLimitsUrl(landed) : null;
    if (where) throw offLimitsError(`the request was redirected to ${where}, which`, 'its answer is withheld');
    return out ? reply : out;
  } catch (e) {
    if (e?.offLimits) throw e;
    // The fallback can't carry custom headers (Network.loadNetworkResource
    // has no headers param) — a headerless retry of a CSRF-checked API is a
    // 403 that misreads as "the API broke". Fail with the real error instead.
    if (hasHeaders)
      throw new Error(
        String(e).replace(/^(Error:\s*)+/, '') + ' — custom headers ride only the in-page fetch; the browser-network fallback cannot carry them'
      );
    const read = await withDbg(tab.id, async () => {
      // Chrome 152 tightened loadNetworkResource: options.disableCache is
      // mandatory AND frameId must be provided (stress: the fallback died
      // on both — 'Failed to deserialize options.disableCache', then
      // 'Parameter frameId must be provided for frame targets').
      const tree = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.getFrameTree');
      const frameId = tree?.frameTree?.frame?.id;
      const out = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.loadNetworkResource', { url: msg.url, frameId, options: { includeCredentials: true, disableCache: false } });
      const rec = out?.resource || {};
      if (!rec.success) {
        // #66: name each layer instead of concatenating them. 'Failed to
        // fetch' is the PAGE's wall (CSP connect-src, or cross-origin with no
        // CORS — the page never saw a status); ERR_HTTP_RESPONSE_CODE_FAILURE
        // is the server ANSWERING with a 4xx/5xx. One failure can be both:
        // cross-origin, the page can not read the error status it caused.
        const inpage = String(e).replace(/^(Error:\s*)+/, '').slice(0, 120);
        const netErr = rec.netErrorName || rec.netError || 'unknown';
        throw new Error(
          'fetch failed — in-page: ' + inpage + (/failed to fetch/i.test(inpage) ? ' (blocked cross-origin or by CSP — the page never saw a status)' : '') +
          '; browser read: ' + netErr + (/HTTP_RESPONSE_CODE_FAILURE/.test(netErr) ? ' (the server answered an HTTP error status — a 4xx/5xx)' : '')
        );
      }
      // The body now STREAMS (rec.stream, Chrome 152) instead of riding
      // rec.content — read it via IO.read or the CLI writes a 0-byte
      // --out (stress: 200 application/json, 0 KB file).
      let binary = !!rec.base64Encoded;
      let truncated = false;
      const bytes = new Uint8Array(BODY_CAP);
      let length = 0;
      const append = (data, encoded) => {
        const chunk = encoded ? Uint8Array.from(atob(data || ''), (char) => char.charCodeAt(0)) : new TextEncoder().encode(data || '');
        const kept = chunk.subarray(0, BODY_CAP - length);
        bytes.set(kept, length);
        length += kept.length;
        truncated ||= kept.length < chunk.length;
        binary ||= !!encoded;
      };
      if (rec.stream) {
        const t0 = Date.now();
        try {
          for (;;) {
            const chunk = await chrome.debugger.sendCommand({ tabId: tab.id }, 'IO.read', { handle: rec.stream, size: BODY_CAP });
            append(chunk.data, chunk.base64Encoded);
            if (chunk.eof || truncated) break;
            if (Date.now() - t0 > 60_000) {
              truncated = true;
              break;
            }
          }
        } finally {
          await chrome.debugger.sendCommand({ tabId: tab.id }, 'IO.close', { handle: rec.stream }).catch(() => {});
        }
      } else append(rec.content, rec.base64Encoded);
      let body = '';
      if (binary) {
        for (let offset = 0; offset < length; offset += 0x8000)
          body += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(offset + 0x8000, length)));
        body = btoa(body);
      } else {
        body = new TextDecoder().decode(bytes.subarray(0, length), { stream: truncated });
      }
      return {
        status: rec.httpStatusCode ?? rec.statusCode ?? 200,
        ct: rec.mime || rec.headers?.['Content-Type'] || '',
        binary,
        body,
        truncated,
      };
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
  return await withDbg(tab.id, async () => {
    try {
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.handleJavaScriptDialog', {
        accept: msg.accept !== false,
        ...(msg.text ? { promptText: msg.text } : {}),
      });
    } catch (e) {
      if (!/No dialog is showing/.test(errText(e))) throw e;
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
      throw new Error(errText(e)); // renderer alive → genuinely no dialog — the cause, not the protocol JSON envelope
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
// --chooser: the app creates its input DETACHED and opens the OS picker from
// a trigger click (Slides' 'Upload from computer') — there is no input in the
// DOM to target. Intercept the chooser instead: Page.fileChooserOpened hands
// over the input's backendNodeId, no native dialog ever shown (#56).
const chooserWaiters = new Map(); // tabId -> { resolve } while an upload --chooser waits
chrome.debugger.onEvent.addListener((src, method, params) => {
  if (method !== 'Page.fileChooserOpened') return;
  const w = chooserWaiters.get(src.tabId);
  if (!w) return;
  chooserWaiters.delete(src.tabId);
  w.resolve(params);
});
// Files are local paths (the CLI) or { name, mimeType, data: base64 } (Cloud
// Bridge, which has no disk): paths go through DOM.setFileInputFiles, bytes
// become File objects set through a DataTransfer — then input + change fire,
// as setFileInputFiles does.
const uploadNames = (files) => files.map((f) => (typeof f === 'string' ? f.split('/').pop() : f.name)).join(', ');
const SET_FILE_BYTES = `function (files) {
  const dt = new DataTransfer();
  for (const f of files) {
    const bin = atob(f.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.mimeType || '' }));
  }
  this.files = dt.files;
  this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
}`;
const byteFile = (f) => f && typeof f === 'object' && typeof f.name === 'string' && typeof f.data === 'string';
function checkUploadFiles(files) {
  if (!Array.isArray(files) || !files.length || !(files.every((f) => typeof f === 'string') || files.every(byteFile)))
    throw new Error('upload files must all be paths, or all { name, mimeType, data (base64) }');
}
async function setInputFiles(tabId, node, files) {
  if (files.every((f) => typeof f === 'string')) return chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', { ...node, files });
  if (node.backendNodeId) await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', { depth: 0 });
  const { object } = await chrome.debugger.sendCommand({ tabId }, 'DOM.resolveNode', node);
  try {
    const r = await chrome.debugger.sendCommand({ tabId }, 'Runtime.callFunctionOn', {
      objectId: object.objectId, functionDeclaration: SET_FILE_BYTES, arguments: [{ value: files.map(({ name, mimeType, data }) => ({ name, mimeType, data })) }],
    });
    if (r?.exceptionDetails) throw new Error('setting the files failed in the page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  } finally {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
  }
}
async function cmdUpload(tab, msg) {
  checkUploadFiles(msg.files);
  if (msg.chooser) {
    // The OS picker only opens from a real user gesture — a synthetic
    // el.click() on the trigger is ignored (verified live), so the trigger
    // click goes through CDP Input like any --trusted click, with the same
    // visibility preflight (#33: CDP input on a hidden tab fires zero events).
    const vis = await runEval(tab.id, 'document.visibilityState + "|" + document.hasFocus()').catch(() => null);
    if (vis === 'hidden|true')
      throw new Error('tab is hidden while its window has focus — the Chrome window is fully covered by other apps (macOS occlusion) or minimized; activate cannot un-occlude it. Use emulate <match> focus (flips visibilityState), or target the file input directly without --chooser (works on hidden tabs)');
    if (vis?.startsWith('hidden'))
      throw new Error('tab is hidden — upload --chooser clicks the trigger with trusted input, which reaches only the foreground tab. activate <match> it first, or target the file input directly without --chooser (works on hidden tabs)');
    await awaitMark(tab.id);
    return await actAndVerify(tab.id, msg, async (beforeDispatch = () => {}) => {
      let suppression = null;
      await withDbg(tab.id, async () => {
        beforeDispatch();
        await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable');
        await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.setInterceptFileChooserDialog', { enabled: true });
        let chooserTimer;
        try {
          const point = JSON.parse(await runEval(tab.id, trustedPointSrc(msg.target, true, false)));
          if (!point.inBanner) suppression = await removeBannerForCapture(tab.id);
          beforeDispatch();
          const opened = new Promise((resolve, reject) => {
            chooserTimer = setTimeout(() => {
              chooserWaiters.delete(tab.id);
              reject(new Error('no file chooser opened within 5s of clicking ' + msg.target + ' — is that the element that opens the picker?'));
            }, 5000);
            chooserWaiters.set(tab.id, { resolve: (event) => { clearTimeout(chooserTimer); resolve(event); } });
          });
          await cdpMouseClick(tab.id, point.cx, point.cy);
          const ev = await opened;
          if (msg.files.length > 1 && ev.mode !== 'selectMultiple') throw new Error('this file chooser takes a single file — pass one');
          await setInputFiles(tab.id, { backendNodeId: ev.backendNodeId }, msg.files);
        } finally {
          clearTimeout(chooserTimer);
          chooserWaiters.delete(tab.id);
          await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
          if (suppression !== null) await restoreBanner(tab.id, suppression);
        }
      });
      const names = uploadNames(msg.files);
      return `uploaded ${msg.files.length} file(s) via the file chooser on ${msg.target}: ${names}`;
    });
  }
  const TAG = 'data-bridge-upload';
  // The whole body rides actAndVerify so the verdict baseline precedes the
  // CDP mutation (setFileInputFiles fires real input/change events).
  return await actAndVerify(tab.id, msg, async (beforeDispatch = () => {}) => {
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
      await withDbg(tab.id, async () => {
        beforeDispatch();
        const { root } = await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.getDocument', { depth: 1 });
        const { nodeId } = await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.querySelector', {
          nodeId: root.nodeId,
          selector: `[${TAG}]`,
        });
        if (!nodeId) throw new Error('tagged input vanished mid-upload — re-snap and retry');
        beforeDispatch();
        await setInputFiles(tab.id, { nodeId }, msg.files);
      });
    } finally {
      await runEval(tab.id, `document.querySelector('[${TAG}]')?.removeAttribute('${TAG}')`).catch(() => {});
    }
    const names = uploadNames(msg.files);
    return `uploaded ${msg.files.length} file(s) to ${msg.target}: ${names}`;
  });
}

const shotFallbackQ = new Map(); // windowId -> captureVisibleTab fallback chain (see cmdShot's catch)
async function cmdShot(tab, msg) {
  const format = msg.format === 'jpeg' ? 'jpeg' : 'png';
  // First-ever shot on a fresh tab: let the in-flight auto-mark LAND before
  // the banner-free capture window — its injectBanner queues behind groupTab's
  // round trips and could otherwise arrive between removeBannerForCapture and
  // captureScreenshot, baking the pill into the PNG (and, for --diff, into
  // the baseline every later shot compares against).
  await awaitMark(tab.id);
  // One try covers the CDP capture AND its attach: a failed attach (chrome://,
  // Web Store) routes to the same captureVisibleTab fallback as a failed
  // capture — and withDbg's detach then correctly never runs (a detach after a
  // failed attach was the phantom-doctor-row bug).
  try {
    return await withDbg(tab.id, async () => {
      // Every CDP capture below (viewport/crop/full/diff) and even the
      // cdp-less fallback runs banner-free: the pill and its active gradient
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
          dpr = emulatedDsf.get(tab.id) || dprOf(m);
          params.captureBeyondViewport = true;
          // Floor at the viewport: a transient/mid-load metrics read can report
          // content narrower than the visible page (#24 captured a 127px-wide
          // strip of a 1280px page) — a full-page shot is never smaller than
          // what the user sees.
          const w = Math.max(Math.ceil(c.width), Math.ceil(m.cssVisualViewport.clientWidth));
          const h = Math.min(Math.max(Math.ceil(c.height), Math.ceil(m.cssVisualViewport.clientHeight)), 16384);
          params.clip = { x: 0, y: 0, width: w, height: h, scale: cap(w, h) };
        } else if (msg.crop) {
          // --crop x,y are viewport-relative (measure output); clip is page-absolute.
          // Same whole-px rounding as captureViewport — fractional viewport
          // offsets (infobar settle) would otherwise re-AA high-contrast edges
          // between captures.
          const m = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.getLayoutMetrics');
          const v = m.cssVisualViewport;
          dpr = emulatedDsf.get(tab.id) || dprOf(m);
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
            const cap = await captureViewport(tab.id, { ...msg, format: 'png' });
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
              return { note: 'diff: ' + cmp.error + (kept ? '' : ' — but the baseline was NOT saved (page navigated or tab released mid-diff)'), data: full };
            }
            if (!cmp.changed) {
              cmp.bmp.close();
              const kept = setBase();
              return { note: 'diff: no pixel change since the previous shot' + (kept ? ' (baseline updated)' : ' (page navigated or tab released mid-diff — baseline NOT updated)'), data: full };
            }
            const box = changedBox(cmp, cmp.bmp);
            const data = await cropDataUrl(cmp.bmp, box.x, box.y, box.w, box.h);
            cmp.bmp.close();
            const kept = setBase();
            const { x: cssX, y: cssY } = cssBox(cap, box);
            return {
              note: `diff: ${cmp.pct}% of pixels changed — the saved file is the changed region (${box.w}×${box.h}px; CSS offset x=${cssX}, y=${cssY} for measure/crop). ` + (kept ? 'Baseline is now THIS shot.' : 'Page navigated or tab released mid-diff — baseline NOT updated.'),
              data,
            };
          }
          const cap = await captureViewport(tab.id, msg);
          return `data:image/${cap.format};base64,${cap.b64}`;
        }
        // Raw path (full/crop): captureViewport re-removes at its own capture;
        // this sendCommand doesn't go through it — same timing-proof removal.
        await settleFrames(tab.id);
        await removeBannerForCapture(tab.id);
        const res = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.captureScreenshot', params);
        return `data:image/${format};base64,${res.data}`;
      } finally {
        await restoreBanner(tab.id, bannered);
      }
    });
  } catch (e) {
    if (/another debugger holds|Cannot access a chrome|Cannot attach|extensions gallery/i.test(errText(e))) throw e;
    const run = (shotFallbackQ.get(tab.windowId) || Promise.resolve()).then(async () => {
      const active = () => chrome.tabs.query({ active: true, windowId: tab.windowId }).then(([current]) => current?.id === tab.id);
      if (!await active()) throw new Error('CDP screenshot failed: ' + errText(e) + ' — fallback needs the target tab active; no focus changed. Use activate <match> explicitly, then retry shot');
      const png = await chrome.tabs.captureVisibleTab(tab.windowId, { format, ...(format === 'jpeg' ? { quality: msg.quality ?? 80 } : {}) });
      if (!await active()) throw new Error('active tab changed during screenshot fallback — capture discarded; no focus changed');
      const note = 'fallback shot — CDP unavailable; viewport only, crop/max/scale ignored';
      return { note: msg.diff ? 'diff skipped — ' + note + '; the baseline is unchanged' : note, data: png };
    });
    const tail = run.catch(() => {});
    shotFallbackQ.set(tab.windowId, tail);
    tail.then(() => shotFallbackQ.get(tab.windowId) === tail && shotFallbackQ.delete(tab.windowId));
    return await run;
  }
}

// Cloud links stay on the public web (decision cloud-private-net, S1): an AI app,
// or a page prompt-injecting it, opened http://127.0.0.1:9333/log (the local
// agent's commands), a router at 192.168.1.1 or file:///. Literal addresses and
// local names only — a public DNS name pointing into the LAN gets through, as it
// would for any web page; the server's Host guard covers its own aliases. Local
// agents are unaffected.
function privateHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  if (!h || h === 'localhost' || /\.(localhost|local)$/.test(h)) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!h.includes(':')) return false;
  // IPv6 loopback/unspecified, unique-local, link-local, and IPv4 inside it
  // (::a.b.c.d, ::ffff:…, NAT64): the URL parser writes those as hex.
  return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:') || /^::[0-9a-f]{1,4}(:[0-9a-f]{1,4})?$/.test(h) || h.startsWith('64:ff9b:');
}

// Where a cloud link may not go, or null: a place on this computer or its
// network, or a non-web page. blob: pages count as their http(s) origin.
function offLimitsUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null; // '' (a tab not committed yet): nothing to judge
  }
  if (u.protocol === 'blob:') {
    try {
      u = new URL(u.origin);
    } catch {
      return 'blob: pages';
    }
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') return privateHost(u.hostname) ? u.host : null;
  return u.href === 'about:blank' ? null : u.protocol + ' pages';
}

const cloudLink = (link) => !!link && link !== 'local';

// subject: the address, or a phrase ending in one ("this tab is on 10.0.0.1, which").
function offLimitsError(subject, outcome = 'nothing ran') {
  const err = new Error(
    `${subject} is on this computer or its local network — Cloud AI apps reach public web pages only (not localhost, private or link-local addresses, *.local, or file:, data: and view-source: pages); ${outcome}. Ask the user to do this with an AI agent on their computer, or to open it themselves`
  );
  err.offLimits = true;
  return err;
}

function refuseOffLimits(msg) {
  if (!cloudLink(msg._link) || !['open', 'navigate', 'fetch'].includes(msg.type)) return;
  try {
    new URL(msg.url);
  } catch {
    return; // a bad URL is worded by the command's own check
  }
  const where = offLimitsUrl(msg.url);
  if (where) throw offLimitsError(where);
}

// The same line wherever a tab ends up: an eval setting location, a click on a
// link, a redirect or the page itself can carry a tab there after the URL check
// (review). Cloud links neither act on such a tab nor read it — release, close,
// unemulate and nav (whose target refuseOffLimits checks) stay possible, so they
// can back out. Both addresses count: until a pending navigation commits, every
// read runs in the page still shown.
const tabOffLimits = (tab) => offLimitsUrl(tab.url) || offLimitsUrl(tab.pendingUrl);
function refuseOffLimitsTab(tab, msg) {
  if (!cloudLink(msg._link) || ['release', 'close', 'unemulate', 'navigate'].includes(msg.type)) return;
  const where = tabOffLimits(tab);
  if (where) throw offLimitsError(`this tab is on ${where}, which`);
}

// net's capture runs for seconds after that check: requests to such addresses
// (ws:// too) are left out of what a cloud link gets back (review).
function netOffLimits(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return /^(https?|wss?):$/.test(u.protocol) ? privateHost(u.hostname) : u.protocol === 'file:';
}

// After an action navigated a tab: the snapshot that would come back, withheld
// when the tab's driver is a cloud link and it landed off-limits.
async function offLimitsLanding(tabId) {
  if (!cloudLink(ownerOf(tabId))) return null;
  const t = await chrome.tabs.get(tabId).catch(() => null);
  const where = t && tabOffLimits(t);
  return where ? `${where} — on this computer or its local network, so Cloud AI apps get no snapshot of it. Go back (nav <match> <public url>) or close it, or ask the user to continue with an AI agent on their computer` : null;
}
// --- end off-limits

// Adding a command? EIGHT registries stay in sync (a missing one fails SILENTLY):
// cli.mjs USAGE · extension/commands.js REGISTRY + parse() (or cli.mjs run() for the
// commands the CLI handles itself) · server.mjs CLI_LINES · server.mjs route() (only if it
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
    // Pages Chrome hard-blocks from scripting can never be driven — creating
    // or navigating to one through the bridge only leaves a marked tab no
    // command can act on (#37's residue at the creation step). Refuse up
    // front. (PDF tabs and file://-without-permission escape this list by
    // design; the first failing command's #37 unmark cleans those up.)
    if (u.protocol === 'chrome:' || u.protocol === 'chrome-extension:' || u.host === 'chromewebstore.google.com' || (u.host === 'chrome.google.com' && u.pathname.startsWith('/webstore')))
      throw new Error(`"${u.protocol}//${u.host}" can never be driven — Chrome blocks extension scripting on chrome:// pages, other extensions' pages, and the Web Store. Open it by hand for the human instead; the bridge would only leave a marked tab it can't act on`);
  }
  refuseOffLimits(msg);

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
    journal('extreload', null, 'v' + chrome.runtime.getManifest().version);
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
      // Driven through ANOTHER link: theirs to act on, yours only to read.
      ...(drivenTabs.has(t.id) && ownerOf(t.id) !== msg._link ? { link: linkLabel(ownerOf(t.id)) } : {}),
    }));
  }

  if (msg.type === 'doctor') {
    // Read-only residue report for THIS profile: tabs wearing bridge markers
    // (🟣 group / status favicon / emulation / debugger) and whether the
    // bridge still tracks them, plus tracked ids whose tab is gone. Residue =
    // markers without driven state. fix prunes the dead-id memory here;
    // Chrome-side markers are the cli's job (it releases each residue tab
    // through the normal path). Read-only, no findTab, no marking.
    const tabs = await chrome.tabs.query({});
    const live = new Set(tabs.map((t) => t.id));
    const gTitles = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g.title]));
    const rows = [];
    for (const t of tabs) {
      const grouped = t.groupId !== -1 && gTitles.get(t.groupId) === '🟣 Bridge';
      const driven = drivenTabs.has(t.id);
      const status = tabStatus.get(t.id) || null;
      const emulated = emulatedTabs.has(t.id);
      const dbg = cdpRefs.has(t.id);
      if (grouped || driven || status || emulated || dbg)
        rows.push({ id: t.id, url: (t.url || '').slice(0, 80), title: (t.title || '').slice(0, 60), grouped, driven, status, emulated, debugger: dbg });
    }
    const stale = [...new Set([...drivenTabs, ...tabStatus.keys(), ...tabActivity.keys(), ...emulatedTabs.keys(), ...shotBaselines.keys(), ...failedSinceOk.keys(), ...cdpRefs.keys(), ...tabOwner.keys()])].filter((id) => !live.has(id));
    if (msg.fix && stale.length) {
      for (const id of stale) {
        drivenTabs.delete(id);
        tabOwner.delete(id);
        tabStatus.delete(id);
        tabActivity.delete(id);
        emulatedTabs.delete(id);
        shotBaselines.delete(id);
        failedSinceOk.delete(id);
        cdpRefs.delete(id); // a failed detach's residue entry (debugger died with the tab)
      }
      persist();
      journal('doctor-fix', null, `pruned ${stale.length} stale id(s)`);
    }
    return { rows, stale };
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
    if (msg._link === 'local' && !localOn) {
      chrome.tabs.remove(tab.id).catch(() => {}); // switched off mid-open: no unclaimed stray
      throw new Error(LOCAL_OFF_ERROR);
    }
    msg._tabId = tab.id;
    // Listener before the favicon/banner work: those are two executeScript
    // round trips, and a fast page can hit 'complete' inside that window
    // (observed with example.com) — the load event would be missed. The
    // recheck covers the tighter race: committed before this listener attached.
    const complete = waitForLoad(tab.id, 8000, true);
    setFavicon(tab.id, '⏳').catch(() => {});
    tabOwner.set(tab.id, msg._link); // markTab persists it
    markTab(tab.id).catch(() => {});
    recordActivity(tab.id, msg);
    const loaded = await complete;
    return { id: tab.id, url: await openedTabUrl(tab.id, msg.url), loaded };
  }

  if (msg.type === 'navigate') {
    const tab = await findTab(msg);
    // nav to the URL the tab ALREADY shows is a reload — SPA state, scroll,
    // form inputs die. Agents do it to "make sure"; name the cost. (The
    // dialog-rescue nav is a deliberate reload — the warning is accurate
    // there too.)
    try {
      const from = new URL(tab.url), to = new URL(msg.url);
      if (from.href === to.href)
        msg._warn =
          '⚠ the tab was already at this URL — nav just reloaded it (state, scroll, form inputs reset). Skip nav to drive the existing page; when you want a refresh, this is it';
      // Hash-only: same document, no reload — the app is SUPPOSED to route on
      // hashchange, but some update location.hash without re-rendering
      // (Gmail search views, #26). loaded:true must not read as "the view
      // you asked for is on screen".
      else if (from.href.split('#')[0] === to.href.split('#')[0])
        msg._warn =
          '⚠ hash-only navigation — the document did not reload; the app routes on hashchange and may not re-render. If the view did not change, drive the app\'s own UI (its search box, in-app links), not the URL bar';
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
      const offLimits = await offLimitsLanding(tab.id);
      if (offLimits) return `succeeded · navigated to ${offLimits}`;
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
    // marking/recording: the tabs are about to not exist. Tabs another link
    // drives are skipped, not refused: --all cleans up THIS link's matches,
    // and a sibling link's live work is not that.
    if (msg.all) {
      const ts = await chrome.tabs.query({});
      const found = ts.filter((t) => tabMatches(t, msg.urlMatch));
      if (!found.length) throw new Error(`no tab matching "${msg.urlMatch}" — already closed? (the match is a URL/title substring)`);
      const matches = found.filter((t) => [null, msg._link].includes(ownerOf(t.id)));
      const skipped = found.length - matches.length;
      if (!matches.length)
        throw new Error(`all ${skipped} tab(s) matching "${msg.urlMatch}" are driven through another link — close --all only closes this link's tabs; nothing was closed`);
      for (const tab of matches) assertNotReclaimed(tab.id, msg);
      await chrome.tabs.remove(matches.map((t) => t.id));
      return skipped ? { closed: matches.length, skipped, note: `${skipped} matching tab(s) driven through another link were left open` } : { closed: matches.length };
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
    assertLinkOn(msg);
    if (!drivenTabs.has(tab.id)) tabOwner.set(tab.id, msg._link); // findTab skips mark's auto-mark — claim here
    await markTab(tab.id);
    return { id: tab.id };
  }

  if (msg.type === 'release') {
    const tab = await findTab(msg);
    await releaseTab(tab.id);
    return { id: tab.id };
  }

  // Bring a background tab to the front — the remedy the hidden-tab trusted
  // input refusal (#33) names. activate within its window, then focus the
  // window (a background WINDOW keeps the tab unfocused for CDP input too).
  if (msg.type === 'activate') {
    const tab = await findTab(msg);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    // Occlusion (#45): a Chrome window fully covered by other apps (or
    // minimized) keeps the tab visibilityState=hidden even after a successful
    // activate — an ok reply here is a lie the next --trusted command pays
    // for. Poll briefly (the visibilitychange lands async), then name the
    // working remedy: emulate focus.
    let vis = null;
    for (let i = 0; i < 6 && vis !== 'visible'; i++) {
      vis = await runEval(tab.id, 'document.visibilityState').catch(() => null);
      if (vis !== 'visible') await new Promise((r) => setTimeout(r, 150));
    }
    return vis === 'hidden'
      ? { id: tab.id, warning: 'tab is still hidden — the window is occluded or minimized and activate cannot un-occlude it. For trusted input: emulate <match> focus' }
      : { id: tab.id };
  }

  if (msg.type === 'eval') {
    const tab = await findTab(msg);
    return await runEval(tab.id, msg.code, msg.world);
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
    return await withSnap(tab.id, () => runEval(tab.id, SNAP_SRC(msg.scope, msg.diff, msg.href, msg.skeleton, msg.nofold)));
  }

  // --trusted: route click/press/type/hover/drag through CDP Input.dispatch*
  // (isTrusted=true events). Before the synthetic group so the flag wins.
  if (msg.trusted && ['click', 'press', 'type', 'hover', 'drag'].includes(msg.type)) {
    const tab = await findTab(msg);
    return await actAndVerify(tab.id, msg, (beforeDispatch) => trustedInput(tab, msg, beforeDispatch));
  }

  if (['click', 'fill', 'clear', 'type', 'press', 'hover'].includes(msg.type)) {
    const tab = await findTab(msg);
    const src =
      msg.type === 'click' ? clickSrc(msg.target, msg.dbl) :
      msg.type === 'fill' ? fillSrc(msg.target, msg.value) :
      msg.type === 'clear' ? clearSrc(msg.target) :
      msg.type === 'type' ? typeSrc(msg.target, msg.value) :
      msg.type === 'press' ? pressSrc(msg.key, msg.target) :
      hoverSrc(msg.target);
    // A strict-CSP page answers a navigating click/Enter with runEval's
    // navigated error (see its CDP fallback) — the action landed: report it
    // the way the scripting-world path does, so --diff reads the new page.
    const landed = (e) => {
      if (!e?.navigated || (msg.type !== 'click' && msg.type !== 'press')) throw e;
      return (msg.type === 'click' ? `clicked ${msg.target}${msg.dbl ? ' (double)' : ''}` : `pressed ${msg.key}${msg.target ? ' on ' + msg.target : ''}`) + ' — page navigating';
    };
    return await actAndVerify(tab.id, msg, () => runEval(tab.id, src).catch(landed));
  }

  if (msg.type === 'paste') {
    const tab = await findTab(msg);
    return await actAndVerify(tab.id, msg, () => runEval(tab.id, pasteSrc(msg.target, msg.value, msg.html)));
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

  if (msg.type === 'perf') {
    const tab = await findTab(msg);
    return await capturePerf(tab.id, msg.duration);
  }

  if (msg.type === 'net') {
    const tab = await findTab(msg);
    return await withCdp(tab.id, () => captureNetwork(tab.id, msg.duration, msg.filter, msg.body, msg.har, msg.ws, cloudLink(msg._link)));
  }

  if (msg.type === 'wait') {
    const tab = await findTab(msg);
    if (msg.human) return await waitHuman(tab, msg);
    if (msg.pixel) return await waitPixel(tab, msg);
    if (typeof msg.js === 'string' && msg.js) return await runEval(tab.id, waitJsSrc(msg), msg.world);
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
      // dsf echoes the factor actually pinned (mobile alone = 2, plain = 1).
      ...(msg.focus ? { focus: true } : { width: msg.width, height: msg.height, mobile: !!msg.mobile, dsf: msg.dsf || (msg.mobile ? 2 : 1) }),
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
