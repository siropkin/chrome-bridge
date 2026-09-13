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

fetch('http://127.0.0.1:9333/health', { signal: AbortSignal.timeout(2000) })
  .then((r) => r.json())
  .then((h) => {
    const el = $('bridge-status');
    if (h.ok && h.extension) {
      el.className = 'ok';
      $('status-text').textContent = 'bridge ready';
    } else {
      $('status-text').textContent = 'server up — waiting for the extension…';
    }
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
  if (!state?.count) return;
  $('driven').hidden = false;
  $('driven-count').textContent = `🟣 ${state.count} tab${state.count > 1 ? 's' : ''} driven by your AI agent`;
  const release = (btn, msg) => {
    btn.hidden = false;
    btn.addEventListener('click', () => {
      chrome.runtime
        .sendMessage(msg)
        .then(() => {
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
