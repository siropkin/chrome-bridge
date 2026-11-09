// chrome-bridge popup. Main view: a status line and ONE card for the state the
// bridge is in, each with one main button —
//   not running  → copy the setup prompt for the agent
//   agent busy   → release its tabs (the human's emergency stop; the one
//                  reclaim path that works even when a driven tab can't show the
//                  pill: chrome://, Web Store, PDF)
//   idle         → copy this tab's id:<tabId> reference for the agent (the exact
//                  <match> every cli command understands — see findTab)
// plus an amber update banner when the extension and the bridge on disk differ.
// ⚙ opens Settings: Cloud access (Cloud Bridge pairing), diagnostic logs, the
// profile name. Tabs come from chrome.tabs (extension pages have the tabs
// permission too); release, cloud and logging ride the service worker via
// runtime messaging. Bridge status comes from GET /health — a GET, so the
// server's drive-by guards don't apply, and <all_urls> covers 127.0.0.1.
// The popup is tested in a vm whose elements are plain objects: no classList,
// document.body or timers here (className/textContent/hidden only).
// NOTE: 9333 is hardcoded in FOUR places — server.mjs, cli.mjs,
// background.js, here. Change all four.
const $ = (id) => document.getElementById(id);

const ownVersion = chrome.runtime.getManifest?.().version;
if (ownVersion) $('version').textContent = 'v' + ownVersion;

// The /health result and the worker's own answer (undefined = not yet; null =
// the worker is dead or mid-reload). Both fetches race; render() redraws the
// main view from whatever has arrived.
let bridgeHealth = null;
let bridgeDown = false;
let bridgeState;
let lastKnownState = null;
let updateNeeded = false;

function setStatus(text, kind) {
  $('bridge-status').className = kind;
  $('status-text').textContent = text;
}

function render() {
  // Release first, whatever the status line says: the worker's driven tabs
  // don't depend on the local helper (the cloud link drives tabs without it,
  // and a crashed server leaves its tabs marked) — the emergency stop must
  // never hide behind "Not running" or "Reconnecting…".
  // An unknown state (null: the worker didn't answer) keeps the last known
  // tabs — "unknown" must never read as "nothing to release".
  if (bridgeState) lastKnownState = bridgeState;
  const busy = (lastKnownState?.count || 0) > 0;
  renderDriven(busy);
  $('idle').hidden = true;
  if (bridgeDown) {
    setStatus('Not running', 'down');
    $('setup-card').hidden = false;
    return;
  }
  if (!bridgeHealth) return; // health hasn't answered yet: "Checking…" stays
  $('setup-card').hidden = true;
  if (!(bridgeHealth.ok && bridgeHealth.extension)) return setStatus('Starting…', '');
  // Per-profile truth: /health's `extension` is ANY seat — with several
  // profiles connected, this profile's own worker can be down (or mid-reload)
  // while another profile is fine. bridgeState.connected is this profile's
  // own socket (absent on an older worker — then health's flag stands).
  if (bridgeState === null) return setStatus('Reloading — reopen this in a moment', '');
  if (bridgeState && bridgeState.connected === false) return setStatus('Reconnecting…', '');
  if (updateNeeded) setStatus('Update needed', 'warn');
  else setStatus(busy ? 'Working' : 'Ready', busy ? 'busy' : 'ok');
  if (bridgeState) $('idle').hidden = busy;
}

function renderDriven(busy) {
  $('driven').hidden = !busy;
  if (busy) {
    const n = lastKnownState.count;
    $('driven-count').textContent = `🟣 AI is using ${n} tab${n > 1 ? 's' : ''}`;
    $('release-all').textContent = n > 1 ? `Release all ${n} tabs` : 'Release it';
    // Only this profile's tabs: with several profiles connected, the stop button
    // must not read wider than it is.
    const several = (bridgeHealth?.profiles?.length || 0) > 1;
    $('driven-msg').textContent = 'Tabs it uses wear a 🟣 pill. Releasing hands them back to you' + (several ? ' (in this Chrome profile).' : '.');
    $('release-tab').hidden = !(lastKnownState.active && n > 1);
  }
}

