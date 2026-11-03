// chrome-bridge popup — three jobs: copy the active tab's id:<tabId> reference
// (the exact <match> every cli command understands — see findTab), hand a
// first-time user the self-contained setup prompt for their agent, and the
// human's release controls — the one reclaim path that works even when a
// driven tab can't show the pill (chrome://, Web Store, PDF). Pure popup for
// tabs (extension pages have the tabs permission too); release rides the
// service worker via runtime messaging.
// Bridge status comes from GET /health — a GET, so the server's drive-by
// guards don't apply, and <all_urls> host permission covers 127.0.0.1.
// NOTE: 9333 is hardcoded in FOUR places — server.mjs, cli.mjs,
// background.js, here. Change all four.
const $ = (id) => document.getElementById(id);

// The /health result, kept for the release-all scope copy (profile count) and
// the per-profile connection check below. bridgeState: the worker's own answer
// (undefined = not yet). Both fetches race, so both paths re-render the line.
let bridgeHealth = null;
let bridgeState; // undefined = not yet answered; null = the worker is dead/mid-reload
function renderStatus() {
  if (!bridgeHealth) return; // health hasn't answered — the catch below owns the line
  // "All" is all tabs THIS profile's worker drives — with several profiles
  // connected, the panic button must not read wider than it is.
  if ((bridgeHealth.profiles?.length || 0) > 1) $('release-all').textContent = 'Release all agent tabs (this profile)';
  const el = $('bridge-status');
  el.className = '';
  if (!(bridgeHealth.ok && bridgeHealth.extension)) {
    $('status-text').textContent = 'server up — waiting for the extension…';
    return;
  }
  // Per-profile truth: /health's `extension` is ANY seat — with several
  // profiles connected, this profile's own worker can be down (or mid-reload)
  // while the popup claims "ready". bridgeState.connected is this profile's
  // own socket (absent on an older loaded extension — then health's flag stands).
  if (bridgeState && bridgeState.connected === false) {
    $('status-text').textContent = "server up — this profile's bridge is reconnecting…";
    return;
  }
  if (bridgeState === null) {
    $('status-text').textContent = "this profile's bridge is reloading — reopen the popup in a moment";
    return;
  }
  el.className = 'ok';
  $('status-text').textContent = 'bridge ready';
}
fetch('http://127.0.0.1:9333/health', { signal: AbortSignal.timeout(4000) }) // 2s was tight enough to false-negative on a busy server mid-screenshot
  .then((r) => r.json())
  .then((h) => {
    bridgeHealth = h;
    renderStatus();
  })
  .catch(() => {
    $('bridge-status').className = 'down';
    $('status-text').textContent = 'bridge not running';
  });

chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
  if (!tab) {
    $('title').textContent = 'no active tab';
    $('copy').disabled = true;
    return;
  }
  $('title').textContent = tab.title || tab.url || '(untitled)';
  $('ref').textContent = 'id:' + tab.id;
  $('copy').addEventListener('click', () => {
    navigator.clipboard.writeText('id:' + tab.id).then(
      () => {
        $('status').textContent = 'Copied ✓';
      },
      (e) => {
        $('status').textContent = 'Copy failed: ' + e;
      }
    );
  });
  // Driven-tab controls — the emergency stop. Hidden entirely while nothing
  // is driven: a calm popup shows nothing to stop.
  const refreshState = async () => {
    const state = await chrome.runtime.sendMessage({ type: 'bridge-state', tabId: tab.id });
    if (state?.error || !Number.isInteger(state?.count) || state.count < 0 || typeof state.active !== 'boolean') throw new Error(state?.error || 'Tab state unavailable');
    bridgeState = state;
    renderStatus();
    $('driven').hidden = state.count === 0;
    $('driven-count').textContent = `🟣 ${state.count} tab${state.count > 1 ? 's' : ''} driven by your AI agent`;
    $('release-tab').hidden = !state.active;
    $('release-all').hidden = state.count === 0;
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
        renderStatus();
      }
      $('status').textContent = failure ? 'Release failed: ' + failure : 'Released ✓ — the tab(s) are yours again';
      $('release-tab').disabled = $('release-all').disabled = false;
    });
  };
  release($('release-tab'), { type: 'release-active', tabId: tab.id });
  release($('release-all'), { type: 'release-all' });
  await refreshState().catch(() => {
    bridgeState = null;
    renderStatus();
  });
});

$('setup').addEventListener('click', () => {
  fetch(chrome.runtime.getURL('setup-prompt.txt'))
    .then((r) => r.text())
    .then((text) => navigator.clipboard.writeText(text))
    .then(
      () => {
        $('status').textContent = 'Setup prompt copied ✓ — paste it to your agent';
      },
      (e) => {
        $('status').textContent = 'Copy failed: ' + e;
      }
    );
});

let loggingState = null;
let loggingBusy = false;
function renderLogging() {
  $('logging-enabled').indeterminate = !loggingState;
  if (!loggingState) {
    $('logging-enabled').checked = false;
    $('log-limit').value = '';
    $('log-folder').value = '';
    $('logging-status').textContent = 'Logging state unknown: status unavailable. Retry or reopen Settings.';
    return;
  }
  $('logging-enabled').checked = loggingState.enabled;
  $('log-limit').value = String(loggingState.limitMiB);
  $('log-folder').value = loggingState.directory;
  const usage = loggingState.bytes == null ? 'usage unavailable' : `${(loggingState.bytes / 1024 / 1024).toFixed(2)} / ${loggingState.limitMiB} MiB`;
  $('logging-status').textContent = `${loggingState.enabled ? 'On' : 'Off'} · ${usage}${loggingState.error ? ' · Storage error' : ''}`;
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

$('logging-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const limitMiB = Number($('log-limit').value);
  if (!Number.isInteger(limitMiB) || limitMiB < 1 || limitMiB > 100) {
    $('logging-status').textContent = 'Enter a whole-number limit from 1 to 100 MiB.';
    return;
  }
  await loggingRequest('configure', { enabled: $('logging-enabled').checked, limitMiB });
});
$('settings').addEventListener('toggle', () => {
  if ($('settings').open) loggingRequest('status');
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
