// chrome-bridge popup. Main view: "Chrome Bridge" + ⚙, a status line that says
// what is true in full words, and ONE card —
//   no AI agent connected → copy the setup prompt for the agent
//   otherwise             → copy this tab's id:<tabId> reference for the agent
//                           (the exact <match> every cli command understands)
// While the agent drives tabs, Stop all / Stop this tab sit under the status
// (the human's emergency stop — the one reclaim path that works even when a
// driven tab can't show the pill: chrome://, Web Store, PDF). An amber banner
// asks for an update when the extension and the bridge on disk differ.
// The header names this Chrome profile the way agents do ("poplar"). ⚙ opens
// Settings: the two ways an AI reaches the browser — local AI agents (setup
// prompt) and cloud AI apps (Cloud Bridge) — then diagnostic logs.
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
    $('local-status').textContent = 'Not connected: the helper on this computer isn\'t running';
    // Cloud-only is a complete setup: cloud AI apps reach this browser without
    // the local helper, so don't call it "not connected" or push the local setup.
    const c = lastKnownState?.cloud;
    if (c?.paired && c.enabled && c.connected) {
      $('setup-card').hidden = true;
      $('idle').hidden = false;
      if (busy) setStatus(`AI is working in ${n} tab${n > 1 ? 's' : ''}`, 'busy');
      else setStatus('Ready for cloud AI apps', 'ok');
      return;
    }
    setStatus('Not connected to an AI agent', 'down');
    $('setup-card').hidden = false;
    return;
  }
  if (!bridgeHealth) return; // health hasn't answered yet: "Checking…" stays
  $('setup-card').hidden = true;
  // Until this profile's own socket is up, local agents can't use it yet.
  $('local-status').textContent = 'Connecting to the helper on this computer…';
  if (!(bridgeHealth.ok && bridgeHealth.extension)) return setStatus('Connecting to your AI agent…', '');
  // Per-profile truth: /health's `extension` is ANY seat — with several
  // profiles connected, this profile's own worker can be down (or mid-reload)
  // while another profile is fine. bridgeState.connected is this profile's
  // own socket (absent on an older worker — then health's flag stands).
  if (bridgeState === null) return setStatus('Reloading — reopen this in a moment', '');
  if (bridgeState && bridgeState.connected === false) {
    $('idle').hidden = false; // a blip: the tab ID stays valid
    return setStatus('Reconnecting to your AI agent…', '');
  }
  $('local-status').textContent = 'Connected: agents on this computer can use this browser';
  if (updateNeeded) setStatus('Update needed', 'warn');
  else if (busy) setStatus(`AI is working in ${n} tab${n > 1 ? 's' : ''}`, 'busy');
  else setStatus('Ready for your AI agent', 'ok');
  if (bridgeState) $('idle').hidden = false; // the tab ID stays copyable while the agent works
}

// Stop all (this profile's agent tabs — with several profiles connected, the
// tooltip must not read wider than it is) and Stop this tab, under the status.
// One driven tab: a single "Stop" covers it.
function renderStop(n) {
  $('stop-row').hidden = n === 0;
  const several = (bridgeHealth?.profiles?.length || 0) > 1;
  $('release-all').textContent = n > 1 ? 'Stop all' : 'Stop';
  $('release-all').title = `Stop the agent in ${n > 1 ? `all ${n} tabs` : 'its tab'}${several ? ' (this Chrome profile)' : ''}`;
  $('release-tab').hidden = !(n > 1 && lastKnownState?.active);
  $('release-tab').title = 'Stop the agent in this tab only';
}

