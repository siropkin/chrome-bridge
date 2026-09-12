// chrome-bridge popup — copies the active tab's id:<tabId> reference, the
// exact <match> form every cli command understands (see findTab). Pure popup:
// no background round-trip — extension pages have the tabs permission too.
const $ = (id) => document.getElementById(id);

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
