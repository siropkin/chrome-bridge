#!/usr/bin/env node
// chrome-bridge CLI — zero dependencies, Node >= 18.
// Run without arguments for usage.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

// Image dimensions from the buffer header (PNG IHDR / JPEG SOF) — agents map
// shot pixels back to CSS px, and --max rescales extension-side, so print them.
const imgDims = (b) => {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
  for (let i = 2; i + 9 < b.length && b[i] === 0xff; i += 2 + b.readUInt16BE(i + 2))
    if (b[i + 1] >= 0xc0 && b[i + 1] <= 0xcf && b[i + 1] !== 0xc4 && b[i + 1] !== 0xc8 && b[i + 1] !== 0xcc)
      return `${b.readUInt16BE(i + 7)}x${b.readUInt16BE(i + 5)}`;
  return null;
};

async function cmd(msg) {
  let res;
  try {
    res = await fetch(`${BASE}/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(msg),
    });
  } catch {
    fail('bridge server not running — start it: node cli.mjs start');
  }
  const out = await res.json().catch(() => null);
  if (!out) fail(`unexpected response from bridge on port ${PORT} — is another server using it?`);
  if (!out.ok) fail(out.error);
  return out.result;
}

async function stdin() {
  let s = '';
  for await (const c of process.stdin) s += c;
  return s.trim();
}

// POSIX-ish word split honoring 'single'/"double" quotes — including quotes
// glued onto bare words (a"b c" → `ab c`), like a shell. Two steps: split
// into maximal runs of bare/quoted parts, then strip the quotes per part.
const tokenize = (line) =>
  (line.match(/(?:[^\s'"]+|"[^"]*"|'[^']*')+/g) || []).map((t) => t.replace(/"([^"]*)"|'([^']*)'/g, (_, d, s) => d ?? s));

const USAGE = `chrome-bridge CLI — drive the user's real Chrome.

  batch                             read commands from stdin, one per line ('#' = comment,
                                    quotes honored) — one process for N commands; stops on first error
  tabs [match]                      list tabs (compact JSON); [match] filters by URL/title substring
  open <url>                        open + mark a new tab (waits for load, 8s cap)
  nav <match> <url> [--diff]        navigate matching tab (waits for load, 8s cap)
  close <match>                     close matching tab
  snap <match> [css] [--diff] [--href] [--find "nl"]
                                    a11y-tree snapshot with @eN refs (cheap — use before shot);
                                    [css] scopes to a subtree, --diff shows only changes since last snap,
                                    --href includes all link URLs (default: only nameless links);
                                    --find asks local Gemini Nano to pick the lines matching a
                                    natural-language query — a ~2s shortlist to VERIFY, not ground
                                    truth (~2/3 accurate in testing); lines prefixed '* ' are new
                                    since the previous snap; lines seen 3+ times collapse to
                                    '… N more · <line> → @refs'; trees truncate at 300 nodes —
                                    scope big pages with [css] or grep/--find can miss the rest
  click <match> <@ref|css> [--dbl] [--diff]  click an element (fails loudly if an overlay covers it);
                                    --dbl double-clicks (two click pairs + dblclick event)
  drag <match> <@ref|css> <@ref|css> [--diff]
                                    drag an element onto another (synthetic pointer sequence —
                                    apps that check isTrusted ignore it)
  dialog <match> accept|dismiss [--text s]
                                    dismiss a stuck JS dialog — an open alert/confirm/prompt
                                    wedges the tab until this or a human answers (--text answers a prompt)
  fill <match> <@ref|css> <value> [--diff]   set input value (React-safe; on a native <select>
                                    matches option value or label — error lists the options on a miss)
  type <match> <@ref|css> <text> [--diff]    per-char typing — triggers autocomplete/keystroke UIs
  press <match> <key> [@ref|css] [--diff]  key press on focused or given element (Enter/Tab/…);
                                    combos like Control+k / Shift+Enter / Meta+k set the modifier flags
  hover <match> <@ref|css> [--diff]  hover an element (opens hover menus)
  scroll <match> <up|down|top|bottom|@ref|css> [--diff]
                                    scroll the page (or an element into view); --diff
                                    shows what lazy-loaded in
                                    [--diff] on an action: settle (100ms DOM quiet, 3s cap), then
                                    append the snap-diff to the result — act + observe in one call
  upload <match> <@ref|css> <file...> [--diff]
                                    set a file input's files (CDP — works on hidden
                                    inputs; target the input or an element wrapping it)
  ask <match> <question>            (experimental) answer from page text with Chrome's
                                    built-in Gemini Nano — local, no cloud tokens
  wait <match> <css|--text t> [--timeout ms]   (timeout default 10s, max 60s)
  eval <match> <js|-> [--world main|isolated]     '-' reads JS from stdin
  shot <match> <out> [--max px] [--scale N] [--format png|jpeg] [--quality N] [--crop x,y,w,h] [--full]
                                    --max caps the long edge (default 1280, 0 = native res)
  net <match> [--dur ms] [--filter s] [--body s]
                                    capture network for N ms, capped at 30s (CDP, one line per request);
                                    --body s also captures JSON/text response bodies for URLs
                                    containing s (≤8, 1500 chars each; implies --filter s)
  measure <match> <css>             rect + computed styles as JSON
  console <match> [--clear] [--ask [question]]
                                    page console + errors (hook installs on first call);
                                    --ask triages the log with local Gemini Nano — only
                                    the verdict costs cloud tokens, not the noise
  grid <match>                      toggle 8px alignment grid
  mark|release <match>              add/remove driven-tab markers
  note <match> <text>              narrate to the human — shows in the driven tab's pill + history
                                    (use sparingly: before a risky/long sequence, or to explain why)
  watch                            live feed of every bridge command — the terminal twin of the pill;
                                    for the human watching you, not for you (Ctrl-C to exit)
  swlogs                            service-worker console tail (errors/warnings)
  emulate <match> <w> <h> [mobile]  CDP device view (no window resize)
  unemulate <match>                 clear emulation + detach debugger
  resize <match> <w> <h>            resize the window
  health                            server + extension status
  start                             start the server (detached) if it's down
  stop                              stop the server

<match> is a substring of the tab URL; a driven tab wins, then the most recently
active. Ambiguous matches print a warning naming the other tabs — re-run with a
longer match. Mutating commands (click/fill/type/press/upload/eval/hover/scroll/
grid/emulate/resize/drag/dialog) auto-mark the tab (🟣 pill + tab group).
Refs (@eN) come from snap; they survive re-snaps but expire on navigation.`;

async function run(cmdName, args) {
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
        // A loaded-but-stale extension still passes health (the SW seat is old
        // code — README's upgrade trap). Its self-reported version rides the
        // WS handshake; compare it with the manifest on disk and say so.
        if (h.extension && h.extVersion) {
          let mine = null;
          try {
            mine = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./extension/manifest.json', import.meta.url)), 'utf8')).version;
          } catch {}
          if (mine && mine !== h.extVersion)
            console.error(`⚠ extension ${h.extVersion} is loaded, the repo has ${mine} — reload the extension at chrome://extensions`);
        }
      } catch {
        fail('bridge server not running — start it: node cli.mjs start');
      }
      break;
    }

    case 'start': {
      // Self-heal: an agent whose health check failed can bring the server up
      // itself instead of asking the user (the extension still needs a human
      // click at chrome://extensions — nothing here can do that).
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) {
          print('already running');
          break;
        }
      } catch {}
      const logPath = fileURLToPath(new URL('./server.log', import.meta.url));
      // (size cap lives in server.mjs — it runs on every start path, not just this one)
      const log = fs.openSync(logPath, 'a');
      const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
        detached: true,
        stdio: ['ignore', log, log],
      });
      child.unref();
      let up = false;
      for (let i = 0; i < 20 && !up; i++) {
        await new Promise((r) => setTimeout(r, 250));
        up = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
      }
      if (!up) fail('server did not come up in 5s — check ' + logPath);
      print('started (log: ' + logPath + ') — a loaded extension reconnects on its own');
      break;
    }

    case 'stop': {
      const res = await fetch(`${BASE}/stop`, { method: 'POST' }).catch(() => null);
      if (!res?.ok) fail('bridge server not running');
      print('stopped');
      break;
    }

    case 'tabs': {
      // Optional substring filter — a real browser's full tab list is ~2KB of
      // titles the agent usually doesn't need; `tabs <match>` returns the rows
      // it's actually looking for.
      const t = await cmd({ type: 'tabs' });
      const m = args[0];
      print(m ? t.filter((x) => x.url.includes(m) || (x.title || '').includes(m)) : t);
      break;
    }

    case 'swlogs':
      print((await cmd({ type: 'swlogs' })).join('\n') || '(no errors or warnings logged)');
      break;

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
        const [c, ...a] = tokenize(line);
        await run(c, a);
      }
      break;
    }

    case 'open':
      if (!args[0]) fail('usage: open <url>');
      print(await cmd({ type: 'open', url: args[0] }));
      break;

    case 'nav':
    case 'navigate': {
      const rest = args.filter((a) => a !== '--diff');
      if (!rest[0] || !rest[1]) fail('usage: nav <match> <url> [--diff]');
      print(await cmd({ type: 'navigate', urlMatch: rest[0], url: rest[1], ...(args.includes('--diff') ? { diff: true } : {}) }));
      break;
    }

    case 'close':
    case 'mark':
    case 'release':
    case 'unemulate':
      if (!args[0]) fail(`usage: ${cmdName} <match>`);
      print(await cmd({ type: cmdName, urlMatch: args[0] }));
      break;

    case 'snap': {
      if (!args[0]) fail('usage: snap <match> [css] [--diff] [--href] [--find "nl query"]');
      const diff = args.includes('--diff');
      const href = args.includes('--href');
      const fi = args.indexOf('--find');
      let find = null;
      if (fi >= 0) {
        // Greedy: everything after --find that isn't a flag is the query. A
        // one-token reader turned `--find cancel button` into find='cancel' +
        // scope='button' — silent wrong data on the most paraphrasable flag.
        find = args.slice(fi + 1).filter((a) => !a.startsWith('--')).join(' ');
        if (!find) fail('--find needs a query');
      }
      // scope = the first bare positional BEFORE --find (a scope can never
      // follow a --find query — everything there is the query)
      const scope = args.slice(1, fi < 1 ? args.length : fi).find((a) => !a.startsWith('--')) || null;
      const out = await cmd({ type: 'snap', urlMatch: args[0], scope, diff, href, ...(find ? { find } : {}) });
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
      const rest = args.filter((a) => a !== '--diff' && a !== '--dbl');
      if (!rest[0] || !rest[1]) fail(`usage: ${cmdName} <match> <@ref|css>${cmdName === 'click' ? ' [--dbl]' : ''} [--diff]`);
      const stray = rest.slice(2).find((a) => a.startsWith('--'));
      if (stray) fail(`unknown flag ${stray} (flags:${cmdName === 'click' ? ' --dbl,' : ''} --diff)`);
      print(await cmd({
        type: cmdName,
        urlMatch: rest[0],
        target: rest[1],
        ...(cmdName === 'click' && args.includes('--dbl') ? { dbl: true } : {}),
        ...(args.includes('--diff') ? { diff: true } : {}),
      }));
      break;
    }

    case 'drag': {
      const rest = args.filter((a) => a !== '--diff');
      if (!rest[0] || !rest[1] || !rest[2]) fail('usage: drag <match> <@ref|css> <@ref|css> [--diff]');
      const stray = rest.slice(3).find((a) => a.startsWith('--'));
      if (stray) fail(`unknown flag ${stray} (flags: --diff)`);
      print(await cmd({ type: 'drag', urlMatch: rest[0], from: rest[1], to: rest[2], ...(args.includes('--diff') ? { diff: true } : {}) }));
      break;
    }

    case 'dialog': {
      if (!args[0] || !['accept', 'dismiss'].includes(args[1])) fail('usage: dialog <match> accept|dismiss [--text s]');
      const ti = args.indexOf('--text');
      const text = ti >= 0 ? args.slice(ti + 1).filter((a) => !a.startsWith('--')).join(' ') : null;
      print(await cmd({ type: 'dialog', urlMatch: args[0], accept: args[1] === 'accept', ...(text ? { text } : {}) }));
      break;
    }

    case 'fill':
    case 'type': {
      const rest = args.filter((a) => a !== '--diff');
      if (!rest[0] || !rest[1] || rest[2] === undefined) fail(`usage: ${cmdName} <match> <@ref|css> <value> [--diff]`);
      // A '--'-prefixed token in the value is a fat-fingered flag, not data —
      // without this guard it gets typed into the user's real form field.
      const stray = rest.slice(2).find((a) => a.startsWith('--'));
      if (stray) fail(`unknown flag ${stray} (flags: --diff)`);
      print(await cmd({ type: cmdName, urlMatch: rest[0], target: rest[1], value: rest.slice(2).join(' '), ...(args.includes('--diff') ? { diff: true } : {}) }));
      break;
    }

    case 'press': {
      const rest = args.filter((a) => a !== '--diff');
      if (!rest[0] || !rest[1]) fail('usage: press <match> <key> [@ref|css] [--diff]');
      const stray = rest.slice(3).find((a) => a.startsWith('--'));
      if (stray) fail(`unknown flag ${stray} (flags: --diff)`);
      print(await cmd({ type: 'press', urlMatch: rest[0], key: rest[1], target: rest[2] || null, ...(args.includes('--diff') ? { diff: true } : {}) }));
      break;
    }

    case 'scroll': {
      const rest = args.filter((a) => a !== '--diff');
      if (!rest[0] || !rest[1]) fail('usage: scroll <match> <up|down|top|bottom|@ref|css> [--diff]');
      const stray = rest.slice(2).find((a) => a.startsWith('--'));
      if (stray) fail(`unknown flag ${stray} (flags: --diff)`);
      print(await cmd({ type: 'scroll', urlMatch: rest[0], target: rest[1], ...(args.includes('--diff') ? { diff: true } : {}) }));
      break;
    }

    case 'upload': {
      const rest = args.filter((a) => a !== '--diff');
      if (!rest[0] || !rest[1] || !rest[2]) fail('usage: upload <match> <@ref|css> <file...> [--diff]');
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
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--dur') {
          duration = Number(rest[++i]);
          if (!Number.isFinite(duration) || duration < 0) fail('--dur needs a number (ms)');
          // The extension silently clamps at 30s — fail here instead so the
          // agent doesn't read "no requests" for a window it believes it watched.
          if (duration > 30000) fail('--dur max is 30000 ms — run successive captures for longer windows');
        } else if (rest[i] === '--filter') filter = rest[++i];
        else if (rest[i] === '--body') body = rest[++i];
        else fail(`unknown flag ${rest[i]}`);
      }
      if (!match) fail('usage: net <match> [--dur ms] [--filter s] [--body s]');
      if (body && !filter) filter = body; // --body implies you only want those lines
      print(await cmd({ type: 'net', urlMatch: match, duration, filter, body }));
      break;
    }

    case 'wait': {
      const [match, ...rest] = args;
      let text = null;
      let timeout = 10000;
      const pos = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--text') text = rest[++i];
        else if (rest[i] === '--timeout') timeout = Number(rest[++i]);
        else if (rest[i].startsWith('--')) fail(`unknown flag ${rest[i]} (flags: --text, --timeout)`);
        else pos.push(rest[i]);
      }
      const selector = pos[0] || null;
      if (!match || (!selector && !text)) fail('usage: wait <match> [css|--text t] [--timeout ms]');
      // Above 60s the server's 70s command cap fires first and the caller gets
      // a misleading 'extension timeout' for a healthy wait — fail here instead.
      if (!Number.isFinite(timeout) || timeout < 1 || timeout > 60000) fail('--timeout must be 1..60000 ms (the server kills commands at 70s)');
      print(await cmd({ type: 'wait', urlMatch: match, selector, text, timeout }));
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
      print(await cmd({ type: 'eval', urlMatch: match, code, world }));
      break;
    }

    case 'shot': {
      const [match, out, ...rest] = args;
      if (!match || !out) fail('usage: shot <match> <out> [--max px] [--scale N] [--format png|jpeg] [--quality N] [--crop x,y,w,h] [--full]');
      const msg = { type: 'shot', urlMatch: match };
      for (let i = 0; i < rest.length; i++) {
        const k = rest[i];
        if (k === '--full') { msg.full = true; continue; }
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
      for (const k of ['max', 'scale', 'quality']) if (msg[k] !== undefined && !Number.isFinite(msg[k])) fail(`flag --${k} needs a number`);
      // Ranges, mirroring emulate/wait/net: out-of-range values used to pass
      // and silently degrade to a different screenshot on the CDP fallback path.
      if (msg.max !== undefined && msg.max < 0) fail('--max must be >= 0 (0 = native res)');
      if (msg.scale !== undefined && msg.scale <= 0) fail('--scale must be > 0');
      if (msg.quality !== undefined && (msg.quality < 1 || msg.quality > 100)) fail('--quality must be 1..100');
      if (msg.format && !['png', 'jpeg'].includes(msg.format)) fail('--format must be png|jpeg');
      if (msg.crop && (msg.crop.length !== 4 || msg.crop.some((n) => !Number.isFinite(n)))) fail('--crop needs 4 numbers: x,y,w,h');
      if (msg.crop && (msg.crop[0] < 0 || msg.crop[1] < 0 || msg.crop[2] < 1 || msg.crop[3] < 1)) fail('--crop needs x,y >= 0 and w,h >= 1');
      const dataUrl = await cmd(msg);
      const b64 = dataUrl.includes(',') ? dataUrl.split(',', 2)[1] : dataUrl;
      const buf = Buffer.from(b64, 'base64');
      fs.writeFileSync(out, buf);
      const d = imgDims(buf);
      console.log(`saved ${out} (${Math.round(buf.length / 1024)} KB${d ? `, ${d}` : ''})`);
      break;
    }

    case 'measure':
      if (!args[0] || !args[1]) fail('usage: measure <match> <css>');
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
      print(await cmd({ type: 'console', urlMatch: args[0], clear: args.includes('--clear'), ...(ask ? { ask } : {}) }));
      break;
    }

    case 'grid':
      if (!args[0]) fail('usage: grid <match>');
      print(await cmd({ type: 'grid', urlMatch: args[0] }));
      break;

    case 'emulate':
    case 'resize': {
      if (!args[0] || !args[1] || !args[2]) fail(`usage: ${cmdName} <match> <w> <h>${cmdName === 'emulate' ? ' [mobile]' : ''}`);
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