// Version drift: Chrome auto-updates a store extension, but the bridge on disk
// (server, CLI, the agent's skill) only moves when someone runs `cli.mjs
// update` — the human sees it here and hands the fix to their agent. A server
// without h.v predates version reporting: no banner (health warns).
let updatePrompt = '';
function renderUpdate() {
  const h = bridgeHealth;
  if (!ownVersion || !h?.v) return;
  // Precise versions go to the agent (the prompt) and the tooltip; the person
  // reads what it means and what to do.
  let text = null;
  let plain = null;
  if (h.v !== ownVersion) {
    text = `This extension is ${ownVersion}; the bridge on your computer is ${h.v}.`;
    plain = 'Chrome Bridge on your computer and this extension are different versions.';
  } else if (h.disk && h.disk !== h.v) {
    text = `The bridge on your computer was updated to ${h.disk} but still runs ${h.v}.`;
    plain = 'Chrome Bridge on your computer was updated but still runs the old version.';
  }
  if (!text) return;
  const cli = `${String(h.repo || '').replace(/[\\/]$/, '')}/cli.mjs`;
  updatePrompt = `My chrome-bridge is out of step: ${text} Run node "${cli}" update, then node "${cli}" health, and tell me what changed and whether anything still needs me (for example, reloading the extension at chrome://extensions).`;
  $('update-text').textContent = plain + ' Copy this prompt to your AI agent and it will update it.';
  $('update-text').title = text;
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

// Cloud AI apps (Cloud Bridge). The switch means "connected or not": on starts
// the connection (the address form → a code the user confirms in a tab), off
// signs this browser out (the worker forgets the token). The worker owns the
// link and the pairing poll; its state rides on bridge-state, which every
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
  // Waiting for the code: the switch is on, the address form gives way to the code.
  const formOpen = !s.paired && !s.pairing && cloudFormOpen;
  const connected = s.paired && s.enabled;
  $('cloud-enabled').checked = connected || formOpen || !!s.pairing;
  $('cloud-pair-row').hidden = !formOpen;
  $('cloud-paired').hidden = !connected;
  $('cloud-off-hint').hidden = !connected;
  if (!connected) $('cloud-help').hidden = true;
  $('cloud-code').hidden = !s.pairing;
  if (s.pairing) {
    // textContent + a <b> built by hand: the code comes from the hub (no innerHTML).
    const code = document.createElement?.('b');
    if (code) {
      code.textContent = s.pairing.code;
      $('cloud-code-text').replaceChildren('Your code: ', code, '. Check it matches, then click Connect on that page.');
    } else $('cloud-code-text').textContent = `Your code: ${s.pairing.code}. Check it matches, then click Connect on that page.`;
    // From the hub, via the worker: a web page or nothing.
    $('cloud-open-page').href = /^https?:\/\//i.test(String(s.pairing.verificationUri)) ? s.pairing.verificationUri : '#';
  }
  // The switch already says on/off: the line says what that means right now.
  let line;
  if (s.pairing) line = 'Waiting for you to confirm on Cloud Bridge…';
  else if (!connected) line = 'Let Claude.ai or ChatGPT use this browser';
  else if (s.connected) line = 'Connected: Claude.ai and ChatGPT apps you add can use this browser';
  else line = "Can't reach Cloud Bridge right now — retrying";
  $('cloud-status').title = host ? 'Cloud Bridge: ' + host : '';
  $('cloud-status').textContent = [error, s.notice, line].filter(Boolean).join(' · ');
}
async function cloudRequest(msg) {
  for (const id of ['cloud-pair', 'cloud-enabled']) $(id).disabled = true;
  let response;
  try {
    response = await chrome.runtime.sendMessage(msg);
  } catch (error) {
    response = { ok: false, error: String(error) };
  }
  $('cloud-pair').disabled = $('cloud-enabled').disabled = false;
  renderCloud(response, response?.ok === false ? response.error || 'Request failed' : '');
}
$('cloud-pair').addEventListener('click', () => cloudRequest({ type: 'cloud-pair', hub: $('cloud-hub').value.trim() }));
$('cloud-enabled').addEventListener('change', () => {
  const on = $('cloud-enabled').checked;
  cloudFormOpen = false;
  // Off = sign out: forget the token (and any pending code), drop the link.
  if (!on) {
    $('cloud-pair-row').hidden = true;
    if (cloudState?.paired || cloudState?.pairing) return cloudRequest({ type: 'cloud-unpair' });
    return;
  }
  // On: a profile paused by an older version reconnects with its token;
  // otherwise the address form opens (prefilled with the last address).
  if (cloudState?.paired) return cloudRequest({ type: 'cloud-toggle', enabled: true });
  cloudFormOpen = true;
  $('cloud-pair-row').hidden = false;
});
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

// Diagnostic logs: the switch saves at once; while logging is on, the size
// limit (saves on change) and the folder show under it. Delete shows whenever
// records exist — also after logging was turned off.
let loggingState = null;
let loggingBusy = false;
function renderLogging() {
  $('logging-enabled').indeterminate = !loggingState;
  $('logging-details').hidden = !loggingState?.enabled;
  $('logging-delete').hidden = !(loggingState?.bytes > 0);
  if (!loggingState) {
    $('logging-enabled').checked = false;
    $('log-limit').value = '';
    $('log-folder').value = '';
    $('logging-status').textContent = "Couldn't read this setting: logs live in the helper on this computer (see Local AI agents).";
    return;
  }
  $('logging-enabled').checked = loggingState.enabled;
  $('log-limit').value = String(loggingState.limitMiB);
  $('log-folder').value = loggingState.directory;
  // The switch says on/off; the line says what that means: how much is used.
  const mb = (b) => (b / 1024 / 1024).toFixed(1).replace(/\.0$/, '');
  let line;
  if (!loggingState.enabled) line = loggingState.bytes ? `${mb(loggingState.bytes)} MB of older logs kept` : 'Local files that help debug problems';
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
$('logging-details').addEventListener('submit', async (event) => {
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
// Delete asks first: Cancel and Delete side by side, the link waits meanwhile.
$('logging-delete').addEventListener('click', () => {
  $('logging-confirmation').hidden = false;
  $('logging-delete').hidden = true;
});
$('logging-cancel').addEventListener('click', () => {
  $('logging-confirmation').hidden = true;
  $('logging-delete').hidden = !(loggingState?.bytes > 0);
});
$('logging-confirm').addEventListener('click', async () => {
  await loggingRequest('clear');
  $('logging-confirmation').hidden = true;
});
