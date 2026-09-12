// chrome-bridge popup — two jobs: copy the active tab's id:<tabId> reference
// (the exact <match> every cli command understands — see findTab), and hand a
// first-time user the self-contained setup prompt for their agent. Pure popup:
// no background round-trip (extension pages have the tabs permission too).
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

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
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
