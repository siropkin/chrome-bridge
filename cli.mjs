#!/usr/bin/env node
// chrome-bridge CLI — zero dependencies, Node >= 18.
// Run without arguments for usage.
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
import { updateTarget } from './drift.mjs';
// The shared command grammar (registry, tokenizer, parse/render) — a classic
// script the extension can load too, so it publishes a global, not exports.
import './extension/commands.js';

const { lookup, splitLine, parse, render, replyWarnings } = globalThis.BridgeCommands;

// Port 9333 is hardcoded in FOUR places: extension/background.js (WS_URL —
// the extension can't read BRIDGE_PORT), server.mjs, extension/popup.js, here. Change all four.
const PORT = process.env.BRIDGE_PORT || 9333;
const BASE = `http://127.0.0.1:${PORT}`;
let invocation = randomUUID();
const diagnosticHeaders = () => ({
  'content-type': 'application/json',
  'x-bridge-source': 'cli',
  'x-bridge-invocation': invocation,
  'x-bridge-parent': String(process.ppid),
  'x-bridge-test': process.env.BRIDGE_DIAGNOSTICS_TEST === '1' ? '1' : '0',
});

// Set by commands that stop the server (stop, uninstall): there is nothing left
// to report to, and the attempt lands on a connection the exiting server resets,
// which Node 24's undici can turn into an uncaught EINVAL (nodejs/undici#6075)
// that crashed the CLI after its job was done — exit 1 broke `stop && start`.
let serverStopped = false;

async function reportCompletion(type, started, error) {
  if (serverStopped) return;
  try {
    await fetch(`${BASE}/diagnostics`, {
      method: 'POST', headers: diagnosticHeaders(), signal: AbortSignal.timeout(500),
      body: JSON.stringify({ action: 'client', type, ok: !error && !process.exitCode, error, durationMs: Math.round(performance.now() - started) }),
    });
  } catch {}
}

const fail = (msg) => {
  // Server/extension errors arrive pre-wrapped ("Error: Error: …") — strip
  // the nesting so the agent sees one clean prefix.
  throw new Error(String(msg).replace(/^(Error:\s*)+/, ''));
};
const print = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v));
// A rendered result: text on stdout, its warnings on stderr (they survive a stdout pipe).
const emit = ({ text, warnings }) => {
  console.log(text);
  for (const w of warnings) console.error(w);
};

// --profile: multi-profile routing. Extracted once at argv level (works
// before or after the command word) and rides on every command; an id prefix
// or the exact profile name is enough (see: cli.mjs profiles).
let PROFILE = null;
function extractProfile() {
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
      headers: diagnosticHeaders(),
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
  // Server hygiene warnings and new page errors ride every reply; stderr, like
  // health's version warning, so they survive stdout pipes (stdout stays the
  // command's own result).
  for (const line of replyWarnings(out)) console.error(line);
  if (!out.ok) {
    if (soft) return { error: String(out.error) };
    if (msg.type === 'eval' && typeof msg.code === 'string' && /\bSyntaxError:/.test(String(out.error))) {
      let hint = '';
      try {
        new Script(msg.code, { filename: 'bridge-eval.js' });
      } catch (cause) {
        if (cause.name === 'SyntaxError') {
          const location = /^bridge-eval\.js:(\d+)\n[^\n]*\n( *)\^/.exec(cause.stack || '');
          hint = '\nLocal syntax check also failed' + (location ? ` at line ${location[1]}, column ${location[2].length + 1}` : '') + '. Fix the JavaScript or shell quoting before retrying; use eval <match> - to pass code through stdin.';
        }
      }
      if (hint) fail(String(out.error) + hint);
    }
    fail(out.error);
  }
  return out.result;
}