// Version drift: Chrome auto-updates a store extension, but the bridge on disk
// (server, CLI, the agent's skill) only moves when someone runs `cli.mjs
// update` — the human sees it here and hands the fix to their agent. A server
// without h.v predates version reporting: no banner (health warns).
let updatePrompt = '';
function renderUpdate() {
  const h = bridgeHealth;
  if (!ownVersion || !h?.v) return;
  let text = null;
  if (h.v !== ownVersion) text = `This extension is ${ownVersion}; the bridge on your computer is ${h.v}.`;
  else if (h.disk && h.disk !== h.v) text = `The bridge on your computer was updated to ${h.disk} but still runs ${h.v}.`;
  if (!text) return;
  const cli = `${String(h.repo || '').replace(/[\\/]$/, '')}/cli.mjs`;
  updatePrompt = `My chrome-bridge is out of step: ${text} Run node "${cli}" update, then node "${cli}" health, and tell me what changed and whether anything still needs me (for example, reloading the extension at chrome://extensions).`;
  $('update-text').textContent = text + ' Your agent can update it.';
  $('update').hidden = false;
  updateNeeded = true;
}
const copyTo = (text, out, done) =>
  navigator.clipboard.writeText(text).then(
    () => {
      $(out).textContent = done;
    },
    (e) => {
      $(out).textContent = 'Copy failed: ' + e;
    }
  );
$('copy-update').addEventListener('click', () => copyTo(updatePrompt, 'update-status', 'Copied ✓ — paste it to your agent'));

fetch('http://127.0.0.1:9333/health', { signal: AbortSignal.timeout(4000) }) // 2s was tight enough to false-negative on a busy server mid-screenshot
  .then((r) => r.json())
  .then((h) => {
    bridgeHealth = h;
    renderUpdate();
    render();
  })
  .catch(() => {
    bridgeDown = true;
    render();
  });

// The setup prompt: the main card while the bridge isn't running, and a
// Settings row for connecting one more agent once it is.
const copySetup = (out) =>
  fetch(chrome.runtime.getURL('setup-prompt.txt'))
    .then((r) => r.text())
    .then((text) => navigator.clipboard.writeText(text))
    .then(
      () => {
        $(out).textContent = 'Copied ✓ — paste it to your agent';
      },
      (e) => {
        $(out).textContent = 'Copy failed: ' + e;
      }
    );
$('setup').addEventListener('click', () => copySetup('setup-status'));
$('setup-again').addEventListener('click', () => copySetup('setup-again-status'));

chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
  if (!tab) {
    $('copy').disabled = true;
    return;
  }
  // The reference names the profile once the worker says which it is: with
  // several profiles connected an agent otherwise has to ask, and the human
  // only knows their profiles by Chrome's names, never the bridge's.
  let ref = 'id:' + tab.id;
  $('copy').title = ref;
  $('copy').addEventListener('click', () => copyTo(ref, 'status', `Copied ${ref} ✓ — paste it to your agent`));
  const refreshState = async () => {
    const state = await chrome.runtime.sendMessage({ type: 'bridge-state', tabId: tab.id });
    if (state?.error || !Number.isInteger(state?.count) || state.count < 0 || typeof state.active !== 'boolean') throw new Error(state?.error || 'Tab state unavailable');
    bridgeState = state;
    if (state.cloud) renderCloud(state.cloud);
    if (typeof state.profile === 'string' && /^[a-z]+$/.test(state.profile)) {
      ref = `id:${tab.id} --profile ${state.profile}`;
      $('copy').title = ref;
      $('profile-name').textContent = state.profile;
      $('profile').hidden = false;
    }
    render();
  };
  const release = (btn, msg) => {
    btn.addEventListener('click', async () => {
      $('release-tab').disabled = $('release-all').disabled = true;
      let failure;
      try {
        const response = await chrome.runtime.sendMessage(msg);
        if (response?.error || !Number.isInteger(response?.count) || response.count < 0) throw new Error(response?.error || 'Release acknowledgement unavailable');
      } catch (error) {
        failure = error;
      }
      try {
        await refreshState();
      } catch (error) {
        failure ||= error;
        bridgeState = null;
        render();
      }
      $('status').textContent = failure ? 'Release failed: ' + failure : 'Released ✓ — the tabs are yours again';
      $('release-tab').disabled = $('release-all').disabled = false;
    });
  };
  release($('release-tab'), { type: 'release-active', tabId: tab.id });
  release($('release-all'), { type: 'release-all' });
  await refreshState().catch(() => {
    bridgeState = null;
    render();
  });
});

