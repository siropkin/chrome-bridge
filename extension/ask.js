'use strict';
// The question window (D3b): one Cloud Bridge step waiting for the person's yes
// or no. The service worker opened it for one question (the id after #), and
// answers only to this page in this window. Buttons wake up after a moment, so a
// click or a key meant for another window can't answer a question that just
// appeared; Deny holds the focus.
const id = location.hash.slice(1);
const $ = (name) => document.getElementById(name);
const GONE = "This question isn't waiting any more, so nothing ran. You can close this window.";
const WAKE_MS = 700;
let answered = false;

function gone(text) {
  $('question').hidden = true;
  $('gone').textContent = text;
  $('gone').hidden = false;
}

function answer(value) {
  if (answered) return;
  answered = true;
  $('once').disabled = true;
  $('deny').disabled = true;
  // On a yes or no the service worker closes this window itself.
  chrome.runtime.sendMessage({ type: 'ask-answer', id, answer: value }).then(
    (r) => r?.ok || gone(GONE),
    () => gone(GONE)
  );
}

function countdown(expires) {
  const left = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
  $('left').textContent = left ? `No answer in ${left} second${left === 1 ? '' : 's'} means no.` : 'No answer, so nothing ran.';
  if (left && !answered) setTimeout(() => countdown(expires), 1000);
}

chrome.runtime.sendMessage({ type: 'ask-get', id }).then(
  (q) => {
    if (!q?.ok) return gone(GONE);
    $('app').textContent = q.app;
    $('title').textContent = q.title;
    if (q.site) {
      $('site').textContent = q.site;
      $('site-line').hidden = false;
    }
    if (q.line) {
      $('line').textContent = q.line;
      $('line').hidden = false;
    }
    if (q.settingsUrl) {
      $('settings').href = q.settingsUrl;
      $('settings').hidden = false;
    }
    $('question').hidden = false;
    countdown(q.expires);
    setTimeout(() => {
      if (answered) return;
      $('once').disabled = false;
      $('deny').disabled = false;
      $('deny').focus();
    }, WAKE_MS);
  },
  () => gone(GONE)
);

$('once').addEventListener('click', (e) => e.isTrusted && answer('once'));
$('deny').addEventListener('click', (e) => e.isTrusted && answer('deny'));
document.addEventListener('keydown', (e) => {
  if (e.isTrusted && e.key === 'Escape' && !$('deny').disabled) answer('deny');
});