async function stdin() {
  // Decode once: a multi-byte character can straddle two pipe chunks.
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
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

// The I/O extension/commands.js's parse() needs for the handful of commands
// that touch the disk/clipboard/stdin — this is the only surface that has
// all four; the cloud link (C1) will pass a narrower object and let parse()'s
// next-step errors cover the gaps.
const io = {
  stdin,
  clipboard: () => {
    const text = readClipboard();
    if (text == null) fail(`cannot read the clipboard on ${process.platform} — install xclip/xsel, or pass the text: paste <match> <ref> -- <text>`);
    return text;
  },
  // wait --js's client-side pre-check: the extension's CSP forbids eval/new
  // Function, so commands.js can't run this itself — only whether it's ONE
  // expression matters here (cause.name), the message text stays put.
  syntaxError: (src) => {
    try {
      new Script(src, { filename: 'bridge-wait.js' });
      return false;
    } catch (cause) {
      return cause.name === 'SyntaxError';
    }
  },
  // Resolve to an absolute path here — Chrome (not this process) opens it,
  // so a relative path would mean nothing on the other side of the WS.
  resolveFile: (f) => {
    let p;
    try {
      p = fs.realpathSync(f);
    } catch {
      fail(`file not found: ${f}`);
    }
    if (!fs.statSync(p).isFile()) fail(`not a file: ${f}`);
    return p;
  },
};

// Adding a command? EIGHT registries stay in sync (a missing one fails SILENTLY):
// cli.mjs USAGE · extension/commands.js REGISTRY + parse() (or cli.mjs run() for the
// commands the CLI handles itself) · server.mjs CLI_LINES · server.mjs route() (only if it
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
  snap <match> [css|@ref] [--diff] [--href] [--skeleton] [--no-fold] [--find "nl"]
                                    a11y-tree snapshot with @eN refs (cheap — use before shot);
                                    [css|@ref] scopes to a subtree (@ref = the --skeleton drill-down),
                                    --diff shows only changes since last snap,
                                    --href includes all link URLs (default: only nameless links);
                                    --skeleton: depth-limited map — cut containers read '… N inside'
                                    (drill: snap <match> @ref) instead of a silent 300-node cut;
                                    --no-fold: keep repeated lines inline in document order —
                                    the '… N more' summaries move folded refs to the end, so
                                    scripted last-line picks got the wrong row;
                                    --find asks local Gemini Nano to pick the lines matching a
                                    natural-language query — up to 8 lines (seconds on a scoped
                                    tree, 15-35s on a whole big page) to VERIFY, not ground
                                    truth (~2/3 accurate in testing); lines prefixed '* ' are new
                                    since the previous snap; lines seen 3+ times collapse to
                                    '… N more · <line> → @refs'; trees truncate at 300 nodes —
                                    scope big pages with [css|@ref], or --skeleton first;
                                    a visible modal (dialog/aria-modal) swallowed by any cut is
                                    appended as '(modal layer past the cut …)' and echoed to
                                    stderr; names over 60 chars are cut mid-name (tail kept)
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
  upload <match> <@ref|css> <file...> [--chooser] [--diff]
                                    set a file input's files (CDP — works on hidden
                                    inputs; target the input or an element wrapping it).
                                    --chooser: target the button that OPENS the OS file
                                    picker — it gets intercepted, no dialog shown (for
                                    apps whose input exists only at pick time)
  ask <match> <question>            (experimental) answer from page text with Chrome's
                                    built-in Gemini Nano — local, no cloud tokens
  wait <match> <css|--text t|--js expr|--human|--pixel-change> [--timeout ms] [--world main]
                                    wait for element or visible text (timeout default 10s,
                                    max 60s); --text takes every word up to the next flag
                                    (unquoted multi-word is fine); css/--text are
                                    alternatives — pass one, not both;
                                    --js polls a page expression (awaited; '-' = stdin) until
                                    truthy and prints its value — replaces sleep-in-eval and
                                    shell polling loops; runs in the page world (page
                                    globals visible);
                                    --human hands the tab to the user — CAPTCHA/
                                    2FA/login walls — the pill asks them to act, the command
                                    blocks until trusted input or navigation (default 120s,
                                    max 280s), then returns the snap-diff of what they did;
                                    --pixel-change polls the viewport until pixels move
                                    (canvas changes the tree can't see; attaches CDP)
  eval <match> <js|-> [--world main]              '-' reads JS from stdin; output
                                    caps at 50K chars — return less (slice in-page), or fetch --out;
                                    top-level const/let are scoped to each call — re-running
                                    the same snippet never collides (set globals via window.x)
  shot <match> <out> [--max px] [--scale N] [--format png|jpeg] [--quality N] [--crop x,y,w,h] [--full] [--diff]
                                    --max caps the long edge (default 1280, sized for agent
                                    reading; 0 = native res — use it for any screenshot a
                                    human will see: PRs, issues, chat, docs);
                                    --diff compares against the previous --diff shot and, on
                                    change, saves ONLY the changed region (canvas/pixel changes
                                    the tree can't see); --crop takes a measure rect (CSS px,
                                    viewport-relative) and renders beyond the viewport — an
                                    off-screen or taller-than-viewport element captures whole;
                                    --full = whole page (16384px cap), exclusive with --crop
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
  perf <match> [--dur ms]           CPU over a window (default 5s, max 30s; CDP): renderer +
                                    main-thread CPU %, main-thread busy split (script/style/
                                    layout/other), style+layout rates, heap; plus running
                                    animations grouped by property — '⚠ not composited' ones
                                    repaint every frame. Warns when the tab is hidden (Chrome
                                    throttles it — the numbers would lie). GPU process not seen
  measure <match> <css|@ref>        rect + computed styles as JSON, one entry per match: display,
                                    alignment, gap, padding, margin, border, radius, colors,
                                    font (= size/weight) and family
  console <match> [--clear] [--ask [question]]
                                    page console + errors (hook installs on first call);
                                    --ask triages the log with local Gemini Nano — only
                                    the verdict costs cloud tokens, not the noise.
                                    No need to poll it for errors: every command on a driven
                                    tab prints '⚠ N new page errors since the last command'
                                    (console.error + uncaught, newest 5) to stderr on its own
  grid <match>                      toggle 8px alignment grid
  mark|release <match>              add/remove driven-tab markers; release clears emulation too
  activate <match>                  bring a background tab to the front (trusted input
                                    needs it — CDP dispatch on a hidden tab fires nothing);
                                    warns when the tab STAYS hidden — an occluded/minimized
                                    window can't be activated into view; emulate <match>
                                    focus is the remedy there
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
  emulate <match> <w> <h> [mobile] [dsf=N]   CDP device view (no window resize); dsf=N pins the
                                    device scale factor (dsf=2 = retina captures on any
                                    display — shot --max <w> then downsamples to exact px;
                                    mobile alone = dsf 2, 'mobile dsf=3' = a 3x phone; the
                                    reply echoes the dsf in effect);
                                    'focus' instead of <w> <h> emulates page focus
                                    (focus-gated work keeps running in a background tab —
                                    does NOT render an occluded window)
  unemulate <match>                 clear emulation + detach debugger
  resize <match> <w> <h>            resize the window
  health                            server + extension status; ⚠ lines on stderr name any
                                    version drift (server vs its checkout, extension vs repo)
  update [--check]                  bring this checkout to the code matching the connected
                                    extension and restart the server on it: a Chrome Web
                                    Store install pins to that extension's release tag, an
                                    unpacked one pulls the branch (git ff-only, or a fresh
                                    download without git; local commits/edits are never
                                    moved). Restarting drops other sessions' in-flight
                                    commands. --check prints the plan, changes nothing
  start                             start the server (detached) if it's down
  stop                              stop the server
  uninstall [--yes]                 remove chrome-bridge from this computer: stop the server,
                                    remove the agent skill (~/.claude/skills/chrome-bridge)
                                    and delete this bridge folder. Without --yes it only lists
                                    what it would remove. Never deletes someone's work: a git
                                    checkout with local edits, untracked files, a stash, other
                                    worktrees or commits origin doesn't have (any branch, tag or
                                    detached HEAD) is kept, so is a folder inside another git
                                    repo or a submodule; a download's recipes/ moves next to it
                                    first. The Chrome extension is removed from its popup