// --- Settings view ------------------------------------------------------------
$('open-settings').addEventListener('click', () => {
  $('main').hidden = true;
  $('settings-view').hidden = false;
  loggingRequest('status');
});
$('close-settings').addEventListener('click', () => {
  $('settings-view').hidden = true;
  $('main').hidden = false;
});

// Cloud access (Cloud Bridge): pair this profile with a hub (a device code the
// user confirms in a tab), switch the link on/off, disconnect. The worker owns
// the link and the pairing poll; its state rides on bridge-state, which every
// popup open asks for. Opening the confirmation tab closes the popup —
// reopening it shows the result, so no timers and no refresh here.
let cloudState = null;
let cloudFormOpen = false; // the switch went on while unpaired: keep the form, even through a failed Connect
function renderCloud(state, error) {
  if (state && typeof state.paired === 'boolean') cloudState = state;
  const s = cloudState;
  if (!s) {
    $('cloud-status').textContent = error || 'Unavailable — reopen the popup';
    return;
  }
  let host = '';
  try {
    host = s.hub ? new URL(s.hub).host : '';
  } catch {}
  $('cloud-hub').value = $('cloud-hub').value || s.hub || '';
  // Unpaired, the switch is the way in: turning it on shows the address form.
  if (s.paired) cloudFormOpen = false;
  const formOpen = !s.paired && (!!s.pairing || cloudFormOpen);
  $('cloud-enabled').checked = s.paired ? s.enabled : formOpen;
  $('cloud-pair-row').hidden = !formOpen;
  $('cloud-paired').hidden = !s.paired;
  $('cloud-pair').textContent = s.pairing ? 'Start again' : 'Connect';
  $('cloud-code').hidden = !s.pairing;
  if (s.pairing) $('cloud-code').textContent = `Code ${s.pairing.code} — confirm it in the tab that opened (${s.pairing.verificationUri})`;
  let line;
  if (s.pairing) line = 'Waiting for you to confirm at Cloud Bridge…';
  else if (!s.paired) line = 'Let Claude.ai or ChatGPT use this browser';
  else if (!s.enabled) line = `Off · connected to ${host}`;
  else if (s.connected) line = `On · cloud AI apps can use “${s.profile}”`;
  else line = `On · reaching ${host}…`;
  $('cloud-status').textContent = [error, s.notice, line].filter(Boolean).join(' · ');
}
async function cloudRequest(msg) {
  for (const id of ['cloud-pair', 'cloud-enabled', 'cloud-unpair']) $(id).disabled = true;
  let response;
  try {
    response = await chrome.runtime.sendMessage(msg);
  } catch (error) {
    response = { ok: false, error: String(error) };
  }
  $('cloud-pair').disabled = $('cloud-unpair').disabled = $('cloud-enabled').disabled = false;
  renderCloud(response, response?.ok === false ? response.error || 'Request failed' : '');
}
$('cloud-pair').addEventListener('click', () => cloudRequest({ type: 'cloud-pair', hub: $('cloud-hub').value.trim() }));
$('cloud-enabled').addEventListener('change', () => {
  if (cloudState?.paired) return cloudRequest({ type: 'cloud-toggle', enabled: $('cloud-enabled').checked });
  // Not paired yet: the switch only opens (or closes) the address form.
  cloudFormOpen = $('cloud-enabled').checked;
  $('cloud-pair-row').hidden = !cloudFormOpen;
});
$('cloud-unpair').addEventListener('click', () => cloudRequest({ type: 'cloud-unpair' }));
$('cloud-copy-mcp').addEventListener('click', () => {
  const url = new URL('/mcp', cloudState.hub).href;
  copyTo(url, 'cloud-status', `Copied ${url} ✓ — add it as a custom connector in Claude or ChatGPT`);
});

