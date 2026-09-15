#!/usr/bin/env node
// chrome-bridge CLI — zero dependencies, Node >= 18.
// Run without arguments for usage.
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Port 9333 is hardcoded in FOUR places: extension/background.js (WS_URL —
// the extension can't read BRIDGE_PORT), server.mjs, extension/popup.js, here. Change all four.
const PORT = process.env.BRIDGE_PORT || 9333;
const BASE = `http://127.0.0.1:${PORT}`;

const fail = (msg) => {
  // Server/extension errors arrive pre-wrapped ("Error: Error: …") — strip
  // the nesting so the agent sees one clean prefix.
  console.error(`ERROR: ${String(msg).replace(/^(Error:\s*)+/, '')}`);
  process.exit(1);
};
const print = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v));

// fetch is unflagged only since Node 18 — on older Node every command below
// would misreport "server not running" while the real cause is the runtime.
if (typeof fetch !== 'function') fail('Node >= 18 required — you have ' + process.version);

// --profile: multi-profile routing. Extracted once at argv level (works
// before or after the command word) and rides on every command; an id prefix
// or the exact profile name is enough (see: cli.mjs profiles).
let PROFILE = null;
{
  const i = process.argv.indexOf('--profile');
  if (i >= 0) {
    if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) fail('--profile needs an id or name (see: cli.mjs profiles)');
    PROFILE = process.argv[i + 1];
    process.argv.splice(i, 2);
  }
}

// Image dimensions from the buffer header (PNG IHDR / JPEG SOF) — agents map
// shot pixels back to CSS px, and --max rescales extension-side, so print them.
const imgDims = (b) => {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
  for (let i = 2; i + 9 < b.length && b[i] === 0xff; i += 2 + b.readUInt16BE(i + 2))
    if (b[i + 1] >= 0xc0 && b[i + 1] <= 0xcf && b[i + 1] !== 0xc4 && b[i + 1] !== 0xc8 && b[i + 1] !== 0xcc)
      return `${b.readUInt16BE(i + 7)}x${b.readUInt16BE(i + 5)}`;
  return null;
};

