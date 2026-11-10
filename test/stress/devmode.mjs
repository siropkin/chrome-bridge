// Turn on Developer mode in a Chrome launched with --remote-debugging-port,
// through chrome://extensions' own API. CI loads the extension with
// --load-extension into a fresh profile where Developer mode is off, and
// Chrome then disables an unpacked extension the moment it reloads
// (DISABLE_UNSUPPORTED_DEVELOPER_EXTENSION, ExtensionManagement::
// IsAllowedByUnpackedDeveloperModePolicy) — so `extreload` never came back.
// A real unpacked install always has Developer mode on (Load unpacked needs
// it). Seeding the pref in Preferences doesn't stick: Chrome resets it.
// Usage: node test/stress/devmode.mjs [port]   (prints the result, exit 1 on failure)
const port = process.argv[2] || 9222;
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('no page target on port ' + port);
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let n = 0;
const call = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++n;
    ws.addEventListener('message', function h(e) {
      const m = JSON.parse(e.data);
      if (m.id !== id) return;
      ws.removeEventListener('message', h);
      resolve(m.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
const back = page.url;
await call('Page.navigate', { url: 'chrome://extensions' });
let on = false;
for (let i = 0; i < 20 && !on; i++) {
  await new Promise((r) => setTimeout(r, 250));
  const r = await call('Runtime.evaluate', {
    expression: `(async () => { if (!globalThis.chrome?.developerPrivate) return false; await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }); return (await chrome.developerPrivate.getProfileConfiguration()).inDeveloperMode; })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  on = r?.result?.value === true;
}
await call('Page.navigate', { url: back });
console.log(on ? 'developer mode on' : 'developer mode could not be turned on');
process.exit(on ? 0 : 1);