// Diagnostic logs: the switch saves at once; the size limit, folder and
// delete live under Details.
let loggingState = null;
let loggingBusy = false;
function renderLogging() {
  $('logging-enabled').indeterminate = !loggingState;
  if (!loggingState) {
    $('logging-enabled').checked = false;
    $('log-limit').value = '';
    $('log-folder').value = '';
    $('logging-status').textContent = 'State unknown: status unavailable. Retry or reopen Settings.';
    return;
  }
  $('logging-enabled').checked = loggingState.enabled;
  $('log-limit').value = String(loggingState.limitMiB);
  $('log-folder').value = loggingState.directory;
  // Usage only when there is something to report: an empty "Off · 0.00 / 10 MiB" is noise.
  const usage = loggingState.bytes == null ? 'usage unavailable' : loggingState.bytes || loggingState.enabled ? `${(loggingState.bytes / 1024 / 1024).toFixed(2)} / ${loggingState.limitMiB} MiB` : '';
  $('logging-status').textContent = [loggingState.enabled ? 'On' : 'Off', usage, loggingState.error ? 'Storage error' : ''].filter(Boolean).join(' · ');
}

async function loggingRequest(action, extra = {}) {
  if (loggingBusy || (action !== 'status' && !loggingState)) return;
  loggingBusy = true;
  for (const id of ['logging-enabled', 'log-limit', 'logging-save', 'logging-delete', 'logging-confirm']) $(id).disabled = true;
  $('logging-retry').disabled = true;
  const request = async (requestedAction, values = {}) => {
    const response = await chrome.runtime.sendMessage({ type: 'diagnostics', action: requestedAction, ...values });
    const result = response?.result;
    if (!response?.ok || typeof result?.enabled !== 'boolean' || !Number.isInteger(result.limitMiB) || result.limitMiB < 1 || result.limitMiB > 100) throw new Error('Settings unavailable');
    return result;
  };
  try {
    loggingState = await request(action, extra);
    renderLogging();
  } catch {
    loggingState = null;
    if (action !== 'status') {
      try {
        loggingState = await request('status');
      } catch {}
    }
    renderLogging();
    if (loggingState) $('logging-status').textContent = 'Change acknowledgement unavailable; current status refreshed. ' + $('logging-status').textContent;
  } finally {
    loggingBusy = false;
    for (const id of ['logging-enabled', 'log-limit', 'logging-save']) $(id).disabled = !loggingState;
    $('logging-delete').disabled = !loggingState || loggingState.bytes === 0;
    $('logging-confirm').disabled = !loggingState;
    $('logging-retry').hidden = !!loggingState;
    $('logging-retry').disabled = false;
  }
}

async function saveLimit() {
  const limitMiB = Number($('log-limit').value);
  if (!Number.isInteger(limitMiB) || limitMiB < 1 || limitMiB > 100) {
    $('logging-status').textContent = 'Enter a whole-number limit from 1 to 100 MiB.';
    return;
  }
  await loggingRequest('configure', { enabled: $('logging-enabled').checked, limitMiB });
}
$('logging-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveLimit();
});
// The switch saves only on/off, with the SAVED limit: an unsaved (or invalid)
// value in Details must neither block the switch nor ride along with it.
$('logging-enabled').addEventListener('change', async () => {
  if (!loggingState) return renderLogging();
  await loggingRequest('configure', { enabled: $('logging-enabled').checked, limitMiB: loggingState.limitMiB });
});
$('logging-retry').addEventListener('click', () => loggingRequest('status'));
$('logging-delete').addEventListener('click', () => {
  $('logging-confirmation').hidden = false;
});
$('logging-cancel').addEventListener('click', () => {
  $('logging-confirmation').hidden = true;
});
$('logging-confirm').addEventListener('click', async () => {
  await loggingRequest('clear');
  $('logging-confirmation').hidden = true;
});