// soft: return { error } instead of exiting — for callers that translate a
// known server-side failure into their own advice (extreload's bootstrap).
async function cmd(msg, soft) {
  let res;
  try {
    res = await fetch(`${BASE}/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PROFILE ? { ...msg, profile: PROFILE } : msg),
    });
  } catch (e) {
    // ECONNREFUSED = the server was never there. Anything else (socket hangup,
    // undici abort) = it DROPPED an in-flight command — different advice: the
    // command may have partially run, so check history before retrying.
    if (e?.cause?.code === 'ECONNREFUSED') fail('bridge server not running — start it: node cli.mjs start');
    fail('bridge server dropped the connection mid-command (stopped or restarted) — the command may have partially run; after `node cli.mjs start`, check `history` before retrying');
  }
  const out = await res.json().catch(() => null);
  // Two real causes, one message: the server died mid-reply (restart/stop with
  // the command in flight) or something else owns the port.
  if (!out) fail(`unreadable response from bridge on port ${PORT} — the server died mid-reply (restart?), or another server owns the port`);
  if (!out.ok) {
    if (soft) return { error: String(out.error) };
    fail(out.error);
  }
  return out.result;
}

async function stdin() {
  let s = '';
  for await (const c of process.stdin) s += c;
  return s.trim();
}

// The OS clipboard read for `paste` (no explicit -- <text>). BRIDGE_CLIPBOARD
// overrides it — the hermetic selftest (CI has no clipboard) and headless /
// clipboard-less machines.
function readClipboard() {
  const override = process.env.BRIDGE_CLIPBOARD;
  if (override !== undefined) return override;
  // maxBuffer: the default 1MB would throw on a whole-article clipboard.
  const run = (cmd, args) => {
    try {
      const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
      return r.status === 0 ? r.stdout : null;
    } catch {
      return null;
    }
  };
  if (process.platform === 'darwin') return run('pbpaste', []);
  if (process.platform === 'win32') return run('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard']);
  // Linux: neither ships everywhere — try both.
  return run('xclip', ['-selection', 'clipboard', '-o']) ?? run('xsel', ['--clipboard', '--output']);
}

// POSIX-ish word split honoring 'single'/"double" quotes — including quotes
// glued onto bare words (a"b c" → `ab c`), like a shell. Backslash escapes
// inside double quotes make JSON-stringified history entries replayable too:
// the old regex splitter could not round-trip a value containing BOTH quote
// types (the server wrapped it in a quote that also appeared in the value).
function tokenize(line) {
  const out = [];
  let token = '';
  let quote = null;
  let started = false;
  const escapes = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
  const push = () => {
    if (started) out.push(token);
    token = '';
    started = false;
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === '\\' && quote === '"') {
        const next = line[++i];
        if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(line.slice(i + 1, i + 5))) {
          token += String.fromCharCode(parseInt(line.slice(i + 1, i + 5), 16));
          i += 4;
        } else token += escapes[next] ?? next ?? '\\';
        continue;
      }
      token += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else {
      token += ch;
      started = true;
    }
  }
  if (quote) throw new Error('unterminated quote in batch line');
  push();
  return out;
}

// Flag-strip + stray-flag scan shared by the flat-positional commands — the
// hand-copied skeletons had already drifted once (a '--dfif' typo nearly got
// typed into a real form). `known` flags are removed; the first remaining
// '--x' at/after the positional slots fails loud instead of becoming data.
function takeFlags(args, known, minPos, usage) {
  const rest = args.filter((a) => !known.includes(a));
  if (rest.length < minPos) fail(`usage: ${usage}`);
  const stray = rest.slice(minPos).find((a) => a.startsWith('--'));
  if (stray) fail(`unknown flag ${stray} (flags: ${known.join(', ')})`);
  return rest;
}

// '--' = end of options (shell convention): everything after it is the value,
// unscanned — pasted content can legitimately start with '--' (dev.to
// front-matter died on this). Quotes can't be the signal for a direct shell
// call: the shell strips them before argv exists.
const splitDashDash = (args) => {
  const sep = args.indexOf('--');
  return { sep, flagged: sep < 0 ? args : args.slice(0, sep), valuePart: sep < 0 ? [] : args.slice(sep + 1) };
};

// Adding a command? SEVEN registries stay in sync (a missing one fails SILENTLY):
// cli.mjs USAGE · cli.mjs run() · server.mjs CLI_LINES · server.mjs route() (only if it
// needs special routing) · background.js handle() · ACT_VERBS (pill narration) · MUTATING.
const USAGE = `chrome-bridge CLI — drive the user's real Chrome.

  batch                             read commands from stdin, one per line ('#' = comment,
                                    quotes honored; eval payloads ride verbatim — quotes are
                                    JS syntax there, not grouping) — one process for N
                                    commands; stops on first error
  tabs [match]                      list tabs (compact JSON); [match] filters by URL/title substring;
                                    with multiple Chrome profiles connected, merged with a profile tag.
                                    Rows carry the tab id: a <match> of id:<tabId> — from the toolbar
                                    popup's Copy button — targets exactly that tab, no ambiguity
                                    (ids die on browser restart and change on prerender — re-copy)
  profiles                          list connected Chrome profiles — id and name (for --profile) + version
  doctor [--fix]                    browser-hygiene sweep: tabs wearing bridge markers the bridge
                                    doesn't track (🟣 group, status favicon, emulation, debugger),
                                    each with its last lifecycle events; --fix releases every residue
                                    tab and prunes dead-id memory (driven tabs are never touched)
  open <url>                        open + mark a new tab (waits for load, 8s cap; the reply's
                                    loaded:false means the cap fired on a still-loading page —
                                    snap/eval/wait --text work on what's there)
  nav <match> <url> [--diff]        navigate matching tab (waits for load, 8s cap;
                                    same loaded:false semantics as open)
  close <match> [--all]             close the matching tab — --all closes every match
                                    (the remedy for identical-URL tabs no <match> can separate)
  snap <match> [css|@ref] [--diff] [--href] [--skeleton] [--find "nl"]
                                    a11y-tree snapshot with @eN refs (cheap — use before shot);
                                    [css|@ref] scopes to a subtree (@ref = the --skeleton drill-down),
                                    --diff shows only changes since last snap,
                                    --href includes all link URLs (default: only nameless links);
                                    --skeleton: depth-limited map — cut containers read '… N inside'
                                    (drill: snap <match> @ref) instead of a silent 300-node cut;
                                    --find asks local Gemini Nano to pick the lines matching a
                                    natural-language query — a ~2s shortlist (~20s first call
                                    while Nano loads) to VERIFY, not ground
                                    truth (~2/3 accurate in testing); lines prefixed '* ' are new
                                    since the previous snap; lines seen 3+ times collapse to
                                    '… N more · <line> → @refs'; trees truncate at 300 nodes —
                                    scope big pages with [css|@ref], or --skeleton first
  click <match> <@ref|css> [--dbl] [--diff] [--trusted]
                                    click an element (fails loudly if an overlay covers it);
                                    --dbl double-clicks; --trusted drives CDP Input (isTrusted=true —
                                    canvas tools accept it; attaches the debugger)
  drag <match> <@ref|css> <@ref|css> [--diff] [--trusted]
                                    drag an element onto another (synthetic pointer sequence —
                                    apps that check isTrusted ignore it; --trusted = CDP Input,
                                    isTrusted=true, legacy HTML5 dragstart/drop fire)
  dialog <match> accept|dismiss [--text s]
                                    answer a JS dialog over CDP — on current Chrome reachable
                                    only if it opened during a live debugger session (net/shot/
                                    etc.); a dialog that wedged an unattached tab cannot be
                                    answered: recover with nav <match> <url> — navigation drops
                                    it (--text answers a prompt)
  fill <match> <@ref|css> <value> [--diff]   set input value (React-safe; on a native <select>
                                    matches option value or label — error lists the options on a miss);
                                    a value starting with '--' goes after a bare '--' separator:
                                    fill <match> <ref> -- <value>
  clear <match> <@ref|css> [--diff]   empty an input/textarea/contenteditable — works where
                                    synthetic select-all+Backspace can't (editor-owned models
                                    like Editor.js get a Selection-delete or DOM removal)
  type <match> <@ref|css> <text> [--diff] [--trusted]
                                    per-char typing — triggers autocomplete/keystroke UIs;
                                    '--' separator for '--'-leading text, same as fill;
                                    long-form text (>2000 chars) is paste's job; --trusted = CDP keys
  press <match> <key> [@ref|css] [--diff] [--trusted]  key press on focused or given element
                                    (Enter/Tab/Escape/Backspace/Delete/Insert/arrows/Home/End/
                                    PageUp/PageDown, or one char — space = " "; unknown names
                                    fail loud);
                                    combos like Control+k / Shift+Enter / Meta+k set the modifier flags;
                                    --trusted = CDP keys (isTrusted — Enter triggers browser defaults)
  hover <match> <@ref|css> [--diff] [--trusted]  hover an element (opens hover menus); --trusted = CDP Input
  paste <match> [@ref|css] [--diff] [--html] [-- <text>]
                                    real-paste semantics into the focused (or given) field:
                                    editors that own their model (Quill, Reddit/LinkedIn
                                    composers) revert fill but take a paste; without -- <text>
                                    it reads the OS clipboard (pbpaste/xclip/Get-Clipboard).
                                    --html: the -- text is markup — the paste event carries
                                    text/html + a tag-stripped text/plain fallback, and
                                    block editors parse it into native blocks in one shot
  scroll <match> <up|down|top|bottom|@ref|css> [--diff]
                                    scroll the page (or an element into view); --diff
                                    shows what lazy-loaded in
                                    [--diff] on an action: baseline snap, act, settle (100ms DOM
                                    quiet, 3s cap), then the diff of exactly the action's effects,
                                    prefixed with a VERDICT — succeeded / needs_human / blocked /
                                    uncertain (bot walls named; uncertain means nothing observable
                                    changed — never read it as ok)
  upload <match> <@ref|css> <file...> [--diff]
                                    set a file input's files (CDP — works on hidden
                                    inputs; target the input or an element wrapping it)
  ask <match> <question>            (experimental) answer from page text with Chrome's
                                    built-in Gemini Nano — local, no cloud tokens
  wait <match> <css|--text t|--human|--pixel-change> [--timeout ms]
                                    wait for element or visible text (timeout default 10s,
                                    max 60s); --text takes every word up to the next flag
                                    (unquoted multi-word is fine); css/--text are
                                    alternatives — pass one, not both;
                                    --human hands the tab to the user — CAPTCHA/
                                    2FA/login walls — the pill asks them to act, the command
                                    blocks until trusted input or navigation (default 120s,
                                    max 280s), then returns the snap-diff of what they did;
                                    --pixel-change polls the viewport until pixels move
                                    (canvas changes the tree can't see; attaches CDP)
  eval <match> <js|-> [--world main|isolated]     '-' reads JS from stdin; output
                                    caps at 50K chars — return less (slice in-page), or fetch --out
  shot <match> <out> [--max px] [--scale N] [--format png|jpeg] [--quality N] [--crop x,y,w,h] [--full] [--diff]
                                    --max caps the long edge (default 1280, 0 = native res);
                                    --diff compares against the previous --diff shot and, on
                                    change, saves ONLY the changed region (canvas/pixel changes
                                    the tree can't see)
  net <match> [--dur ms] [--filter s] [--body s] [--ws] [--har out.har]
                                    capture network for N ms, capped at 30s (CDP, one line per
                                    request, each naming its initiator: ⟵ script:line);
                                    --ws also captures WebSocket frames (→ sent / ← received,
                                    300 chars each, 200 per capture — chat/streaming apps);
                                    --body s also captures JSON/text response bodies for URLs
                                    containing s (≤8, 1500 chars each; implies --filter s);
                                    --har out.har saves the capture as HAR 1.2 (DevTools/Burp
                                    open it; text/JSON bodies land in the file, not the lines) —
                                    the HAR carries full headers incl. cookies/tokens: owner-only
                                    0600, treat it as a secret
  fetch <match> <url> [--out file] [--keep] [--header "k: v"]... [--csrf]
                                    in-page fetch riding the logged-in session — login-walled
                                    JSON/feeds answer it; binary responses need --out, text
                                    prints capped at 50K chars (--out gets the full body);
                                    no matching tab → a scratch tab on the target origin is
                                    opened, fetched, closed (--keep leaves it for follow-ups);
                                    --header adds request headers for session APIs that check
                                    them (x-restli-protocol-version & co); --csrf attaches the
                                    JSESSIONID cookie as the csrf-token header (Voyager-class
                                    APIs; briefly attaches CDP to read the httpOnly cookie)
  measure <match> <css>             rect + computed styles as JSON
  console <match> [--clear] [--ask [question]]
                                    page console + errors (hook installs on first call);
                                    --ask triages the log with local Gemini Nano — only
                                    the verdict costs cloud tokens, not the noise
  grid <match>                      toggle 8px alignment grid
  mark|release <match>              add/remove driven-tab markers; release clears emulation too
  activate <match>                  bring a background tab to the front (trusted input
                                    needs it — CDP dispatch on a hidden tab fires nothing)
  note <match> <text>              narrate to the human — shows in the driven tab's pill + history
                                    (use sparingly: before a risky/long sequence, or to explain why)
  watch                            live feed of every bridge command — the terminal twin of the pill;
                                    for the human watching you, not for you (Ctrl-C to exit)
  history [match] [-n N] [--batch out]
                                    what the bridge already ran (the server ring holds the
                                    last 300 commands): [match] filters, -n takes the newest N —
                                    the same lines watch shows live, for post-mortems and session
                                    handoffs; --batch out writes the recorded commands as a
                                    replayable batch script (failed ones commented out;
                                    fill/type/paste values redacted as '# secret ·' lines;
                                    shot output paths and multiline eval code don't survive —
                                    but single-line eval code is kept VERBATIM: a secret inside
                                    the JS lands in the export, so don't embed any)
  swlogs                            service-worker console tail (errors/warnings)
  extreload                         reload the extension from disk — picks up code changes
                                    without the chrome://extensions click (the stale-version
                                    health warning's fix)
  emulate <match> <w> <h> [mobile]  CDP device view (no window resize); 'focus' instead of
                                    <w> <h> emulates page focus (focus-gated work keeps running
                                    in a background tab — does NOT render an occluded window)
  unemulate <match>                 clear emulation + detach debugger
  resize <match> <w> <h>            resize the window
  health                            server + extension status
  start                             start the server (detached) if it's down
  stop                              stop the server

<match> is a substring of the tab URL or title. It must identify exactly one tab in the
selected profile; ambiguous matches are refused before anything runs — re-run with a
longer match. Every command that targets a tab marks it (🟣 pill + tab group) —
reads (snap/measure/console/net) included; release when you're done.
Refs (@eN) come from snap; they survive re-snaps but expire on navigation.
CSS selectors match document-level first, then pierce open shadow roots.

Multiple Chrome profiles can be connected at once (one seat each). A <match>
routes to the only profile that has a matching tab; a match in SEVERAL profiles
is refused — name one with --profile <id or name> (an id prefix is enough; see: profiles).`;

// Adding a command? SEVEN registries stay in sync (a missing one fails SILENTLY):
// cli.mjs USAGE · cli.mjs run() · server.mjs CLI_LINES · server.mjs route() (only if it
// needs special routing) · background.js handle() · ACT_VERBS (pill narration) · MUTATING.
async function run(cmdName, args) {
  // New flags parsed here must also land in server.mjs CLI_LINES — history
  // --batch rebuilds replay lines there, and an unmirrored flag is silently
  // dropped at replay.
  switch (cmdName) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      console.log(USAGE);
      break;

    case 'health': {
      try {
        const res = await fetch(`${BASE}/health`);
        const h = await res.json();
        print(h);
        // Exit 1 when the extension is disconnected: `health && …` preflights
        // and SDK-style gating read the exit code, and 0 here lied about a
        // bridge that can't run a command. The JSON still prints — which half
        // failed stays readable — and the stale-version warnings above ride
        // stderr either way.
        if (!h.extension) process.exitCode = 1;
        // A loaded-but-stale extension still passes health (the SW seat is old
        // code — README's upgrade trap). Each profile self-reports its version
        // on the WS handshake; compare them with the manifest on disk.
        if (h.extension && h.profiles?.length) {
          let mine = null;
          try {
            mine = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./extension/manifest.json', import.meta.url)), 'utf8')).version;
          } catch {}
          for (const p of h.profiles) {
            if (mine && p.v && p.v !== mine) {
              // Bare extreload is refused when several profiles are connected
              // (route() can't pick one) — name the stale profile in the fix.
              // A store install can't reload from disk: its update comes
              // through the Web Store — say so instead of offering extreload.
              if (p.install === 'store') {
                console.error(
                  `⚠ extension ${p.v} is loaded (profile ${p.name || p.id.slice(0, 4)}), the bridge download has ${mine} — store installs update via the Chrome Web Store; nothing to reload`
                );
                continue;
              }
              const fix =
                h.profiles.length > 1 ? `cli.mjs extreload --profile ${JSON.stringify(p.name || p.id.slice(0, 4))}` : 'cli.mjs extreload';
              console.error(`⚠ extension ${p.v} is loaded (profile ${p.name || p.id.slice(0, 4)}), the repo has ${mine} — run \`${fix}\` (or reload at chrome://extensions)`);
            }
          }
        }
      } catch {
        fail('bridge server not running — start it: node cli.mjs start');
      }
      break;
    }

    case 'profiles': {
      // Connected Chrome profiles (one WS seat each): id and name for --profile, version.
      try {
        const res = await fetch(`${BASE}/health`);
        const h = await res.json();
        print(h.profiles || []);
      } catch {
        fail('bridge server not running — start it: node cli.mjs start');
      }
      break;
    }

    case 'start': {
      // Self-heal: an agent whose health check failed can bring the server up
      // itself instead of asking the user (the extension still needs a human
      // click at chrome://extensions — nothing here can do that).
      // The body-shape check matters, not just any 200: a foreign server
      // squatting on 9333 must not read as "bridge already running" (the
      // spawned child would die on EADDRINUSE and start would lie 'started').
      const bridgeHealth = () => fetch(`${BASE}/health`).then((r) => r.json()).then((h) => (h?.ok === true ? h : null)).catch(() => null);
      const up = await bridgeHealth();
      if (up) {
        // A bare 'already running' reads as fully ready while the extension
        // is disconnected — the fresh-start path below says it, this one too.
        print(up.extension ? 'already running — extension connected' : 'already running — extension not connected (if it was already loaded, run health again in a moment; else load extension/ at chrome://extensions)');
        break;
      }
      const logPath = fileURLToPath(new URL('./server.log', import.meta.url));
      // (size cap lives in server.mjs — it runs on every start path, not just this one)
      const log = fs.openSync(logPath, 'a');
      const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
        detached: true,
        windowsHide: true, // else Windows gives the detached server its own console — closing it kills the server
        stdio: ['ignore', log, log],
      });
      child.unref();
      let health = null;
      for (let i = 0; i < 20 && !health; i++) {
        await new Promise((r) => setTimeout(r, 250));
        health = await bridgeHealth();
      }
      if (!health) fail('server did not come up in 5s — check ' + logPath);
      // The server accepts HTTP before the MV3 worker observes its socket's
      // close event and runs its 500ms reconnect. Without this grace, the
      // natural `start && health` preflight often reported a perfectly loaded
      // extension as disconnected and sent agents to ask for an unnecessary
      // chrome://extensions reload.
      for (let i = 0; i < 8 && !health.extension; i++) {
        await new Promise((r) => setTimeout(r, 250));
        health = await bridgeHealth();
      }
      print(
        health?.extension
          ? 'started (log: ' + logPath + ') — extension connected'
          : 'started (log: ' + logPath + ') — server ready; extension not connected yet (if it was already loaded, run health again in a moment)'
      );
      break;
    }

    case 'stop': {
      const res = await fetch(`${BASE}/stop`, { method: 'POST' }).catch(() => null);
      // Nothing-to-stop is success for the caller's purpose: setup texts tell
      // agents (and install.sh tells humans) `stop && start`, and a fresh
      // machine must not have the first half of that fail with exit 1.
      print(res?.ok ? 'stopped' : 'stopped (nothing was running)');
      break;
    }

    case 'tabs': {
      // Optional substring filter — a real browser's full tab list is ~2KB of
      // titles the agent usually doesn't need; `tabs <match>` returns the rows
      // it's actually looking for.
      if (args.length > 1 || args[0]?.startsWith('--')) fail('usage: tabs [match] — a URL/title substring, or the exact id:<tabId>');
      const t = await cmd({ type: 'tabs' });
      const m = args[0];
      // id:<tabId> is the exact reference every tab command takes — its own
      // help text says so, and returning [] for a live tab read as "the tab
      // is gone, re-copy/re-open" (the extension's tabMatches has the branch).
      print(m ? (/^id:\d+$/.test(m) ? t.filter((x) => String(x.id) === m.slice(3)) : t.filter((x) => (x.url || '').includes(m) || (x.title || '').includes(m))) : t); // url can be absent (unresponsive-profile row)
      break;
    }

    case 'swlogs':
      print((await cmd({ type: 'swlogs' })).join('\n') || '(no errors or warnings logged)');
      break;

    case 'extreload': {
      const r = await cmd({ type: 'extreload' }, true);
      // The command's own bootstrap trap: an extension OLD enough to need it
      // (pre-1.18.20) has no extreload handler — its handle() falls through to
      // 'unknown type'. That case is exactly the one manual reload.
      if (r?.error)
        fail(
          /unknown type/.test(r.error)
            ? 'the loaded extension predates extreload — reload it once by hand at chrome://extensions'
            : r.error
        );
      print(r);
      break;
    }

    // Live feed of every command the bridge runs — the terminal twin of the
    // pill in the driven tab. For the human watching the session, not for you
    // (you already see command results). Ctrl-C to exit.
    case 'watch': {
      let since = 0;
      const poll = () => fetch(`${BASE}/log?since=${since}`).then((r) => r.json()).catch(() => null);
      const first = await poll();
      if (!first) fail('bridge server not running — start it: node cli.mjs start');
      let boot = first.boot;
      for (const a of first.lines.slice(-15)) console.log(a.line);
      if (first.lines.length) since = first.lines[first.lines.length - 1].seq;
      console.log('— watching (Ctrl-C to exit) —');
      // ponytail: 500ms poll — SSE would be push-perfect, but this is 5 lines
      // and survives server restarts; switch if latency ever matters
      for (;;) {
        await new Promise((r) => setTimeout(r, 500));
        const res = await poll();
        if (!res) continue;
        // actSeq resets on a server restart; without this every new line would
        // be filtered out until seq climbs back past the old cursor.
        if (res.boot !== boot) {
          boot = res.boot;
          since = 0;
          console.log('— server restarted —');
        }
        for (const a of res.lines) console.log(a.line);
        if (res.lines.length) since = res.lines[res.lines.length - 1].seq;
      }
    }

    // Thin read over the server's activity ring — the same data `watch` tails,
    // without having had a `watch` running: a fresh session or a post-mortem
    // sees what was already done. `--batch out` turns the ring into a replay
    // script (history --batch's own run lands in the ring AFTER the read, so
    // the export never contains itself).
    case 'history': {
      let n = null;
      let outFile = null;
      let match = null;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-n') n = Number(args[++i]);
        else if (args[i] === '--batch') outFile = args[++i];
        else if (args[i].startsWith('--')) fail(`unknown flag ${args[i]} (flags: -n N, --batch out)`);
        else if (!match) match = args[i];
        else fail('usage: history [match] [-n N] [--batch out]');
      }
      if (outFile === undefined || (n !== null && (!Number.isFinite(n) || n < 1)))
        fail('usage: history [match] [-n N] [--batch out]');
      let res;
      try {
        res = await fetch(`${BASE}/log`).then((r) => r.json());
      } catch {
        fail('bridge server not running — start it: node cli.mjs start');
      }
      let lines = res.lines.filter((a) => !match || a.line.includes(match));
      if (n) lines = lines.slice(-n);
      if (outFile) {
        // Commands the ring couldn't replay (multiline eval, unknown types)
        // stay visible as comments — a silent drop would read as "that
        // command never ran".
        fs.writeFileSync(outFile, lines.map((a) => a.cmd || '# ' + a.line).join('\n') + '\n');
        console.log(`saved ${outFile} (${lines.length} lines — replay with: node cli.mjs batch < ${outFile})`);
      } else {
        print(lines.map((a) => a.line).join('\n') || '(no history — the ring holds the last 300 commands, and it is empty)');
      }
      break;
    }

    case 'doctor': {
      const rest = takeFlags(args, ['--fix'], 0, 'doctor [--fix]');
      if (rest.length) fail('usage: doctor [--fix]');
      const fix = args.includes('--fix');
      const rows = await cmd({ type: 'doctor', fix });
      if (fix) {
        // Clean Chrome-side residue through the normal, tested release path —
        // one release per residue row, never a driven tab, never a row that
        // only reports memory (the extension already pruned those).
        for (const row of rows) {
          if (row.driven || row.error || row.staleMemory) continue;
          if (!(row.grouped || row.status || row.emulated || row.debugger)) continue;
          const r = await cmd({ type: 'release', urlMatch: 'id:' + row.id, profile: row.profile }, true);
          row.fixed = r?.error ? 'release failed: ' + r.error : 'released';
        }
      }
      print(rows);
      break;
    }

    case 'note': {
      if (args.length < 2) fail('usage: note <match> <text>');
      print(await cmd({ type: 'note', urlMatch: args[0], text: args.slice(1).join(' ') }));
      break;
    }

    case 'batch': {
      // One node process for N commands — CLI startup (~60ms) is the biggest
      // per-command cost on this side of the WS, and one shell call for the
      // whole sequence saves the agent N-1 tool round trips. Stops on the
      // first error (`$ line` echoes show where). `eval <match> -` can't read
      // stdin here — batch owns it; inline the JS instead.
      const lines = (await stdin()).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      for (const line of lines) {
        console.error('$ ' + line); // stderr: stdout stays pure concatenated results (machine-parseable)
        // eval's payload is CODE, not shell words: tokenize() strips quotes
        // that are JS syntax ("button" → button → ReferenceError, #42). eval
        // lines parse off the RAW text: an optional --profile pair, the
        // <match> (bare or one quoted token), then the payload rides verbatim
        // — unless it's exactly one quoted token with an optional trailing
        // '--world w' (the shape history --batch emits via shellq), which is
        // unquoted once so a replay round-trips the original code.
        if (/^(?:--profile\s+\S+\s+)?eval(\s|$)/.test(line)) {
          let rest = line;
          const prof = rest.match(/^--profile\s+(\S+)\s+/);
          if (prof) {
            if (prof[1].startsWith('--')) fail('--profile needs an id or name (see: cli.mjs profiles)');
            PROFILE = prof[1];
            rest = rest.slice(prof[0].length);
          }
          rest = rest.replace(/^eval/, '').trimStart();
          const unq = (t) => {
            if (t[0] !== '"' && t[0] !== "'") return t;
            if (t[0] === '"') {
              try {
                return JSON.parse(t); // shellq emits JSON — the exact inverse
              } catch {
                return t;
              }
            }
            return t.slice(1, -1);
          };
          let match;
          if (rest[0] === '"' || rest[0] === "'") {
            const e = rest.indexOf(rest[0], 1);
            if (e < 0) fail('unterminated quote in batch line');
            match = unq(rest.slice(0, e + 1));
            rest = rest.slice(e + 1).trimStart();
          } else {
            const i = rest.search(/\s/);
            if (i < 0) fail('usage: eval <match> <js|-> [--world main|isolated]');
            match = rest.slice(0, i);
            rest = rest.slice(i).trimStart();
          }
          if (!rest) fail('usage: eval <match> <js|-> [--world main|isolated]');
          const qm =
            rest.match(/^("(?:[^"\\]|\\.)*"|'[^']*')(\s+--world\s+(main|isolated))?\s*$/i) ||
            rest.match(/^(\S+)(\s+--world\s+(main|isolated))\s*$/i);
          if (qm) await run('eval', qm[3] ? [match, unq(qm[1]), '--world', qm[3]] : [match, unq(qm[1])]);
          else await run('eval', [match, rest]);
          continue;
        }
        const tokens = tokenize(line);
        // A leading --profile routes this line (history --batch emits one per
        // recorded command; without this the token reads as a command name) and
        // holds for the rest of the script, like the original session had it.
        if (tokens[0] === '--profile') {
          if (!tokens[1] || tokens[1].startsWith('--')) fail('--profile needs an id or name (see: cli.mjs profiles)');
          PROFILE = tokens[1];
          tokens.splice(0, 2);
        }
        const [c, ...a] = tokens;
        if (!c) continue;
        // Interactive/process verbs make no sense inside a batch: watch never
        // exits (the batch hangs forever), start/stop kill the relay the rest
        // of the script rides on.
        if (c === 'watch' || c === 'start' || c === 'stop') fail(`'${c}' can't run inside batch — run it as its own command`);
        await run(c, a);
      }
      break;
    }

    case 'open':
      if (args.length !== 1) fail('usage: open <url>'); // extras fail loud like every other command — 'open a b' silently dropped b
      print(await cmd({ type: 'open', url: args[0] }));
      break;

    case 'nav':
    case 'navigate': {
      // Match/action commands fail locally on a typoed flag. Silently
      // ignoring --dfif here is worse than a normal usage error: an agent can
      // reasonably believe its requested observation mode ran on a real tab.
      const rest = takeFlags(args, ['--diff'], 2, 'nav <match> <url> [--diff]');
      if (rest.length !== 2) fail('usage: nav <match> <url> [--diff]');
      print(await cmd({ type: 'navigate', urlMatch: rest[0], url: rest[1], ...(args.includes('--diff') ? { diff: true } : {}) }));
      break;
    }

    case 'close': {
      const rest = takeFlags(args, ['--all'], 1, 'close <match> [--all]');
      print(await cmd({ type: 'close', urlMatch: rest[0], ...(args.includes('--all') ? { all: true } : {}) }));
      break;
    }

    case 'mark':
    case 'release':
    case 'unemulate':
    case 'activate':
      if (args.length !== 1) fail(`usage: ${cmdName} <match>`); // one arg, exactly — extras used to vanish silently
      print(await cmd({ type: cmdName, urlMatch: args[0] }));
      break;

    case 'snap': {
      if (!args[0]) fail('usage: snap <match> [css|@ref] [--diff] [--href] [--skeleton] [--find "nl query"]');
      const SNAP_FLAGS = ['--diff', '--href', '--skeleton'];
      const diff = args.includes('--diff');
      const href = args.includes('--href');
      const skeleton = args.includes('--skeleton');
      const fi = args.indexOf('--find');
      let find = null;
      if (fi >= 0) {
        // Greedy: everything after --find that isn't a KNOWN flag is the query
        // (a query can mention a '--'-word — "the --recursive flag"). A
        // one-token reader turned `--find cancel button` into find='cancel' +
        // scope='button', and the startsWith('--') filter silently DROPPED
        // query words that looked flaggy — silent wrong data both ways.
        find = args.slice(fi + 1).filter((a) => !SNAP_FLAGS.includes(a)).join(' ').trim();
        if (!find) fail('--find needs a query');
      }
      // scope = the first bare positional BEFORE --find (a scope can never
      // follow a --find query — everything there is the query). Takes a CSS
      // selector or an @ref — @ref is the --skeleton drill-down.
      const before = args.slice(1, fi < 0 ? args.length : fi);
      const scope = before.find((a) => !a.startsWith('--')) || null;
      // Same fail-loud contract as the action commands (takeFlags): a typoed
      // --dfif used to return a FULL snap the agent then read as a diff —
      // "nothing changed" conclusions off an observation that never ran.
      const stray = before.find((a) => a.startsWith('--') && !SNAP_FLAGS.includes(a));
      if (stray) fail(`unknown flag ${stray} (flags: --diff, --href, --skeleton, --find "query")`);
      const out = await cmd({ type: 'snap', urlMatch: args[0], scope, diff, href, ...(skeleton ? { skeleton: true } : {}), ...(find ? { find } : {}) });
      print(out);
      // The truncation line sits at the end of the tree — a `snap | grep foo`
      // pipe filters it out and the agent concludes "not found" when the truth
      // is "not reached". Echo it to stderr, which survives the pipe.
      const ti = typeof out === 'string' ? out.lastIndexOf('… truncated at') : -1;
      if (ti >= 0) console.error(out.slice(ti).split('\n')[0]);
      break;
    }

    // --diff on an action appends a settle + snap-diff to the result — the
    // post-action observation rides along instead of costing two more
    // shell calls (click → wait → snap --diff becomes one command).
    case 'click':
    case 'hover': {
      const rest = takeFlags(args, cmdName === 'click' ? ['--diff', '--dbl', '--trusted'] : ['--diff', '--trusted'], 2, `${cmdName} <match> <@ref|css>${cmdName === 'click' ? ' [--dbl]' : ''} [--diff] [--trusted]`);
      print(await cmd({
        type: cmdName,
        urlMatch: rest[0],
        target: rest[1],
        ...(cmdName === 'click' && args.includes('--dbl') ? { dbl: true } : {}),
        ...(args.includes('--diff') ? { diff: true } : {}),
        ...(args.includes('--trusted') ? { trusted: true } : {}),
      }));
      break;
    }

    case 'drag': {
      const rest = takeFlags(args, ['--diff', '--trusted'], 3, 'drag <match> <@ref|css> <@ref|css> [--diff] [--trusted]');
      print(await cmd({ type: 'drag', urlMatch: rest[0], from: rest[1], to: rest[2], ...(args.includes('--diff') ? { diff: true } : {}), ...(args.includes('--trusted') ? { trusted: true } : {}) }));
      break;
    }

    case 'clear': {
      const rest = takeFlags(args, ['--diff'], 2, 'clear <match> <@ref|css> [--diff]');
      print(await cmd({ type: 'clear', urlMatch: rest[0], target: rest[1], ...(args.includes('--diff') ? { diff: true } : {}) }));
      break;
    }

    case 'dialog': {
      if (!args[0] || !['accept', 'dismiss'].includes(args[1])) fail('usage: dialog <match> accept|dismiss [--text s]');
      const rest = args.slice(2);
      if (rest.length && rest[0] !== '--text') fail('usage: dialog <match> accept|dismiss [--text s]');
      const text = rest.length ? rest.slice(1).join(' ') : null;
      if (rest.length && !text) fail('--text needs an answer');
      print(await cmd({ type: 'dialog', urlMatch: args[0], accept: args[1] === 'accept', ...(text ? { text } : {}) }));
      break;
    }

    case 'fill':
    case 'type': {
      const { sep, flagged, valuePart } = splitDashDash(args);
      const rest = flagged.filter((a) => a !== '--diff' && (cmdName !== 'type' || a !== '--trusted'));
      if (!rest[0] || !rest[1] || (rest[2] === undefined && !valuePart.length)) fail(`usage: ${cmdName} <match> <@ref|css> <value> [--diff] — a value starting with '--' goes after a bare '--' separator: ${cmdName} <match> <ref> -- <value>`);
      // A '--'-prefixed token BEFORE the separator is a fat-fingered flag,
      // not data — without this guard it gets typed into the user's real form.
      const stray = rest.slice(2).find((a) => a.startsWith('--'));
      if (stray) fail(`unknown flag ${stray} (flags: --diff${cmdName === 'type' ? ', --trusted' : ''}; a value starting with '--' goes after a bare '--' separator)`);
      const value = [...rest.slice(2), ...valuePart].join(' ');
      // Per-char typing is for autocomplete/keystroke UIs — a 2000+ char type
      // is per-keystroke cost on the page's clock and blows the 70s command
      // cap on heavy composers. Long-form content is paste's job (one shot).
      if (cmdName === 'type' && value.length > 2000)
        fail(`text is ${value.length} chars — type is per-char for short interactive text; use: paste <match> <@ref|css> -- <text>`);
      print(await cmd({
        type: cmdName,
        urlMatch: rest[0],
        target: rest[1],
        value,
        ...(flagged.includes('--diff') ? { diff: true } : {}),
        ...(cmdName === 'type' && flagged.includes('--trusted') ? { trusted: true } : {}),
      }));
      break;
    }

    case 'paste': {
      // '--' = the text (may itself start with '--'), same separator as fill.
      // Without it, the OS clipboard is the source — the agent usually HAS
      // the text, but "paste what I just copied" needs the real clipboard.
      const { sep, flagged, valuePart } = splitDashDash(args);
      const rest = flagged.filter((a) => a !== '--diff' && a !== '--html');
      if (!rest[0] || rest[2] !== undefined || (sep >= 0 && !valuePart.length))
        fail('usage: paste <match> [@ref|css] [--diff] [--html] [-- <text>] — without -- <text> it reads the OS clipboard');
      const value = valuePart.join(' ');
      let clip = false;
      let text = value;
      if (!text) {
        text = readClipboard();
        if (text == null) fail(`cannot read the clipboard on ${process.platform} — install xclip/xsel, or pass the text: paste <match> <ref> -- <text>`);
        if (!text) fail('clipboard is empty — copy something, or pass the text: paste <match> <ref> -- <text>');
        clip = true;
      }
      // The clipboard read is the plain flavor only — markup must be given.
      if (flagged.includes('--html') && clip)
        fail('paste --html needs the markup after -- (the OS clipboard read is plain text only)');
      print(await cmd({ type: 'paste', urlMatch: rest[0], target: rest[1] || null, value: text, clip, ...(flagged.includes('--html') ? { html: true } : {}), ...(flagged.includes('--diff') ? { diff: true } : {}) }));
      break;
    }

    case 'press': {
      // takeFlags scans from slot 2: a stray '--x' there used to slip through
      // as the optional target (the hand-copied scan started one slot late).
      const rest = takeFlags(args, ['--diff', '--trusted'], 2, 'press <match> <key> [@ref|css] [--diff] [--trusted]');
      print(await cmd({ type: 'press', urlMatch: rest[0], key: rest[1], target: rest[2] || null, ...(args.includes('--diff') ? { diff: true } : {}), ...(args.includes('--trusted') ? { trusted: true } : {}) }));
      break;
    }

    case 'scroll': {
      const rest = takeFlags(args, ['--diff'], 2, 'scroll <match> <up|down|top|bottom|@ref|css> [--diff]');
      print(await cmd({ type: 'scroll', urlMatch: rest[0], target: rest[1], ...(args.includes('--diff') ? { diff: true } : {}) }));
      break;
    }

    case 'upload': {
      const rest = args.filter((a) => a !== '--diff');
      if (!rest[0] || !rest[1] || !rest[2]) fail('usage: upload <match> <@ref|css> <file...> [--diff]');
      const stray = rest.slice(2).find((a) => a.startsWith('--'));
      if (stray) fail(`unknown flag ${stray} (flags: --diff)`);
      // Resolve to absolute paths here — Chrome (not this process) opens them,
      // so a relative path would mean nothing on the other side of the WS.
      const files = rest.slice(2).map((f) => {
        let p;
        try {
          p = fs.realpathSync(f);
        } catch {
          fail(`file not found: ${f}`);
        }
        if (!fs.statSync(p).isFile()) fail(`not a file: ${f}`);
        return p;
      });
      print(await cmd({ type: 'upload', urlMatch: rest[0], target: rest[1], files, ...(args.includes('--diff') ? { diff: true } : {}) }));
      break;
    }

    case 'ask': {
      if (!args[0] || args.length < 2) fail('usage: ask <match> <question>');
      print(await cmd({ type: 'ask', urlMatch: args[0], question: args.slice(1).join(' ') }));
      break;
    }

    case 'net': {
      const [match, ...rest] = args;
      let duration = null;
      let filter = null;
      let body = null;
      let har = null;
      let ws = false;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--dur') {
          duration = Number(rest[++i]);
          if (!Number.isFinite(duration) || duration < 0) fail('--dur needs a number (ms)');
          // The extension silently clamps at 30s — fail here instead so the
          // agent doesn't read "no requests" for a window it believes it watched.
          if (duration > 30000) fail('--dur max is 30000 ms — run successive captures for longer windows');
        } else if (rest[i] === '--filter') {
          // Missing value must fail loud: a trailing --filter used to yield
          // undefined and the capture ran UNFILTERED — on a busy tab the
          // 100-line cap then buried the lines the agent asked for.
          filter = rest[++i];
          if (filter === undefined) fail('--filter needs a value');
        } else if (rest[i] === '--body') {
          body = rest[++i];
          if (body === undefined) fail('--body needs a value');
        }
        else if (rest[i] === '--ws') ws = true;
        else if (rest[i] === '--har') {
          har = rest[++i];
          if (har === undefined) fail('--har needs a file path');
        } else fail(`unknown flag ${rest[i]}`);
      }
      if (!match) fail('usage: net <match> [--dur ms] [--filter s] [--body s] [--ws] [--har out.har]');
      if (body && !filter) filter = body; // --body implies you only want those lines
      const out = await cmd({ type: 'net', urlMatch: match, duration, filter, body, ...(ws ? { ws: true } : {}), ...(har ? { har: true } : {}) });
      if (har) {
        // The capture as a persisted, shareable HAR 1.2 — DevTools/Burp/Caido
        // open it; text/JSON response bodies land in the file (50 max), the
        // printed lines stay exactly as without the flag.
        if (!out?.har) fail('the extension did not return a HAR (older version? reload it at chrome://extensions)');
        // A HAR from a logged-in tab carries full request/response headers —
        // Cookie, Authorization, Set-Cookie — plus postData and bodies: a
        // replayable credential bundle. Owner-only perms like server.log, and
        // the warning says it out loud (DevTools itself warns on HAR export).
        fs.writeFileSync(har, JSON.stringify(out.har, null, 1), { mode: 0o600 });
        print(out.lines);
        console.error(`saved ${har} (HAR 1.2, ${out.har.log.entries.length} entries — contains cookies/tokens: treat it as a secret; file is owner-only 0600)`);
      } else print(out);
      break;
    }

    case 'wait': {
      const [match, ...rest] = args;
      let text = null;
      let timeout = 10000;
      let human = false;
      let pixel = false;
      const pos = [];
      const WAIT_FLAGS = ['--text', '--timeout', '--human', '--pixel-change'];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--text') {
          // Multi-word text joins up to the next known flag — single-token
          // reads turned '--text Saved successfully' into a wait for 'Saved'
          // plus the leftover words OR'd in as a CSS selector: a false
          // "page ready" signal from a predicate the agent never wrote.
          const words = [];
          while (i + 1 < rest.length && !WAIT_FLAGS.includes(rest[i + 1])) {
            if (rest[i + 1].startsWith('--')) fail(`unknown flag ${rest[i + 1]} (flags: ${WAIT_FLAGS.join(', ')})`);
            words.push(rest[++i]);
          }
          text = words.join(' ');
          if (!text) fail('--text needs a value');
        } else if (rest[i] === '--timeout') {
          if (rest[i + 1] === undefined) fail('--timeout needs a value (ms)');
          timeout = Number(rest[++i]);
        } else if (rest[i] === '--human') human = true;
        else if (rest[i] === '--pixel-change') pixel = true;
        else if (rest[i].startsWith('--')) fail(`unknown flag ${rest[i]} (flags: ${WAIT_FLAGS.join(', ')})`);
        else pos.push(rest[i]);
      }
      const selector = pos[0] || null;
      if (pos.length > 1) fail('usage: wait <match> [css|--text t|--human|--pixel-change] [--timeout ms]');
      if (!match || (!selector && !text && !human && !pixel)) fail('usage: wait <match> [css|--text t|--human|--pixel-change] [--timeout ms]');
      // The usage line shows ALTERNATIVES — the extension ORs a selector+text
      // pair, resolving early on a predicate the agent didn't intend.
      if (selector && text) fail('pass a selector OR --text, not both (they would wait on either matching — chain two waits instead)');
      if (human && pixel) fail('pass --human OR --pixel-change, not both');
      if ((human || pixel) && (selector || text)) fail('usage: wait <match> --human|--pixel-change [--timeout ms] — those wait without a page predicate');
      // Above 60s the server's 70s command cap fires first and the caller gets
      // a misleading 'extension timeout' for a healthy wait — fail here instead.
      // --human extends past that cap (server-side) but not past the CLI HTTP
      // client's 5-min wall — a longer handoff is a second wait command.
      if (!Number.isFinite(timeout) || timeout < 1) fail('--timeout must be at least 1 ms');
      if (!human && timeout > 60000) fail('--timeout must be 1..60000 ms (the server kills commands at 70s)');
      if (human && timeout > 280000) fail('--timeout must be 1..280000 ms with --human (the HTTP client gives up at 5 min — start another wait for a longer handoff)');
      if (human && timeout === 10000) timeout = 120000; // a human needs more than a page does
      print(await cmd({ type: 'wait', urlMatch: match, selector, text, timeout, ...(human ? { human: true } : {}), ...(pixel ? { pixel: true } : {}) }));
      break;
    }

    case 'eval': {
      // --world is extracted from the whole arg list first: flags must work in
      // any position ('eval --world main <match> …' and '<match> … --world main'
      // both parse), or an improvising agent eats 'no tab matching "--world"'.
      const rest = [...args];
      let world = 'auto';
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] !== '--world') continue;
        const w = rest[i + 1]?.toUpperCase();
        if (w !== 'MAIN' && w !== 'ISOLATED') fail('--world needs a value: main|isolated');
        world = w; // last --world wins, like the net/wait/shot flag loops
        rest.splice(i, 2);
        i--;
      }
      const match = rest.shift();
      let code = rest.join(' ');
      if (code === '-') code = await stdin();
      if (!match || !code) fail('usage: eval <match> <js|-> [--world main|isolated]');
      const out = await cmd({ type: 'eval', urlMatch: match, code, world });
      // The last uncapped read: `eval <m> document.body.innerText` on a real
      // page dumps hundreds of KB into context. Same truncation pattern as
      // fetch — the bytes are gone, the note names the remedy.
      let s = typeof out === 'string' ? out : JSON.stringify(out) ?? String(out);
      if (s.length > 50_000)
        s = s.slice(0, 50_000) + '\n… eval output truncated at 50000 chars — return less (select narrower, slice in-page) or fetch --out the data instead';
      print(s);
      break;
    }

    case 'shot': {
      const [match, out, ...rest] = args;
      if (!match || !out) fail('usage: shot <match> <out> [--max px] [--scale N] [--format png|jpeg] [--quality N] [--crop x,y,w,h] [--full] [--diff]');
      const msg = { type: 'shot', urlMatch: match };
      for (let i = 0; i < rest.length; i++) {
        const k = rest[i];
        if (k === '--full') { msg.full = true; continue; }
        if (k === '--diff') { msg.diff = true; continue; }
        const v = rest[++i];
        if (v === undefined || v.startsWith('--')) fail(`flag ${k} needs a value`);
        if (k === '--max') msg.max = Number(v);
        else if (k === '--scale') msg.scale = Number(v);
        else if (k === '--format') msg.format = v;
        else if (k === '--quality') msg.quality = Number(v);
        else if (k === '--crop') msg.crop = v.split(',').map(Number);
        else fail(`unknown flag ${k}`);
      }
      if (msg.full && msg.crop) fail('--full and --crop are mutually exclusive');
      // --diff compares whole-viewport shots — crop/full have no baseline to diff
      if (msg.diff && (msg.full || msg.crop)) fail('--diff is exclusive with --full/--crop');
      // The diff path always captures png — jpeg/quality would be silently dropped.
      if (msg.diff && (msg.format === 'jpeg' || msg.quality !== undefined)) fail('--diff is exclusive with --format jpeg/--quality (the diff captures png)');
      for (const k of ['max', 'scale', 'quality']) if (msg[k] !== undefined && !Number.isFinite(msg[k])) fail(`flag --${k} needs a number`);
      // Ranges, mirroring emulate/wait/net: out-of-range values used to pass
      // and silently degrade to a different screenshot on the CDP fallback path.
      if (msg.max !== undefined && msg.max < 0) fail('--max must be >= 0 (0 = native res)');
      if (msg.scale !== undefined && msg.scale <= 0) fail('--scale must be > 0');
      if (msg.quality !== undefined && (msg.quality < 1 || msg.quality > 100)) fail('--quality must be 1..100');
      if (msg.format && !['png', 'jpeg'].includes(msg.format)) fail('--format must be png|jpeg');
      if (msg.crop && (msg.crop.length !== 4 || msg.crop.some((n) => !Number.isFinite(n)))) fail('--crop needs 4 numbers: x,y,w,h');
      if (msg.crop && (msg.crop[0] < 0 || msg.crop[1] < 0 || msg.crop[2] < 1 || msg.crop[3] < 1)) fail('--crop needs x,y >= 0 and w,h >= 1');
      const result = await cmd(msg);
      // --diff returns { note, data } — the note explains what the file holds
      // (baseline / full capture / the changed region only).
      const note = result && typeof result === 'object' ? result.note : null;
      const dataUrl = note ? result.data : result;
      const b64 = dataUrl.includes(',') ? dataUrl.split(',', 2)[1] : dataUrl;
      const buf = Buffer.from(b64, 'base64');
      fs.writeFileSync(out, buf);
      const d = imgDims(buf);
      if (note) console.log(note);
      console.log(`saved ${out} (${Math.round(buf.length / 1024)} KB${d ? `, ${d}` : ''})`);
      break;
    }

    case 'fetch': {
      // In-page fetch riding the logged-in session: the request runs in the
      // page (credentials ride), so login-walled JSON/feeds answer it without
      // the agent hand-rolling eval fetch plumbing. The response is untrusted
      // page content like everything else the bridge returns.
      const [match, url, ...rest] = args;
      let outFile = null, keep = false, csrf = false;
      const headers = {};
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--out') {
          outFile = rest[++i];
          if (outFile === undefined) fail('usage: fetch <match> <url> [--out file] [--keep] [--header "k: v"]... [--csrf]');
        } else if (rest[i] === '--keep') keep = true;
        else if (rest[i] === '--csrf') csrf = true;
        else if (rest[i] === '--header') {
          const h = rest[++i];
          if (h === undefined) fail('--header needs a value: --header "name: value"');
          const ci = h.indexOf(':');
          if (ci < 1) fail(`--header needs "name: value" (got ${JSON.stringify(h)})`);
          headers[h.slice(0, ci).trim()] = h.slice(ci + 1).trim();
        } else fail(`unknown flag ${rest[i]} (flags: --out file, --keep, --header "k: v", --csrf)`);
      }
      if (!match || !url) fail('usage: fetch <match> <url> [--out file] [--keep] [--header "k: v"]... [--csrf]');
      let u;
      try {
        u = new URL(url);
      } catch {}
      if (!u || !/^https?:$/.test(u.protocol)) fail('fetch needs a full http(s) URL');
      // --header/--csrf must ride BOTH the direct fetch and the scratch-tab
      // retry below — a headerless retry of a CSRF-checked API is a 403 that
      // reads as "the API is broken", not "the flag got dropped".
      const extra = { ...(Object.keys(headers).length ? { headers } : {}), ...(csrf ? { csrf: true } : {}) };
      let res = await cmd({ type: 'fetch', urlMatch: match, url, ...extra }, true);
      // #35: no matching tab → ride a throwaway tab on the TARGET'S origin
      // (fetching from an unrelated tab is cross-origin and dies on CORS).
      // open → retry by id → close; --keep leaves it for follow-up fetches.
      // Single-profile miss only: the multi-profile routing refusal ALSO says
      // 'no tab matching … in any connected profile', and a bare open can't
      // pick a seat there — the routing error already names the --profile
      // remedy, so don't narrate a scratch tab that can't open.
      if (res && res.error && res.error.includes('no tab matching') && !res.error.includes('in any connected profile')) {
        console.error(`no tab matching "${match}" — opening a scratch tab on ${u.host} for this fetch${keep ? ' (kept open)' : ''}`);
        const opened = await cmd({ type: 'open', url });
        res = await cmd({ type: 'fetch', urlMatch: `id:${opened.id}`, url, ...extra }, true);
        if (!keep) await cmd({ type: 'close', urlMatch: `id:${opened.id}` }, true);
      }
      if (res && res.error) fail(res.error);
      if (res.binary && !outFile) fail(`binary response (${res.ct || 'unknown type'}) — save it: fetch <match> <url> --out <file>`);
      if (outFile) {
        fs.writeFileSync(outFile, res.binary ? Buffer.from(res.body, 'base64') : res.body);
        console.log(`saved ${outFile} (${Math.round(Buffer.byteLength(res.body) / 1024)} KB, ${res.status} ${res.ct || ''}${res.truncated ? ' — page capped the body at 512KB' : ''})`);
      } else {
        const body = res.body || '';
        const cap = 50_000; // stdout is agent context — the whole body belongs in --out
        console.log(`${res.status} ${res.ct || ''}${res.truncated ? ' (page capped the body at 512KB)' : ''}`);
        print(body.length > cap ? body.slice(0, cap) + `\n… body truncated at ${cap} chars — save it whole: fetch <match> <url> --out <file>` : body || '(empty body)');
      }
      break;
    }

    case 'measure':
      if (args.length !== 2) fail('usage: measure <match> <css>');
      print(await cmd({ type: 'measure', urlMatch: args[0], selector: args[1] }));
      break;

    case 'console': {
      if (!args[0]) fail('usage: console <match> [--clear] [--ask [question]]');
      const ai = args.indexOf('--ask');
      let ask = null;
      if (ai >= 0) {
        const q = args.slice(ai + 1).filter((a) => a !== '--clear').join(' ');
        ask = q || true; // bare --ask → extension's default triage question
      }
      // Fail loud on strays before --ask (the question is freeform after it):
      // a typoed --clr used to run UNcleared and read as "the clear worked";
      // an extra positional was silently ignored.
      const stray = (ai < 0 ? args : args.slice(0, ai)).slice(1).find((a) => a !== '--clear');
      if (stray) fail(`unknown argument ${stray} (flags: --clear, --ask [question])`);
      print(await cmd({ type: 'console', urlMatch: args[0], clear: args.includes('--clear'), ...(ask ? { ask } : {}) }));
      break;
    }

    case 'grid':
      if (args.length !== 1) fail('usage: grid <match>');
      print(await cmd({ type: 'grid', urlMatch: args[0] }));
      break;

    case 'emulate':
    case 'resize': {
      // emulate focus: the page believes it's focused — focus-GATED work
      // keeps running in a background tab (spike, #18).
      if (cmdName === 'emulate' && args[1] === 'focus') {
        if (!args[0] || args.length !== 2) fail('usage: emulate <match> focus');
        print(await cmd({ type: 'emulate', urlMatch: args[0], focus: true }));
        break;
      }
      if (!args[0] || !args[1] || !args[2]) fail(`usage: ${cmdName} <match> <w> <h>${cmdName === 'emulate' ? ' [mobile]|focus' : ''}`);
      if ((cmdName === 'emulate' && args.length > 4) || (cmdName === 'resize' && args.length > 3) || (cmdName === 'emulate' && args[3] && args[3] !== 'mobile'))
        fail(`usage: ${cmdName} <match> <w> <h>${cmdName === 'emulate' ? ' [mobile]|focus' : ''}`);
      const w = Number(args[1]);
      const h = Number(args[2]);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) fail(`${cmdName} needs numeric <w> <h>`);
      print(await cmd({ type: cmdName, urlMatch: args[0], width: w, height: h, ...(cmdName === 'emulate' ? { mobile: args[3] === 'mobile' } : {}) }));
      break;
    }

    default:
      fail(`unknown command: ${cmdName}\n\n${USAGE}`);
  }
}

const [, , cmdName, ...args] = process.argv;
await run(cmdName, args);
