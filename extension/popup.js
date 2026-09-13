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
  const el = $('bridge-status');
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
  const state = await chrome.runtime.sendMessage({ type: 'bridge-state', tabId: tab.id }).catch(() => null);
  bridgeState = state;
  renderStatus();
  if (!state?.count) return;
  $('driven').hidden = false;
  $('driven-count').textContent = `🟣 ${state.count} tab${state.count > 1 ? 's' : ''} driven by your AI agent`;
  // "All" is all tabs THIS profile's worker drives — with several profiles
  // connected, the panic button must not read wider than it is.
  if ((bridgeHealth?.profiles?.length || 0) > 1) $('release-all').textContent = 'Release all agent tabs (this profile)';
  const release = (btn, msg) => {
    btn.hidden = false;
    btn.addEventListener('click', () => {
      chrome.runtime
        .sendMessage(msg)
        .then((r) => {
          // The worker resolves {error} on failure — a caught release error
          // must never print the success line: the emergency stop's worst
          // bug is a silent failure wearing a ✓.
          if (r?.error) {
            $('status').textContent = 'Release failed: ' + r.error;
            return;
          }
          $('driven').hidden = true;
          $('status').textContent = 'Released ✓ — the tab(s) are yours again';
        })
        .catch((e) => {
          $('status').textContent = 'Release failed: ' + e;
        });
    });
  };
  if (state.active) release($('release-tab'), { type: 'release-active', tabId: tab.id });
  release($('release-all'), { type: 'release-all' });
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
