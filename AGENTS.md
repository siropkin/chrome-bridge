# chrome-bridge — agent operating manual

You can drive the user's **real, logged-in Chrome** through a local bridge. Everything runs through the CLI:

```
node <repo>/cli.mjs <command> …
```

`<repo>` = the chrome-bridge checkout (the folder containing this file).

## Preflight

`node <repo>/cli.mjs health` → `{"ok":true,"extension":true}`

- `bridge server not running` → tell the user to start it: `node <repo>/server.mjs`
- `extension not connected` → tell the user to load/reload `<repo>/extension/` at `chrome://extensions` (Developer mode → Load unpacked). You cannot click that button yourself.

## Core loop

1. `tabs` — find the tab. `<match>` is a URL substring; the most recently active match wins.
2. `open <url>` / `nav <match> <url>` — auto-marks the tab (purple banner + 🟣 tab group).
3. **`snap <match>` — always snap before shooting.** The a11y tree with `@eN` refs is ~10× cheaper than a screenshot and usually answers the question.
4. `click <match> @e3` / `fill <match> @e2 "value"` — refs expire on navigation; re-snap.
5. `wait <match> --text "Saved"` after actions that trigger loads.
6. `shot <match> out.png --scale 0.5 --format jpeg` only when you need pixels. Read screenshots in a subagent to keep image tokens out of the main context.
7. **Always `release <match>` (or `close <match>`) when done. Always `unemulate` after emulating.**

## Commands

```
tabs                              list tabs (compact JSON)
open <url>                        open + mark a new tab
nav <match> <url>                 navigate matching tab
close <match>                     close matching tab
snap <match>                      a11y-tree snapshot with @eN refs
click <match> <@ref|css>          click an element
fill <match> <@ref|css> <value>   set input value (React-safe)
wait <match> [css|--text t] [--timeout ms]
eval <match> <js|-> [--world main|isolated]     '-' reads JS from stdin
shot <match> <out> [--scale N] [--format png|jpeg] [--quality N] [--crop x,y,w,h]
measure <match> <css>             rect + computed styles as JSON
console <match> [--clear]         page console + errors (hook installs on first call)
grid <match>                      toggle 8px alignment grid
mark|release <match>              add/remove driven-tab markers
emulate <match> <w> <h> [mobile]  CDP device view (no window resize)
unemulate <match>                 clear emulation + detach debugger
resize <match> <w> <h>            resize the window
health                            server + extension status
```

## Recipes

### Check a page for JS errors

`console <match>` — the first call installs the hook and captures from then on; re-run after every navigation (the hook dies on reload).

### Fill a React form

Always `fill`, never set `.value` in `eval` — `fill` uses the native value setter + input/change events so React's value tracker sees a real change.

### Fake API data

```bash
node <repo>/cli.mjs eval <match> - <<'JS'
const orig = window.fetch;
window.fetch = async (...a) => {
  const res = await orig(...a);
  if (!String(a[0]).includes('/api/target')) return res;
  const json = await res.json();
  json.items = [/* … */];
  return new Response(JSON.stringify(json), { status: res.status, headers: res.headers });
};
'patched'
JS
```

The patch survives SPA navigations, dies on reload. If the app caches responses (e.g. React Query staleTime), force a new query key (change a filter/scope in the UI) instead of refetching the same one.

### Watch network timing

`performance.getEntriesByType('resource')` is useless on busy dev servers (buffer full of chunks). Arm a `PerformanceObserver` via `eval`, then act; re-arm after every full reload (it survives SPA nav).

### Layout truth without screenshots

`measure <match> <css>` → x/y/w/h + alignment/spacing/color computed styles per element. Alignment questions ("are these centered?") are answered by `alignItems`/`textAlign` numbers, never by looking.

### Compare implementation vs mockup

Follow [design-eye.md](design-eye.md): measure numbers on both sides, crop to the component, rubric per element.

## Gotchas

- `eval` runs in the ISOLATED world, falls back to MAIN, then to CDP (CSP-exempt). `console` uses MAIN automatically.
- Synthetic events are *untrusted*: canvas-heavy apps (e.g. Figma) ignore them. A `node-id` URL still selects the node on load.
- `shot` needs the tab visible and the display awake; on failure, get layout truth from `measure` / `eval getBoundingClientRect` instead.
- Page reload kills: refs, fetch patches, the console hook, PerformanceObservers. Re-apply after `nav`.
- Some dev servers are HTTPS-only — an `http://localhost:…` tab lands on an error page.
- Driven tabs show a purple banner and join a 🟣 tab group; that's the bridge working, not a bug in the page.
