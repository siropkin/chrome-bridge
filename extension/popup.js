// chrome-bridge popup. Main view: a status line, and ONE card —
//   helper not running → copy the setup prompt for the agent
//   otherwise          → copy this tab's id:<tabId> reference for the agent
//                        (the exact <match> every cli command understands)
// While the agent drives tabs, the status says so and a red ■ beside ⚙ stops
// it in all of them (the human's emergency stop — the one reclaim path that
// works even when a driven tab can't show the pill: chrome://, Web Store, PDF);
// "Stop the agent in this tab" appears when this tab is one of them. An amber
// banner asks for an update when the extension and the bridge on disk differ.
// ⚙ opens Settings: this profile's name, agents on this computer (setup
// prompt), cloud AI apps (Cloud Bridge), diagnostic logs.
// Tabs come from chrome.tabs; stop, cloud and logging ride the service worker
// via runtime messaging. Bridge status comes from GET /health — a GET, so the
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
  // Stop first, whatever the status line says: the worker's driven tabs don't
  // depend on the local helper (the cloud link drives tabs without it, and a
  // crashed server leaves its tabs marked) — the emergency stop must never
  // hide behind "Not running" or "Reconnecting…". An unknown state (null: the
  // worker didn't answer) keeps the last known tabs — "unknown" must never
  // read as "nothing to stop".
  if (bridgeState) lastKnownState = bridgeState;
  const n = lastKnownState?.count || 0;
  const busy = n > 0;
  renderStop(n);
  $('idle').hidden = true;
  if (bridgeDown) {
    setStatus('Not running', 'down');
    $('local-status').textContent = "The helper isn't running — copy the setup prompt into your agent";
    $('setup-card').hidden = false;
    return;
  }
  if (!bridgeHealth) return; // health hasn't answered yet: "Checking…" stays
  $('setup-card').hidden = true;
  $('local-status').textContent = 'Claude Code, Cursor and others can use this browser';
  if (!(bridgeHealth.ok && bridgeHealth.extension)) return setStatus('Starting…', '');
  // Per-profile truth: /health's `extension` is ANY seat — with several
  // profiles connected, this profile's own worker can be down (or mid-reload)
  // while another profile is fine. bridgeState.connected is this profile's
  // own socket (absent on an older worker — then health's flag stands).
  if (bridgeState === null) return setStatus('Reloading — reopen this in a moment', '');
  if (bridgeState && bridgeState.connected === false) return setStatus('Reconnecting…', '');
  if (updateNeeded) setStatus('Update needed', 'warn');
  else if (busy) setStatus(`Working in ${n} tab${n > 1 ? 's' : ''}`, 'busy');
  else setStatus('Ready', 'ok');
  if (bridgeState) $('idle').hidden = false; // the tab ID stays copyable while the agent works
}

// The ■ beside ⚙ (all of this profile's agent tabs — with several profiles
// connected, the label must not read wider than it is) and the in-card link
// for this tab only.
function renderStop(n) {
  $('release-all').hidden = n === 0;
  const several = (bridgeHealth?.profiles?.length || 0) > 1;
  const label = `Stop the agent in ${n > 1 ? `all ${n} tabs` : 'its tab'}${several ? ' (this Chrome profile)' : ''}`;
  $('release-all').title = label;
  $('release-all').setAttribute?.('aria-label', label);
  $('release-tab').hidden = !(n > 0 && lastKnownState?.active);
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
        if (response?.error || !Number.isInteger(response?.count) || response.count < 0) throw new Error(response?.error || 'no acknowledgement from the extension');
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
      $('status').textContent = failure ? 'Stop failed: ' + failure : 'Stopped ✓ — the tabs are yours again';
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
  if (!s.paired) $('cloud-help').hidden = true;
  $('cloud-pair').textContent = s.pairing ? 'Start again' : 'Connect';
  $('cloud-code').hidden = !s.pairing;
  if (s.pairing) $('cloud-code').textContent = `Code ${s.pairing.code} — confirm it in the tab that opened (${s.pairing.verificationUri})`;
  // The switch already says on/off: the line says what that means right now.
  let line;
  if (s.pairing) line = 'Waiting for you to confirm in the tab that opened…';
  else if (!s.paired) line = 'Let Claude.ai or ChatGPT use this browser';
  else if (!s.enabled) line = "Paused: cloud AI apps can't use this browser";
  else if (s.connected) line = 'Claude.ai and ChatGPT can use this browser';
  else line = "Can't reach Cloud Bridge right now — retrying";
  $('cloud-status').title = host ? 'Cloud Bridge: ' + host : '';
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
// Add to Claude or ChatGPT: the connector link alone means nothing to the
// app's user — the steps say where it goes.
$('cloud-add').addEventListener('click', () => {
  $('cloud-help').hidden = !$('cloud-help').hidden;
});
$('cloud-copy-mcp').addEventListener('click', () => {
  navigator.clipboard.writeText(new URL('/mcp', cloudState.hub).href).then(
    () => {
      $('cloud-copy-mcp').textContent = 'Copied ✓';
    },
    (e) => {
      $('cloud-copy-mcp').textContent = 'Copy failed: ' + e;
    }
  );
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
    $('logging-status').textContent = "Couldn't read this setting (status unavailable). Retry or reopen Settings.";
    return;
  }
  $('logging-enabled').checked = loggingState.enabled;
  $('log-limit').value = String(loggingState.limitMiB);
  $('log-folder').value = loggingState.directory;
  // The switch says on/off; the line says what that means: how much is used.
  const mb = (b) => (b / 1024 / 1024).toFixed(1).replace(/\.0$/, '');
  let line;
  if (!loggingState.enabled) line = loggingState.bytes ? `Off · ${mb(loggingState.bytes)} MB kept from before` : 'Local files that help debug problems';
  else line = loggingState.bytes == null ? `Up to ${loggingState.limitMiB} MB` : `Using ${mb(loggingState.bytes)} of ${loggingState.limitMiB} MB`;
  $('logging-status').textContent = line + (loggingState.error ? ' · storage error' : '');
}

async function loggingRequest(action, extra = {}) {
  if (loggingBusy || (action !== 'status' && !loggingState)) return;
  loggingBusy = true;
  for (const id of ['logging-enabled', 'log-limit', 'logging-delete', 'logging-confirm']) $(id).disabled = true;
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
    for (const id of ['logging-enabled', 'log-limit']) $(id).disabled = !loggingState;
    $('logging-delete').disabled = !loggingState || loggingState.bytes === 0;
    $('logging-confirm').disabled = !loggingState;
    $('logging-retry').hidden = !!loggingState;
    $('logging-retry').disabled = false;
  }
}

async function saveLimit() {
  const limitMiB = Number($('log-limit').value);
  if (!Number.isInteger(limitMiB) || limitMiB < 1 || limitMiB > 100) {
    $('logging-status').textContent = 'Enter a whole number of MB from 1 to 100.';
    return;
  }
  await loggingRequest('configure', { enabled: $('logging-enabled').checked, limitMiB });
}
// The limit saves itself on change (Enter submits the form — same save).
$('logging-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveLimit();
});
$('log-limit').addEventListener('change', saveLimit);
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
