# chrome-bridge — command reference

Every command runs as `node <repo>/cli.mjs <command> …`. `<match>` is a URL/title substring that must identify exactly one tab in the selected profile (ambiguous matches are refused before anything runs — re-run with a longer match), or `id:<tabId>` for one exact tab. `--profile <id or name>` routes to one Chrome profile when several are connected.

## Commands

```
batch                             read commands from stdin, one per line ('#' = comment,
                                  quotes honored; eval payloads ride verbatim — quotes are
                                  JS syntax there, not grouping) — one process for N
                                  commands; stops on first error
tabs [match]                      list tabs (compact JSON); [match] filters by URL/title substring;
                                  several profiles connected → merged, rows carry a profile tag
profiles                          list connected Chrome profiles — id and name (for --profile) + version
doctor [--fix]                    browser-hygiene sweep: tabs wearing bridge markers the bridge
                                  doesn't track (🟣 group, status favicon, emulation, debugger),
                                  each with its last lifecycle events; --fix releases every residue
                                  tab and prunes dead-id memory (driven tabs are never touched)
open <url>                        open + mark a new tab (waits for load, 8s cap;
                                  the reply's loaded:false means the cap fired on a
                                  still-loading page — snap/eval/wait --text work on
                                  what's there; re-nav only if the URL itself failed).
                                  Warns if another tab already shows this exact URL —
                                  drive the existing one instead (its state survives).
                                  chrome://, chrome-extension://, and Web Store targets
                                  are REFUSED (Chrome blocks scripting there — the tab
                                  could never be driven); same for nav
nav <match> <url> [--diff]        navigate matching tab (waits for load, 8s cap;
                                  same loaded:false semantics as open). Nav to the URL
                                  the tab already shows IS a reload (state resets) —
                                  the result warns; skip nav to drive the page as-is.
                                  Only --diff is accepted; typos fail before routing
close <match> [--all]             close the matching tab — --all closes every match
                                  (the remedy for identical-URL tabs no <match> can separate)
snap <match> [css|@ref] [--diff] [--href] [--skeleton] [--no-fold] [--find "nl"]
                                  a11y tree with @eN refs; [css|@ref] scopes to a subtree
                                  (@ref = the --skeleton drill-down), --diff prints only lines
                                  added/removed/changed since last snap,
                                  --href includes all link URLs (default: only nameless links);
                                  --skeleton: depth-limited map — cut containers read
                                  '… N inside' (deterministic drill: snap <match> @ref) instead
                                  of silently truncating at 300 nodes;
                                  --no-fold: repeated lines stay inline in document order —
                                  the '… N more' summaries move folded refs to the END, so
                                  scripted last-line picks got the wrong row;
                                  --find "query" asks local Gemini Nano (no cloud tokens; seconds
                                  on a scoped tree, 15-35s on a whole big page) to pick up to 8
                                  tree lines matching a natural-language query ("the cancel button") —
                                  a shortlist to VERIFY before acting, never ground truth (~2/3 accurate);
                                  '* ' prefix marks elements new since the previous snap
                                  identical lines seen 3+ times collapse to '… N more · <line> → @refs'
                                  (refs stay clickable); unnamed decorative imgs are elided
click <match> <@ref|css> [--dbl] [--diff] [--trusted]
                                  click (fails loudly if an overlay covers the
                                  click point); --dbl double-clicks (two click pairs + dblclick);
                                  --trusted = CDP Input (isTrusted=true — canvas tools accept it)
drag <match> <@ref|css> <@ref|css> [--diff] [--trusted]
                                  drag one element onto another — synthetic pointer sequence,
                                  so isTrusted-checking apps (canvas tools) ignore it;
                                  --trusted = CDP Input (isTrusted, and legacy HTML5
                                  dragstart/drop fire too)
dialog <match> accept|dismiss [--text s]
                                  answer a JS dialog over CDP — on current Chrome reachable
                                  only if it opened during a live debugger session (net/shot/
                                  etc.); a dialog that wedged an unattached tab cannot be
                                  answered: recover with nav <match> <url> — navigation drops
                                  it (--text answers a prompt and needs an answer)
fill <match> <@ref|css> <value> [--diff]   set input value (React-safe); on a native <select>
                                  matches option value or label — the error lists options on a miss;
                                  a value starting with '--' goes after a bare '--' separator:
                                  fill <match> <ref> -- <value>
clear <match> <@ref|css> [--diff]   empty an input/textarea/contenteditable — the path when
                                  synthetic select-all+Backspace fails (editor-owned models:
                                  Editor.js & co) or the tab must stay in the background
type <match> <@ref|css> <text> [--diff] [--trusted]
                                  per-char typing — triggers autocomplete/keystroke UIs;
                                  '--' separator for '--'-leading text, same as fill;
                                  long-form text (>2000 chars) is paste's job;
                                  --trusted = CDP keys
paste <match> [@ref|css] [--diff] [--html] [-- <text>]
                                  real-paste semantics into the focused (or given) field —
                                  editors that own their model (Quill, Reddit/LinkedIn rich
                                  composers) revert fill but take a paste; without -- <text>
                                  it reads the OS clipboard (pbpaste/xclip/Get-Clipboard);
                                  --html sends the -- text as markup (text/html + a stripped
                                  text/plain fallback) — block editors parse it into native
                                  blocks: a whole article in one paste
upload <match> <@ref|css> <file...> [--chooser] [--diff]   set a file input's files (CDP; hidden inputs work;
                                  an unknown --flag fails rather than being treated as
                                  a file). --chooser targets the button that OPENS the
                                  OS picker — the chooser is intercepted and the files
                                  land on the input the app created for it (the
                                  Slides-style detached-input pattern; no dialog shown)
press <match> <key> [@ref|css] [--diff] [--trusted]   key press (Enter/Tab/Escape/Backspace/
                                  Delete/Insert/arrows/Home/End/PageUp/PageDown, or one char —
                                  space = " "; unknown names fail loud) on focused or given
                                  element; combos like Control+k / Shift+Enter
                                  set modifier flags; --trusted = CDP keys (Enter triggers
                                  browser defaults like form submit)
hover <match> <@ref|css> [--diff] [--trusted]   hover (opens hover menus); --trusted = CDP Input
scroll <match> <up|down|top|bottom|@ref|css> [--diff]
                                  scroll (finds the real scroller — app shells like
                                  Linear/Gmail scroll an inner panel, not the window);
                                  --diff shows what lazy-loaded in
                                  [--diff] on an action: baseline snap, act, settle (100ms DOM
                                  quiet, 3s cap), then the diff of exactly the action's effects,
                                  prefixed with a VERDICT — succeeded / needs_human / blocked /
                                  uncertain (bot walls named; uncertain means nothing observable
                                  changed — never read it as ok)
ask <match> <question>              (experimental) local Gemini Nano answers from page
                                  text — no cloud tokens; pre-filter quality, not truth
wait <match> <css|--text t|--js expr|--human|--pixel-change> [--timeout ms] [--world main|isolated]
                                  wait for element or visible text (default 10s, max 60s);
                                  --text takes every word up to the next flag (unquoted
                                  multi-word is fine); css/--text are alternatives — pass
                                  one, not both (same for --human vs --pixel-change);
                                  --js polls a page expression until truthy and prints its
                                  value (awaited, so async checks work; '-' reads it from
                                  stdin; one expression — statements go in an IIFE; in batch
                                  quote it as one token) — mutation-driven, not a sleep loop;
                                  --world main sees page globals (app state), DOM checks
                                  work in either world; a timeout names the last value or error;
                                  --human hands the tab to the user — CAPTCHA/2FA/login
                                  walls: the pill tells them it's their turn, the command
                                  blocks until they act (trusted input or navigation;
                                  default 120s, max 280s), then returns the snap-diff
                                  of what they did (fresh snap if they navigated);
                                  --pixel-change polls until pixels move — canvas changes
                                  the tree can't see (attaches CDP for the wait)
eval <match> <js|-> [--world main|isolated]     '-' reads JS from stdin; output caps at
                                  50K chars (truncation note names the remedy) — return less;
                                  top-level const/let are call-scoped: re-runs never collide
                                  (set globals via window.x)
shot <match> <out> [--max px] [--scale N] [--format png|jpeg] [--quality N] [--crop x,y,w,h] [--full] [--diff]
                                  --max caps the long edge (default 1280, sized for agent
                                  reading; 0 = native res — use it for any screenshot a
                                  human will see: PRs, issues, chat, docs);
                                  --diff compares against the previous --diff shot of the tab —
                                  pinned to the baseline's SIZE/scale but the CURRENT scroll position
                                  (it watches what you see), and, on change, saves ONLY the changed
                                  region (padded, capture res) — canvas/pixel changes the tree can't see.
                                  --scale/--max are ignored while a baseline exists (noted in the reply)
fetch <match> <url> [--out file] [--keep] [--header "k: v"]... [--csrf]
                                  in-page fetch riding the logged-in session — login-walled
                                  JSON/feeds answer it without eval plumbing; binary needs
                                  --out, text prints capped at 50K chars (--out: full body);
                                  no matching tab → scratch tab on the target origin (closed
                                  after, unless --keep); --header adds request headers for
                                  session APIs that check them; --csrf attaches the JSESSIONID
                                  cookie as csrf-token (LinkedIn Voyager-class APIs)
net <match> [--dur ms] [--filter s] [--body s] [--ws] [--har out.har]
                                  capture network for N ms, capped at 30s (CDP; one line per
                                  request) — run successive captures for longer windows;
                                  --ws appends WebSocket frames (→ sent / ← received, 200 per
                                  capture) — chat/streaming apps are invisible without them;
                                  --body s appends response bodies for URLs containing s (≤8);
                                  --har out.har also saves the capture as HAR 1.2 (DevTools/
                                  Burp open it; bodies land in the file, not the lines) — the
                                  HAR carries full request/response headers incl. cookies and
                                  tokens: written owner-only (0600), treat it as a secret
perf <match> [--dur ms]           CPU over a window (default 5s, max 30s; CDP): renderer +
                                  main-thread CPU %, main-thread busy split (script/style/
                                  layout/other), style+layout rates, heap; plus running
                                  animations grouped by property — '⚠ not composited' ones
                                  repaint every frame. Warns when the tab is hidden
measure <match> <css|@ref>        rect + computed styles as JSON, one entry per match
                                  (font = size/weight)
console <match> [--clear] [--ask [q]]   page console + errors (hook installs on first call);
                                  --ask triages the log with local Nano — only the verdict costs cloud tokens.
                                  Polling it is unnecessary: every command on a driven tab prints
                                  '⚠ N new page errors since the last command' (console.error +
                                  uncaught errors/rejections, newest 5) to stderr by itself
grid <match>                      toggle 8px alignment grid
mark|release <match>              add/remove driven-tab markers; release clears emulation too
activate <match>                  bring a background tab to the front (trusted input needs it);
                                  warns when the tab STAYS hidden — an occluded/minimized
                                  window can't be activated into view; use emulate <match> focus
note <match> <text>               narrate to the human: text shows in the driven tab's pill + history.
                                  Use sparingly — before a risky/long sequence ("saving the draft,
                                  then verifying the toast"), or to explain a surprising step.
                                  The user sees every command in the pill anyway; note adds intent.
watch                            live feed of every bridge command (terminal twin of the pill) —
                                  for the human watching you; you already see command results
history [match] [-n N] [--batch out]
                                  what already ran on this machine (the server ring holds the
                                  last 300 commands) — post-mortems and session handoffs;
                                  --batch out writes a replayable batch script (failed commands
                                  commented out; fill/type/paste values, dialog answers, clipboard
                                  pastes, and upload paths are redacted and their lines commented
                                  as '# secret ·' — secrets never reach the export; shot paths and
                                  multiline eval don't survive. Single-line eval code is kept
                                  VERBATIM — a token inside the JS lands in the export, so never
                                  embed secrets in eval; use fetch/env reads instead)
swlogs                            service-worker console tail (errors/warnings)
extreload                         reload the extension from disk — picks up code changes
                                  without the chrome://extensions click (the stale-version
                                  health warning's fix)
emulate <match> <w> <h> [mobile] [dsf=N]   CDP device view (no window resize); dsf=N pins the
                                  device scale factor (dsf=2 = retina captures on any
                                  display — shot --max <w> then downsamples to exact px;
                                  mobile alone = dsf 2, 'mobile dsf=3' = a 3x phone);
                                  'emulate <match> focus' makes the page believe it's focused —
                                  focus-gated work (pages pausing on blur) keeps running in a
                                  background tab; mobile/dsf=N/focus are the only modes;
                                  it does NOT render an occluded window
unemulate <match>                 clear emulation + detach debugger
resize <match> <w> <h>            resize the window
health                            server + extension status
start                             start the server (detached) if it's down
stop                              stop the server
```