<match> is a substring of the tab URL or title. It must identify exactly one tab in the
selected profile; ambiguous matches are refused before anything runs — re-run with a
longer match. Every command that targets a tab marks it (🟣 pill + tab group) —
reads (snap/measure/console/net) included; release when you're done.
Refs (@eN) come from snap; they survive re-snaps but expire on navigation.
CSS selectors match document-level first, then pierce open shadow roots.

Multiple Chrome profiles can be connected at once (one seat each). A <match>
routes to the only profile that has a matching tab; a match in SEVERAL profiles
is refused — name one with --profile <id or name> (an id prefix is enough; see: profiles).`;

// Adding a command? EIGHT registries stay in sync (a missing one fails SILENTLY):
// cli.mjs USAGE · extension/commands.js REGISTRY + parse() (or cli.mjs run() for the
// commands the CLI handles itself) · server.mjs CLI_LINES · server.mjs route() (only if it
// needs special routing) · background.js handle() · ACT_VERBS (pill narration) · MUTATING.
async function run(cmdName, args) {
  const previous = invocation;
  invocation = randomUUID();
  const started = performance.now();
  try {
    await runCommand(cmdName, args);
    await reportCompletion(cmdName || 'help', started);
  } catch (cause) {
    await reportCompletion(cmdName || 'help', started, String(cause));
    throw cause;
  } finally {
    invocation = previous;
  }
}

async function runCommand(cmdName, args) {
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
        // Stale-extension-code warnings, precomputed by the server (#63).
        for (const w of h.warn || []) console.error('⚠ ' + w);
        // Not a fault to fix: the human switched these profiles off for local
        // agents (popup → ⚙ Settings → Local AI agents).
        if (h.localOff?.length) console.error(`note: Local AI agents is switched off in the chrome-bridge popup of: ${h.localOff.join(', ')} — unreachable until the user switches it on (⚙ Settings)`);
        // Exit 1 when the extension is disconnected: `health && …` preflights
        // and SDK-style gating read the exit code, and 0 here lied about a
        // bridge that can't run a command. The JSON still prints — which half
        // failed stays readable — and the stale-version warnings above ride
        // stderr either way.
        if (!h.extension) process.exitCode = 1;
        // Version drift (server vs its checkout, each extension vs the
        // manifest) is computed server-side (drift.mjs) and arrives in h.warn.
        // A server without h.v predates that — it is old code by definition.
        if (!h.v) console.error('⚠ the running server predates version reporting — it is old code: run `cli.mjs update` (or `cli.mjs stop && cli.mjs start`)');
        else {
          // This CLI may belong to another checkout than the running server.
          let mine = null;
          try {
            mine = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')).version;
          } catch {}
          const here = fileURLToPath(new URL('.', import.meta.url));
          const differ = process.platform === 'win32' ? String(h.repo).toLowerCase() !== here.toLowerCase() : h.repo !== here;
          if (mine && h.repo && differ && mine !== h.v)
            console.error(`⚠ this CLI (${mine}, ${here}) talks to a server from another checkout (${h.v}, ${h.repo}) — run that checkout's cli.mjs, or stop it and start this one`);
        }
        // Same drift class for the installed Claude Code skill: a `cp -r`
        // copy goes stale on every repo update (health is the natural place
        // to notice — it already warns on the stale extension). A symlinked
        // install tracks the repo, so it stays quiet. Local files only, and
        // a warn never changes the exit code.
        try {
          const skillDir = join(homedir(), '.claude', 'skills', 'chrome-bridge');
          const repoSkill = fileURLToPath(new URL('./.claude/skills/chrome-bridge', import.meta.url));
          const skillFiles = ['SKILL.md', ...fs.readdirSync(join(repoSkill, 'reference')).map((f) => join('reference', f))];
          const read = (f) => fs.readFileSync(f, 'utf8');
          if (
            !fs.lstatSync(skillDir, { throwIfNoEntry: false })?.isSymbolicLink() &&
            fs.existsSync(join(skillDir, 'SKILL.md')) &&
            skillFiles.some((f) => !fs.existsSync(join(skillDir, f)) || read(join(skillDir, f)) !== read(join(repoSkill, f)))
          )
            console.error(
              `⚠ the installed Claude Code skill at ${skillDir} differs from the repo's (a copied install goes stale) — re-install as a symlink: rm -rf ~/.claude/skills/chrome-bridge && ln -s ${repoSkill} ~/.claude/skills/chrome-bridge`
            );
        } catch {}
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

    case 'update': {
      // Move THIS checkout to the code matching the connected extension, then
      // restart the server on it. Store install → the release tag of the
      // extension Chrome runs, so the skill and CLI document exactly that
      // build (master runs ahead of the store while a release is in review).
      // Unpacked → the branch: that extension loads from this checkout.
      // Unpacked extensions are NOT reloaded here — extreload wipes driven-tab
      // memory that other agent sessions may hold; health names the fix.
      if (args.some((a) => a !== '--check')) fail('usage: update [--check]');
      const check = args.includes('--check');
      const repo = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, '');
      const self = fileURLToPath(import.meta.url);
      // Child CLI runs pick up the NEW code once the files moved.
      const runCli = (...a) => spawnSync(process.execPath, [self, ...a], { encoding: 'utf8', env: process.env });
      const pkgVersion = () => {
        try {
          return JSON.parse(fs.readFileSync(join(repo, 'package.json'), 'utf8')).version;
        } catch {
          return null;
        }
      };
      const getHealth = () => fetch(`${BASE}/health`).then((r) => r.json()).then((x) => (x?.ok === true ? x : null)).catch(() => null);
      let h = await getHealth();
      if (!h && !check) {
        runCli('start');
        h = await getHealth();
      }
      if (!h) fail("bridge server not running — update reads the connected extension's version from it: node cli.mjs start");
      const plan = updateTarget((h.profiles || []).map((p) => ({ pid: p.id, name: p.name, v: p.v, install: p.install })));
      if (plan.error) fail(plan.error);
      const target = plan.target === 'tag' ? plan.tag : 'the branch';
      // win32 paths compare case-insensitively (c:\ vs C:\ from how the CLI was invoked)
      const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
      const serverHere = !!h.repo && samePath(String(h.repo).replace(/[\\/]$/, ''), repo);
      const before = pkgVersion();
      const steps = [];
      let changed = false;
      const isGit = fs.existsSync(join(repo, '.git'));
      if (isGit) {
        const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
        if (git('--version').error) fail('git not found — install git, or remove .git to update by download');
        if (git('status', '--porcelain', '--untracked-files=no').stdout.trim()) fail(`local edits to tracked files in ${repo} — commit or stash them, then re-run update (nothing changed)`);
        const head0 = git('rev-parse', 'HEAD').stdout.trim();
        if (plan.target === 'branch') {
          if (check) steps.push('git pull --ff-only');
          else {
            const r = git('pull', '--ff-only', '--quiet');
            if (r.status) fail('git pull --ff-only failed — nothing changed:\n' + (r.stderr || r.stdout).trim());
          }
        } else {
          const tag = plan.tag;
          const shallow = git('rev-parse', '--is-shallow-repository').stdout.trim() === 'true';
          const hasTag = git('rev-parse', '-q', '--verify', `refs/tags/${tag}`).status === 0;
          if (check && !hasTag) steps.push(`fetch ${tag} from origin, then fast-forward to it, or move back to it if nothing local would move`);
          else {
            // --check never fetches (it changes nothing); a real run never
            // force-moves a local tag — git refuses to clobber one, so do we.
            if (!check) {
              const f = git('fetch', '--quiet', ...(shallow ? ['--depth', '1'] : []), 'origin', `refs/tags/${tag}:refs/tags/${tag}`);
              if (f.status) fail(`could not fetch ${tag} from origin (or a local ${tag} tag points elsewhere) — nothing changed:\n${(f.stderr || '').trim()}`);
            }
            const want = git('rev-parse', `${tag}^{commit}`).stdout.trim();
            if (head0 === want) steps.push(`already at ${tag}`);
            else if (git('merge-base', '--is-ancestor', 'HEAD', tag).status === 0) {
              if (check) steps.push(`git merge --ff-only ${tag}`);
              else if (git('merge', '--ff-only', '--quiet', tag).status) fail(`fast-forward to ${tag} failed — nothing changed`);
            } else {
              // Ahead of the store's release (or a shallow clone that can't
              // tell). Moving is safe only when every commit HEAD has stays
              // reachable from origin or a tag — a fresh clone of master, or a
              // previous release pin; local commits (someone's recipes) stay put.
              const localOnly = Number(git('rev-list', '--count', 'HEAD', '--not', '--remotes', '--tags').stdout.trim() || 0);
              if (localOnly) fail(`${repo} has ${localOnly} local commit(s) not on origin — left as is; it can't be matched to ${tag} without moving them`);
              if (check) steps.push(`git reset --keep ${tag} (nothing local is lost — every commit stays on origin or a tag)`);
              else if (git('reset', '--keep', '--quiet', tag).status) fail(`moving to ${tag} failed — nothing changed`);
            }
          }
        }
        changed = !check && git('rev-parse', 'HEAD').stdout.trim() !== head0;
        if (changed) steps.push(`checkout moved to ${target}`);
        else if (!check && !steps.length) steps.push(`already up to date with ${target}`);
      } else {
        const ref = plan.target === 'tag' ? `refs/tags/${plan.tag}` : 'refs/heads/master';
        // Only this repo's release tags or master: dot segments in a tag would move the URL to another repo.
        if (!/^refs\/(tags\/v\d+\.\d+\.\d+|heads\/master)$/.test(ref)) fail(`refusing to download ${ref}: not a release tag of siropkin/chrome-bridge — nothing changed`);
        const url = `https://github.com/siropkin/chrome-bridge/archive/${ref}.tar.gz`;
        if (check) steps.push('download ' + url);
        else {
          const res = await fetch(url).catch(() => null);
          if (!res?.ok) fail(`download failed (${res?.status || 'network error'}): ${url} — nothing changed`);
          const tmp = join(tmpdir(), `chrome-bridge-${process.pid}.tar.gz`);
          fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
          const t = spawnSync('tar', ['xzf', tmp, '--strip-components=1', '-C', repo], { encoding: 'utf8' });
          fs.rmSync(tmp, { force: true });
          if (t.status) fail('unpacking failed — the download may be partly applied; re-run update:\n' + (t.stderr || '').trim());
          changed = true;
          steps.push(`downloaded ${target === 'the branch' ? 'master' : target}`);
        }
      }
      const after = check ? before : pkgVersion();
      const serverDrift = !h.v || (h.warn || []).some((w) => /^this server runs|^server code on disk/.test(w));
      const restart = serverHere && (changed || h.v !== after || serverDrift);
      // A server too old to report its checkout can't be matched to this one.
      const elsewhere = h.repo ? `it runs from ${h.repo}; run that checkout's cli.mjs update` : "it predates checkout reporting — restart it yourself: cli.mjs stop && cli.mjs start";
      if (check) {
        print({ repo, target, via: isGit ? 'git' : 'download', steps, restart: serverHere ? 'when anything changed or the server runs older code' : `no — ${elsewhere}`, ...(plan.note ? { note: plan.note } : {}) });
        break;
      }
      // A restart drops in-flight commands of every session on this server.
      if (restart) {
        runCli('stop');
        steps.push('server restarted — ' + runCli('start').stdout.trim());
      } else if (!serverHere) steps.push(`server not restarted — ${elsewhere}`);
      print({ repo, from: before, to: after, steps });
      if (plan.note) console.error('⚠ ' + plan.note);
      // Health on the NEW code: whatever is still out of step (an unpacked
      // build to extreload, a copied skill) prints its own fix.
      process.stderr.write(runCli('health').stderr || '');
      break;
    }

    case 'uninstall': {
      // One step for a person (via their agent): list what goes, then — with
      // --yes — remove it. Never deletes someone's work: a git checkout with
      // local edits, untracked files or local commits stays, named (the same
      // line update holds). What a CLI can't do (an instructions line the agent
      // added, the Chrome extension) ends the output as next steps.
      if (args.some((a) => a !== '--yes')) fail('usage: uninstall [--yes]');
      const yes = args.includes('--yes');
      const repo = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, '');
      const actions = [];
      const kept = [];
      // The server — only one running from THIS folder (another checkout's
      // server is someone else's install).
      const h = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
      const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
      if (h?.ok && (!h.repo || samePath(String(h.repo).replace(/[\\/]$/, ''), repo)))
        actions.push(['stop the bridge server', () => ((serverStopped = true), fetch(`${BASE}/stop`, { method: 'POST' }).catch(() => null))]);
      else if (h?.ok) kept.push(`the running bridge server belongs to another folder (${h.repo}) — left running`);
      // The agent skill: our symlink, or a copy of our skill.
      const skill = join(homedir(), '.claude', 'skills', 'chrome-bridge');
      let st = null;
      try {
        st = fs.lstatSync(skill);
      } catch {}
      if (st?.isSymbolicLink()) {
        // Real paths on both sides: /var vs /private/var (macOS), a symlinked home…
        const real = (p) => {
          try {
            return fs.realpathSync(p);
          } catch {
            return p;
          }
        };
        const target = real(resolvePath(dirname(skill), fs.readlinkSync(skill)));
        const repoReal = real(repo);
        if (samePath(target, repoReal) || target.startsWith(repoReal + sep)) actions.push([`remove the agent skill link ${skill}`, () => fs.unlinkSync(skill)]);
        else kept.push(`${skill} points to another folder (${target}) — left as is`);
      } else if (st?.isDirectory()) {
        let md = '';
        try {
          md = fs.readFileSync(join(skill, 'SKILL.md'), 'utf8');
        } catch {}
        if (/^name:\s*chrome-bridge\s*$/m.test(md)) actions.push([`remove the agent skill copy ${skill}`, () => fs.rmSync(skill, { recursive: true, force: true })]);
        else kept.push(`${skill} is not a chrome-bridge skill — left as is`);
      }
      // The bridge folder itself, only when it is really ours and holds nothing
      // of anyone's. Every doubt keeps it: a git checkout must be clean (all
      // untracked files shown), with no stash and no commit on ANY local branch
      // that isn't on a remote or a tag, and every git call must succeed. A
      // folder inside another git repo (vendored) is that repo's business. A
      // download (no git) can't be checked file by file, so its recipes/ — where
      // people save their own — moves next to it first.
      let pkgName = null;
      try {
        pkgName = JSON.parse(fs.readFileSync(join(repo, 'package.json'), 'utf8')).name;
      } catch {}
      const home = homedir();
      let keepRepo = null;
      let saveRecipes = null;
      const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
      const hasGit = !git('--version').error;
      const top = hasGit ? git('rev-parse', '--show-toplevel') : null;
      const inRepo = top && top.status === 0;
      if (pkgName !== 'chrome-bridge' || samePath(repo, home) || repo === dirname(repo)) keepRepo = `${repo} doesn't look like a chrome-bridge folder — left as is`;
      else if (fs.existsSync(join(repo, '.git')) && !hasGit) keepRepo = `${repo} is a git checkout and git isn't available to check it for local work — left as is`;
      else if (fs.existsSync(join(repo, '.git')) && !inRepo) keepRepo = `${repo} is a git checkout git can't read (${(top?.stderr || '').trim().split('\n')[0] || 'unknown error'}) — left as is`;
      else if (inRepo && !samePath(fs.realpathSync(top.stdout.trim()), fs.realpathSync(repo))) keepRepo = `${repo} is inside another git repository (${top.stdout.trim()}) — left as is`;
      else if (hasGit && !inRepo && !/not a git repository/i.test(top.stderr || '')) keepRepo = `${repo}: git couldn't read the folders around it (${(top.stderr || '').trim().split('\n')[0] || 'unknown error'}) — left as is`;
      else if (inRepo && git('rev-parse', '--show-superproject-working-tree').stdout.trim()) keepRepo = `${repo} is a submodule of another git repository — left as is`;
      else if (inRepo) {
        const status = git('status', '--porcelain', '--untracked-files=all');
        const stash = git('stash', 'list');
        const worktrees = git('worktree', 'list', '--porcelain');
        // Protected: HEAD (a detached one too), every branch, every tag. Safe:
        // what the remotes' branches hold, plus tags the remote confirms it has
        // (a store install sits on a release tag fetched from origin). A remote
        // that can't be reached confirms nothing — its tags stay protected.
        const remoteTags = spawnSync('git', ['-C', repo, 'ls-remote', '--tags', 'origin'], { encoding: 'utf8', timeout: 15000 });
        const confirmed = remoteTags.status === 0 ? [...new Set(remoteTags.stdout.split('\n').map((l) => l.split('\t')[0]).filter((x) => /^[0-9a-f]{40}$/.test(x)))] : [];
        const known = confirmed.filter((sha) => git('cat-file', '-e', `${sha}^{commit}`).status === 0);
        const local = git('rev-list', '--count', 'HEAD', '--branches', '--tags', '--not', '--remotes', ...known);
        if ([status, stash, worktrees, local].some((r) => r.status !== 0 || r.error)) keepRepo = `${repo}: couldn't check it for local work — left as is`;
        else if (status.stdout.trim()) keepRepo = `${repo} has local edits or untracked files — left as is (delete it yourself once you've saved what you need)`;
        else if (stash.stdout.trim()) keepRepo = `${repo} has stashed changes — left as is`;
        else if ((worktrees.stdout.match(/^worktree /gm) || []).length > 1) keepRepo = `${repo} has other git worktrees using it (git worktree list) — left as is`;
        else if (Number(local.stdout.trim()))
          keepRepo = `${repo} has ${Number(local.stdout.trim())} commit(s) not on origin (a branch, a tag or a detached HEAD${remoteTags.status === 0 ? '' : '; origin could not be reached to confirm its tags'}) — left as is`;
      } else {
        const recipes = join(repo, 'recipes');
        let hasRecipes = false;
        try {
          hasRecipes = fs.readdirSync(recipes).length > 0;
        } catch {}
        if (hasRecipes) {
          let dest = join(dirname(repo), 'chrome-bridge-recipes');
          for (let i = 2; fs.existsSync(dest); i++) dest = join(dirname(repo), `chrome-bridge-recipes-${i}`);
          saveRecipes = dest;
        }
      }
      if (keepRepo) kept.push(keepRepo);
      else {
        if (saveRecipes) actions.push([`move ${join(repo, 'recipes')} to ${saveRecipes} (your saved site recipes stay)`, () => fs.renameSync(join(repo, 'recipes'), saveRecipes)]);
        actions.push([
          `delete ${repo} (the bridge, its logs and settings)`,
          () => {
            // Step out first: a folder that is the current directory can't be removed on Windows.
            process.chdir(dirname(repo));
            beforeDelete = fs.readdirSync(repo);
            fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
          },
        ]);
      }
      const next = [
        'If you (the agent) added a line about chrome-bridge to an instructions file (AGENTS.md, CLAUDE.md, .cursorrules, …), remove it.',
        'Last step, in Chrome: toolbar popup → ⚙ → Remove Chrome Bridge (or chrome://extensions → Remove). It also signs that browser out of Cloud Bridge.',
      ];
      const lines = (xs) => xs.map((x) => '  - ' + x).join('\n');
      if (!yes) {
        const out = [actions.length ? `uninstall would:\n${lines(actions.map((a) => a[0]))}` : 'nothing to remove on this computer'];
        if (kept.length) out.push(`kept:\n${lines(kept)}`);
        if (actions.length) out.push(`Nothing changed yet. Show this to the user; once they agree: node ${join(repo, 'cli.mjs')} uninstall --yes`);
        out.push(`Then:\n${lines(next)}`);
        print(out.join('\n\n'));
        break;
      }
      const done = [];
      const problems = [];
      let beforeDelete = null;
      for (const [what, run] of actions) {
        // A failed step before the delete (moving the recipes) cancels the delete.
        if (what.startsWith('delete') && problems.length) {
          kept.push(`${repo} — left as is because an earlier step failed`);
          continue;
        }
        try {
          await run();
          done.push(what.replace(/^stop/, 'stopped').replace(/^remove/, 'removed').replace(/^delete/, 'deleted').replace(/^move/, 'moved'));
        } catch (e) {
          // rmSync deletes contents first, in no promised order: compare what the
          // folder held before with what is left to say "untouched" or "partly".
          if (what.startsWith('delete')) {
            let left = [];
            try {
              left = fs.readdirSync(repo);
            } catch {}
            const untouched = beforeDelete && beforeDelete.every((n) => left.includes(n)) && fs.existsSync(join(repo, '.git')) === beforeDelete.includes('.git');
            problems.push(untouched ? `could not delete ${repo} (${e.message}) — it is still there` : `partly deleted ${repo} (${e.message}) — remove what's left of it by hand`);
          }
          else problems.push(`could not ${what}: ${e.message}`);
        }
      }
      const out = [done.length ? `done:\n${lines(done)}` : 'nothing was removed'];
      if (problems.length) out.push(`problems:\n${lines(problems)}`);
      if (kept.length) out.push(`kept:\n${lines(kept)}`);
      out.push(`Next:\n${lines(next)}`);
      print(out.join('\n\n'));
      break;
    }

    case 'stop': {
      serverStopped = true;
      const res = await fetch(`${BASE}/stop`, { method: 'POST' }).catch(() => null);
      // Nothing-to-stop is success for the caller's purpose: setup texts tell
      // agents (and install.sh tells humans) `stop && start`, and a fresh
      // machine must not have the first half of that fail with exit 1.
      print(res?.ok ? 'stopped' : 'stopped (nothing was running)');
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
      const parsed = await parse([cmdName, ...args], io);
      const rows = await cmd(parsed.msg);
      if (parsed.msg.fix) {
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
      emit(render(parsed, rows));
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
        // An optional leading --profile routes the line and holds for the rest
        // of the script, like the original session had it; eval payloads ride
        // verbatim, everything else is shell-tokenized (splitLine).
        const { profile, argv } = splitLine(line);
        if (profile) PROFILE = profile;
        const [c, ...a] = argv;
        if (!c) continue;
        // Interactive/process verbs make no sense inside a batch: watch never
        // exits (the batch hangs forever), start/stop kill the relay the rest
        // of the script rides on.
        if (c === 'watch' || c === 'start' || c === 'stop') fail(`'${c}' can't run inside batch — run it as its own command`);
        await run(c, a);
      }
      break;
    }

    case 'paste': {
      const parsed = await parse([cmdName, ...args], io);
      print(await cmd(parsed.msg));
      break;
    }

    case 'upload': {
      const parsed = await parse([cmdName, ...args], io);
      print(await cmd(parsed.msg));
      break;
    }

    case 'net': {
      const parsed = await parse([cmdName, ...args], io);
      const out = await cmd(parsed.msg);
      const har = parsed.view.har;
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
      const parsed = await parse([cmdName, ...args], io);
      print(await cmd(parsed.msg));
      break;
    }

    case 'eval': {
      const parsed = await parse([cmdName, ...args], io);
      emit(render(parsed, await cmd(parsed.msg)));
      break;
    }

    case 'shot': {
      const parsed = await parse([cmdName, ...args], io);
      const out = parsed.view.out;
      const result = await cmd(parsed.msg);
      // --diff returns { note, data } — the note explains what the file holds
      // (baseline / full capture / the changed region only).
      const note = result && typeof result === 'object' ? result.note : null;
      const dataUrl = note ? result.data : result;
      const b64 = dataUrl.includes(',') ? dataUrl.split(',', 2)[1] : dataUrl;
      const buf = Buffer.from(b64, 'base64');
      fs.mkdirSync(dirname(out), { recursive: true });
      fs.writeFileSync(out, buf);
      const d = imgDims(buf);
      if (note) console.log(note);
      console.log(`saved ${out} (${Math.round(buf.length / 1024)} KB${d ? `, ${d}` : ''})`);
      // Default cap hit = probably downscaled; agents otherwise ship blurry PR/chat screenshots.
      if (!note && parsed.view.max === undefined && d && Math.abs(Math.max(...d.split('x').map(Number)) - 1280) <= 1)
        console.error('note: long edge capped at the 1280px default (sized for agent reading) — a screenshot for a human (PR, issue, chat, docs)? re-run with --max 0 for native resolution');
      break;
    }

    case 'fetch': {
      const parsed = await parse([cmdName, ...args], io);
      const { urlMatch: match, url } = parsed.msg;
      const { outFile, keep, host } = parsed.view;
      let res = await cmd(parsed.msg, true);
      // #35: no matching tab → ride a throwaway tab on the TARGET'S origin
      // (fetching from an unrelated tab is cross-origin and dies on CORS).
      // open → retry by id → close; --keep leaves it for follow-up fetches.
      // Single-profile miss only: the multi-profile routing refusal ALSO says
      // 'no tab matching … in any connected profile', and a bare open can't
      // pick a seat there — the routing error already names the --profile
      // remedy, so don't narrate a scratch tab that can't open.
      if (res && res.error && res.error.includes('no tab matching') && !res.error.includes('in any connected profile')) {
        console.error(`no tab matching "${match}" — opening a scratch tab on ${host} for this fetch${keep ? ' (kept open)' : ''}`);
        const opened = await cmd({ type: 'open', url });
        res = await cmd({ ...parsed.msg, urlMatch: `id:${opened.id}` }, true);
        if (!keep) await cmd({ type: 'close', urlMatch: `id:${opened.id}` }, true);
      }
      if (res && res.error) fail(res.error);
      if (res.binary && !outFile) fail(`binary response (${res.ct || 'unknown type'}) — save it: fetch <match> <url> --out <file>`);
      // A dev-proxy route that does not match serves the SPA shell (index.html)
      // as a 200 text/html "success" (#66) — the JSON parse then dies far from
      // the cause. Name it at the fetch, before the file misleads.
      if (/text\/html/i.test(res.ct || ''))
        console.error(`⚠ response is HTML, not the JSON you likely wanted — an unmatched dev-proxy route serves the SPA shell; check the path (status ${res.status})`);
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

    default: {
      // Browser commands: the shared grammar (extension/commands.js) parses
      // and renders; this side owns the transport and the printing.
      if (lookup(cmdName)?.scope !== 'browser') fail(`unknown command: ${cmdName}\n\n${USAGE}`);
      const parsed = await parse([cmdName, ...args], io);
      emit(render(parsed, await cmd(parsed.msg)));
    }
  }
}

try {
  if (typeof fetch !== 'function') fail('Node >= 18 required — you have ' + process.version);
  try {
    extractProfile();
  } catch (cause) {
    await reportCompletion('profile-parse', performance.now(), String(cause));
    throw cause;
  }
  const [, , cmdName, ...args] = process.argv;
  await run(cmdName, args);
} catch (cause) {
  console.error(`ERROR: ${String(cause).replace(/^(Error:\s*)+/, '')}`);
  process.exitCode = 1;
}