## Notes per command

- `tabs` — rows carry a `profile` tag and the tab `id`; tabs you're driving are flagged `driven:true`. Ids die on browser restart and change on prerender (re-copy), so don't save them across sessions.
- `profiles` — a `<match>` present in several profiles is REFUSED; name one with `--profile <id or name>` (an id prefix works). Commands without a `<match>` (`open`, `swlogs`, `extreload`) also need `--profile` when several profiles are connected. Never guess personal-vs-work: if it matters, ask.
- `snap` — `--skeleton` maps a dense page (cut containers read `… N inside`; drill with `snap <match> @ref`). `--no-fold` keeps repeated lines in document order — use it when a script picks `grep | tail -1`. `--find` is a shortlist to **verify before acting**.
- `click` / `fill` / `type` / `press` / `hover` / `clear` — refs survive re-snaps, expire on navigation (re-snap after `nav`), and are identity-bound: if the DOM re-sorted, removed, or hid the element under a ref (virtualized lists, re-render caches), acting on it fails loudly (`was "…" at snap time, now resolves to "…"` / `gone or hidden — re-snap`) — re-snap, don't retry the old ref. App ignores the click (canvas tools, Figma) or Enter won't submit → `--trusted`; a synthetic click nothing reacted to says so itself (`no observable page effect`). `--trusted` refuses a hidden tab: `activate <match>` first; if `activate` warns the tab STAYS hidden (occluded/minimized window), use `emulate <match> focus`.
- `paste` — `paste <match> @e2 -- "long text"` for editors that revert `fill` (Quill, Reddit/LinkedIn rich composers); without `-- <text>` it pastes the OS clipboard. `paste --html -- "<h2>T</h2><p>…"` makes a whole structured article ONE paste.
- `upload` — target the input or an element wrapping it. `--chooser` targets the button that OPENS the OS picker — the only path when no input exists yet.
- `open` / `nav` / `close` / `release` / `mark` — `close` is only for tabs YOU opened; a tab you found is the user's — `release` it. `mark` re-claims a tab the human ⏏-released (ask first).
- `wait` — default 10s, max 60s: raise `--timeout` before concluding the page is broken. `wait m --js "document.querySelectorAll('.row').length >= 20"` instead of sleeping inside `eval`; `--world main` for page globals. `--human` blocks until the user acts (default 2 min, max ~4.5 min) and returns the diff of what they did.
- `batch` — `printf 'click m @e4\nwait m --text "Saved"\n' | node <repo>/cli.mjs batch`. Stops on first error.
- `eval` — page globals (`window.app`, React internals) need `--world main`. Output caps at 50K chars — return less, or `fetch --out` the data instead.
- `net` / `fetch` — every `net` line names its initiator (`⟵ script:line`). `fetch` replays a URL in the page so the logged-in session rides it; with no matching tab it opens a scratch tab on that origin (`--keep` leaves it).
- `perf` — run it on a VISIBLE tab (hidden tabs are throttled; it warns). GPU-process CPU isn't visible to CDP. Reading it: [recipes.md → Why is this page eating CPU?](recipes.md#why-is-this-page-eating-cpu).
- `console` / `ask` — `--ask` triages locally with Gemini Nano instead of spending cloud tokens on log noise. Don't poll `console` after every step: new page errors already ride every command's stderr.
- `dialog` — one that wedged an unattached tab can't be answered: `nav <match> <url>` drops it.
- `emulate` — `dsf=2` = retina-crisp `shot` on any display. Plain `emulate <match> <w> <h>` pins dsf=1, so screenshots drop to 1x on a retina screen until `unemulate`.
- `shot` — `--crop x,y,w,h` is in CSS px, viewport-relative (straight from `measure`); the saved file is crop × devicePixelRatio. Missing output folders are created.
- `doctor` — `--fix` releases leftover markers (driven tabs untouched).
- `history` — `--batch out` exports a replayable script; typed/pasted text, dialog answers and upload paths are redacted, single-line eval code is kept verbatim: never embed secrets in eval.
