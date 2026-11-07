// chrome-bridge command grammar: the registry of every CLI command, the
// command-line tokenizer, and parse/render for browser commands. It is shared
// by every surface that speaks the CLI syntax: cli.mjs today, the extension's
// cloud link next.
// Pure: no fs, process, network, stdin or printing, and no eval/new Function
// (the extension's CSP forbids them). The caller does all I/O; errors are
// thrown as plain Error(<user-facing text>).
//
// Format: a classic script that publishes globalThis.BridgeCommands, so the
// service worker can stay classic and load it with importScripts. Node loads it
// as a side-effect import: package.json "type": "module" makes it ESM there,
// which a script with no import/export already is. The IIFE keeps its names
// out of the worker's shared global scope.
(() => {
  'use strict';

  const fail = (msg) => {
    throw new Error(msg);
  };

  // One entry per cli.mjs USAGE command; the selftest pins names and usage
  // lines to USAGE.
  //   group        settings-matrix section
  //   scope        'browser' = runs in Chrome, any link may send it;
  //                'local-only' = manages this machine's bridge (CLI only)
  //   readOnly     changes nothing beyond the bridge's own marking (pill, tab group)
  //   destructive  removes or overwrites existing state by design (tabs, field
  //                values, arbitrary page code); a click that hits a delete
  //                button is the target's doing, not the verb's
  //   diskBound    false, or the part that reads/writes the local disk or OS clipboard
  //   pageCode     false, or the argument that carries caller JavaScript run in
  //                the page: eval-equivalent for any policy (never readOnly)
  const GROUPS = Object.freeze(['Observe', 'Act', 'Navigate', 'Network & data', 'Page code', 'Hand-off', 'Housekeeping', 'Local admin']);
  const entry = (name, group, scope, usage, more = {}) =>
    Object.freeze({
      name,
      aliases: Object.freeze(more.aliases || []),
      usage,
      group,
      scope,
      readOnly: !!more.readOnly,
      destructive: !!more.destructive,
      diskBound: more.diskBound || false,
      pageCode: more.pageCode || false,
    });
  const B = 'browser';
  const L = 'local-only';
  const RO = { readOnly: true };
  const REGISTRY = Object.freeze([
    entry('batch', 'Local admin', L, 'batch'),
    entry('tabs', 'Observe', B, 'tabs [match]', RO),
    entry('profiles', 'Local admin', L, 'profiles', RO),
    entry('doctor', 'Housekeeping', B, 'doctor [--fix]'),
    entry('open', 'Navigate', B, 'open <url>'),
    entry('nav', 'Navigate', B, 'nav <match> <url> [--diff]', { aliases: ['navigate'] }),
    entry('close', 'Navigate', B, 'close <match> [--all]', { destructive: true }),
    entry('snap', 'Observe', B, 'snap <match> [css|@ref] [--diff] [--href] [--skeleton] [--no-fold] [--find "nl"]', RO),
    entry('click', 'Act', B, 'click <match> <@ref|css> [--dbl] [--diff] [--trusted]'),
    entry('drag', 'Act', B, 'drag <match> <@ref|css> <@ref|css> [--diff] [--trusted]'),
    entry('dialog', 'Act', B, 'dialog <match> accept|dismiss [--text s]'),
    entry('fill', 'Act', B, 'fill <match> <@ref|css> <value> [--diff]', { destructive: true }),
    entry('clear', 'Act', B, 'clear <match> <@ref|css> [--diff]', { destructive: true }),
    entry('type', 'Act', B, 'type <match> <@ref|css> <text> [--diff] [--trusted]'),
    entry('press', 'Act', B, 'press <match> <key> [@ref|css] [--diff] [--trusted]'),
    entry('hover', 'Act', B, 'hover <match> <@ref|css> [--diff] [--trusted]'),
    entry('paste', 'Act', B, 'paste <match> [@ref|css] [--diff] [--html] [-- <text>]', { diskBound: 'clipboard' }),
    entry('scroll', 'Navigate', B, 'scroll <match> <up|down|top|bottom|@ref|css> [--diff]'),
    entry('upload', 'Act', B, 'upload <match> <@ref|css> <file...> [--chooser] [--diff]', { diskBound: '<file...>' }),
    entry('ask', 'Observe', B, 'ask <match> <question>', RO),
    entry('wait', 'Hand-off', B, 'wait <match> <css|--text t|--js expr|--human|--pixel-change> [--timeout ms] [--world main|isolated]', { pageCode: '--js' }),
    entry('eval', 'Page code', B, 'eval <match> <js|-> [--world main|isolated]', { destructive: true, pageCode: '<js|->' }),
    entry('shot', 'Observe', B, 'shot <match> <out> [--max px] [--scale N] [--format png|jpeg] [--quality N] [--crop x,y,w,h] [--full] [--diff]', { readOnly: true, diskBound: '<out>' }),
    entry('net', 'Network & data', B, 'net <match> [--dur ms] [--filter s] [--body s] [--ws] [--har out.har]', { readOnly: true, diskBound: '--har' }),
    entry('fetch', 'Network & data', B, 'fetch <match> <url> [--out file] [--keep] [--header "k: v"]... [--csrf]', { diskBound: '--out' }),
    entry('perf', 'Observe', B, 'perf <match> [--dur ms]', RO),
    entry('measure', 'Observe', B, 'measure <match> <css|@ref>', RO),
    entry('console', 'Observe', B, 'console <match> [--clear] [--ask [question]]', RO),
    entry('grid', 'Observe', B, 'grid <match>'),
    entry('mark', 'Housekeeping', B, 'mark <match>'),
    entry('release', 'Housekeeping', B, 'release <match>'),
    entry('activate', 'Navigate', B, 'activate <match>'),
    entry('note', 'Hand-off', B, 'note <match> <text>', RO),
    entry('watch', 'Local admin', L, 'watch', RO),
    entry('history', 'Local admin', L, 'history [match] [-n N] [--batch out]', { readOnly: true, diskBound: '--batch' }),
    entry('swlogs', 'Local admin', L, 'swlogs', RO),
    entry('extreload', 'Local admin', L, 'extreload'),
    entry('emulate', 'Navigate', B, 'emulate <match> <w> <h> [mobile] [dsf=N]'),
    entry('unemulate', 'Navigate', B, 'unemulate <match>'),
    entry('resize', 'Navigate', B, 'resize <match> <w> <h>'),
    entry('health', 'Local admin', L, 'health', RO),
    entry('update', 'Local admin', L, 'update [--check]'),
    entry('start', 'Local admin', L, 'start'),
    entry('stop', 'Local admin', L, 'stop'),
  ]);
  const BY_WORD = new Map();
  for (const e of REGISTRY) for (const w of [e.name, ...e.aliases]) BY_WORD.set(w, e);
  const lookup = (word) => BY_WORD.get(word) || null;

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

  // One command line → { profile, argv }: the batch-line grammar. A leading
  // --profile <id|name> routes the line (history --batch emits one per
  // recorded command; without this the token reads as a command name).
  // eval's payload is CODE, not shell words: tokenize() strips quotes that are
  // JS syntax ("button" → button → ReferenceError, #42). eval lines parse off
  // the RAW text: the <match> (bare or one quoted token), then the payload
  // rides verbatim — unless it's exactly one quoted token with an optional
  // trailing '--world w' (the shape history --batch emits via shellq), which
  // is unquoted once so a replay round-trips the original code.
  function splitLine(line) {
    let profile = null;
    if (/^(?:--profile\s+\S+\s+)?eval(\s|$)/.test(line)) {
      let rest = line;
      const prof = rest.match(/^--profile\s+(\S+)\s+/);
      if (prof) {
        if (prof[1].startsWith('--')) fail('--profile needs an id or name (see: cli.mjs profiles)');
        profile = prof[1];
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
      if (qm) return { profile, argv: qm[3] ? ['eval', match, unq(qm[1]), '--world', qm[3]] : ['eval', match, unq(qm[1])] };
      return { profile, argv: ['eval', match, rest] };
    }
    const tokens = tokenize(line);
    if (tokens[0] === '--profile') {
      if (!tokens[1] || tokens[1].startsWith('--')) fail('--profile needs an id or name (see: cli.mjs profiles)');
      profile = tokens[1];
      tokens.splice(0, 2);
    }
    return { profile, argv: tokens };
  }

  // Flag-strip + stray-flag scan shared by the flat-positional commands — the
  // hand-copied skeletons had already drifted once (a '--dfif' typo nearly got
  // typed into a real form). `known` flags are removed; the first remaining
  // '--x' at/after the positional slots fails loud instead of becoming data.
  function takeFlags(args, known, minPos, usage, maxPos = minPos) {
    const rest = args.filter((a) => !known.includes(a));
    if (rest.length < minPos) fail(`usage: ${usage}`);
    const stray = rest.slice(minPos).find((a) => a.startsWith('--'));
    if (stray) fail(`unknown flag ${stray} (flags: ${known.join(', ')})`);
    // Extra positionals used to be silently DROPPED — `click <m> "#list" @e3`
    // clicked #list and the ref vanished (#59). Acting on the wrong element is
    // the worst case; fail loud instead.
    if (rest.length > maxPos) fail(`unexpected extra argument '${rest[maxPos]}' — usage: ${usage}`);
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

  // argv ([command, ...args]) → { name, msg, view }: msg is the wire message,
  // view holds what only render() needs (it never goes on the wire).
  // New flags parsed here must also land in server.mjs CLI_LINES — history
  // --batch rebuilds replay lines there, and an unmirrored flag is silently
  // dropped at replay.
  function parse(argv) {
    const [word, ...args] = argv;
    const e = lookup(word);
    if (!e) fail(`unknown command: ${word}`);
    const cmdName = e.name;
    const out = (msg, view = {}) => ({ name: cmdName, msg, view });
    switch (cmdName) {
      case 'tabs':
        // Optional substring filter — a real browser's full tab list is ~2KB of
        // titles the agent usually doesn't need; `tabs <match>` returns the rows
        // it's actually looking for.
        if (args.length > 1 || args[0]?.startsWith('--')) fail('usage: tabs [match] — a URL/title substring, or the exact id:<tabId>');
        return out({ type: 'tabs' }, { match: args[0] });

      case 'doctor': {
        const rest = takeFlags(args, ['--fix'], 0, 'doctor [--fix]');
        if (rest.length) fail('usage: doctor [--fix]');
        return out({ type: 'doctor', fix: args.includes('--fix') });
      }

      case 'note':
        if (args.length < 2) fail('usage: note <match> <text>');
        return out({ type: 'note', urlMatch: args[0], text: args.slice(1).join(' ') });

      case 'open':
        if (args.length !== 1) fail('usage: open <url>'); // extras fail loud like every other command — 'open a b' silently dropped b
        return out({ type: 'open', url: args[0] });

      case 'nav': {
        // Match/action commands fail locally on a typoed flag. Silently
        // ignoring --dfif here is worse than a normal usage error: an agent can
        // reasonably believe its requested observation mode ran on a real tab.
        const rest = takeFlags(args, ['--diff'], 2, 'nav <match> <url> [--diff]');
        if (rest.length !== 2) fail('usage: nav <match> <url> [--diff]');
        return out({ type: 'navigate', urlMatch: rest[0], url: rest[1], ...(args.includes('--diff') ? { diff: true } : {}) });
      }

      case 'close': {
        const rest = takeFlags(args, ['--all'], 1, 'close <match> [--all]');
        return out({ type: 'close', urlMatch: rest[0], ...(args.includes('--all') ? { all: true } : {}) });
      }

      case 'mark':
      case 'release':
      case 'unemulate':
      case 'activate':
        if (args.length !== 1) fail(`usage: ${cmdName} <match>`); // one arg, exactly — extras used to vanish silently
        return out({ type: cmdName, urlMatch: args[0] });

      case 'snap': {
        if (!args[0]) fail('usage: snap <match> [css|@ref] [--diff] [--href] [--skeleton] [--no-fold] [--find "nl query"]');
        const SNAP_FLAGS = ['--diff', '--href', '--skeleton', '--no-fold'];
        const diff = args.includes('--diff');
        const href = args.includes('--href');
        const skeleton = args.includes('--skeleton');
        // --no-fold: keep every line inline (#67) — the "… N more" summaries
        // move folded refs to the end, out of document order, so a scripted
        // 'snap | grep <line> | tail -1' picked the wrong row.
        const nofold = args.includes('--no-fold');
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
        if (stray) fail(`unknown flag ${stray} (flags: --diff, --href, --skeleton, --no-fold, --find "query")`);
        return out({ type: 'snap', urlMatch: args[0], scope, diff, href, ...(skeleton ? { skeleton: true } : {}), ...(nofold ? { nofold: true } : {}), ...(find ? { find } : {}) });
      }

      // --diff on an action appends a settle + snap-diff to the result — the
      // post-action observation rides along instead of costing two more
      // shell calls (click → wait → snap --diff becomes one command).
      case 'click':
      case 'hover': {
        const rest = takeFlags(args, cmdName === 'click' ? ['--diff', '--dbl', '--trusted'] : ['--diff', '--trusted'], 2, `${cmdName} <match> <@ref|css>${cmdName === 'click' ? ' [--dbl]' : ''} [--diff] [--trusted]`);
        return out({
          type: cmdName,
          urlMatch: rest[0],
          target: rest[1],
          ...(cmdName === 'click' && args.includes('--dbl') ? { dbl: true } : {}),
          ...(args.includes('--diff') ? { diff: true } : {}),
          ...(args.includes('--trusted') ? { trusted: true } : {}),
        });
      }

      case 'drag': {
        const rest = takeFlags(args, ['--diff', '--trusted'], 3, 'drag <match> <@ref|css> <@ref|css> [--diff] [--trusted]');
        return out({ type: 'drag', urlMatch: rest[0], from: rest[1], to: rest[2], ...(args.includes('--diff') ? { diff: true } : {}), ...(args.includes('--trusted') ? { trusted: true } : {}) });
      }

      case 'clear': {
        const rest = takeFlags(args, ['--diff'], 2, 'clear <match> <@ref|css> [--diff]');
        return out({ type: 'clear', urlMatch: rest[0], target: rest[1], ...(args.includes('--diff') ? { diff: true } : {}) });
      }

      case 'dialog': {
        if (!args[0] || !['accept', 'dismiss'].includes(args[1])) fail('usage: dialog <match> accept|dismiss [--text s]');
        const rest = args.slice(2);
        if (rest.length && rest[0] !== '--text') fail('usage: dialog <match> accept|dismiss [--text s]');
        const text = rest.length ? rest.slice(1).join(' ') : null;
        if (rest.length && !text) fail('--text needs an answer');
        return out({ type: 'dialog', urlMatch: args[0], accept: args[1] === 'accept', ...(text ? { text } : {}) });
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
        return out({
          type: cmdName,
          urlMatch: rest[0],
          target: rest[1],
          value,
          ...(flagged.includes('--diff') ? { diff: true } : {}),
          ...(cmdName === 'type' && flagged.includes('--trusted') ? { trusted: true } : {}),
        });
      }

      case 'press': {
        // takeFlags scans from slot 2: a stray '--x' there used to slip through
        // as the optional target (the hand-copied scan started one slot late).
        const rest = takeFlags(args, ['--diff', '--trusted'], 2, 'press <match> <key> [@ref|css] [--diff] [--trusted]', 3);
        // `press <match> @eN Enter` — the act-by-ref order every other verb
        // uses (and the skill's core loop shows) — read the key as a selector
        // and failed 'element not found: Enter'. No key looks like a ref.
        if (/^@e\d+$/.test(rest[1] || '') && rest[2]) [rest[1], rest[2]] = [rest[2], rest[1]];
        return out({ type: 'press', urlMatch: rest[0], key: rest[1], target: rest[2] || null, ...(args.includes('--diff') ? { diff: true } : {}), ...(args.includes('--trusted') ? { trusted: true } : {}) });
      }

      case 'scroll': {
        const rest = takeFlags(args, ['--diff'], 2, 'scroll <match> <up|down|top|bottom|@ref|css> [--diff]');
        return out({ type: 'scroll', urlMatch: rest[0], target: rest[1], ...(args.includes('--diff') ? { diff: true } : {}) });
      }

      case 'ask':
        if (!args[0] || args.length < 2) fail('usage: ask <match> <question>');
        return out({ type: 'ask', urlMatch: args[0], question: args.slice(1).join(' ') });

      case 'perf': {
        const [match, ...rest] = args;
        let duration = null;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '--dur') {
            duration = Number(rest[++i]);
            if (!Number.isFinite(duration) || duration <= 0) fail('--dur needs a positive number (ms)');
            if (duration > 30000) fail('--dur max is 30000 ms');
          } else fail(`unknown flag ${rest[i]}`);
        }
        if (!match) fail('usage: perf <match> [--dur ms]');
        return out({ type: 'perf', urlMatch: match, duration });
      }

      case 'measure':
        if (args.length !== 2) fail('usage: measure <match> <css|@ref>');
        return out({ type: 'measure', urlMatch: args[0], selector: args[1] });

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
        return out({ type: 'console', urlMatch: args[0], clear: args.includes('--clear'), ...(ask ? { ask } : {}) });
      }

      case 'grid':
        if (args.length !== 1) fail('usage: grid <match>');
        return out({ type: 'grid', urlMatch: args[0] });

      case 'emulate':
      case 'resize': {
        // emulate focus: the page believes it's focused — focus-GATED work
        // keeps running in a background tab (spike, #18).
        if (cmdName === 'emulate' && args[1] === 'focus') {
          if (!args[0] || args.length !== 2) fail('usage: emulate <match> focus');
          return out({ type: 'emulate', urlMatch: args[0], focus: true });
        }
        const usage = `usage: ${cmdName} <match> <w> <h>${cmdName === 'emulate' ? ' [mobile] [dsf=N] | emulate <match> focus' : ''}`;
        const mods = args.slice(3);
        if (!args[0] || !args[1] || !args[2]) fail(usage);
        if ((cmdName === 'resize' && mods.length) || mods.some((m) => m !== 'mobile' && !m.startsWith('dsf=')) || new Set(mods.map((m) => m.split('=')[0])).size !== mods.length) fail(usage);
        const w = Number(args[1]);
        const h = Number(args[2]);
        if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) fail(`${cmdName} needs numeric <w> <h>`);
        // dsf=N pins the device scale factor (retina captures without a retina
        // window); mobile alone implies dsf 2 extension-side.
        const dsfArg = mods.find((m) => m.startsWith('dsf='));
        const dsf = dsfArg ? Number(dsfArg.slice(4)) : undefined;
        if (dsf !== undefined && (!Number.isFinite(dsf) || dsf < 0.1 || dsf > 4)) fail('emulate dsf must be 0.1–4');
        return out({ type: cmdName, urlMatch: args[0], width: w, height: h, ...(cmdName === 'emulate' ? { mobile: mods.includes('mobile'), ...(dsf !== undefined ? { dsf } : {}) } : {}) });
      }
    }
    if (e.scope === 'local-only') fail(`${cmdName} is local-only — it manages the bridge on the user's machine: node cli.mjs ${cmdName}`);
    fail(`no parser for ${cmdName}`);
  }

  const fmt = (v) => (typeof v === 'string' ? v : JSON.stringify(v) ?? String(v));

  // (parsed, result) → { text, warnings }: text is the command's output,
  // warnings are lines worth surfacing beside it (the CLI echoes them to
  // stderr, which survives a `| grep` on stdout). Throws when the result
  // itself is the failure.
  function render({ name, view = {} }, result) {
    const warnings = [];
    switch (name) {
      case 'tabs': {
        // id:<tabId> is the exact reference every tab command takes — its own
        // help text says so, and returning [] for a live tab read as "the tab
        // is gone, re-copy/re-open" (the extension's tabMatches has the branch).
        const m = view.match;
        if (m) result = /^id:\d+$/.test(m) ? result.filter((x) => String(x.id) === m.slice(3)) : result.filter((x) => (x.url || '').includes(m) || (x.title || '').includes(m)); // url can be absent (unresponsive-profile row)
        break;
      }
      case 'doctor':
        // Driven tabs are live work (maybe another session's), not residue — `tabs` shows them.
        result = result.filter((r) => !r.driven);
        break;
      case 'snap': {
        // Empty tree right after `open` printed NOTHING with exit 0 — a script
        // read that as "empty page" when the truth was "still loading" (#60).
        if (typeof result === 'string' && !result.trim())
          fail('empty tree — the page is likely still loading (or has no interactive elements). Retry shortly, or: wait <match> --text <something>');
        // The truncation line sits at the end of the tree — a `snap | grep foo`
        // pipe filters it out and the agent concludes "not found" when the truth
        // is "not reached".
        const ti = typeof result === 'string' ? result.lastIndexOf('… truncated at') : -1;
        if (ti >= 0) warnings.push(result.slice(ti).split('\n')[0]);
        // Same for a modal layer the extension appended past the cut: a page-
        // blocking dialog must survive the pipe too (header + the layer's line).
        const li = typeof result === 'string' ? result.indexOf('(modal layer past the cut') : -1;
        if (li >= 0) warnings.push(result.slice(li).split('\n').slice(0, 2).join('\n'));
        break;
      }
    }
    return { text: fmt(result), warnings };
  }

  // Warnings that ride the reply envelope itself, in print order: server
  // hygiene (stale extension code, version drift — #63), then page errors new
  // since the previous command (page text: control chars stripped).
  function replyWarnings(reply) {
    const lines = [];
    if (Array.isArray(reply?.warn)) for (const w of reply.warn) lines.push('⚠ ' + w);
    const pe = reply?.pageErrors;
    if (pe && Number(pe.count) > 0 && Array.isArray(pe.lines)) {
      const n = Number(pe.count);
      lines.push(`⚠ ${n} new page error${n === 1 ? '' : 's'} since the last command${n > pe.lines.length ? ` (newest ${pe.lines.length})` : ''} — console <match> shows the log:`);
      for (const l of pe.lines) lines.push('  ' + String(l).replace(/[\x00-\x1f\x7f\x9b]/g, ' '));
    }
    return lines;
  }

  globalThis.BridgeCommands = Object.freeze({ GROUPS, REGISTRY, lookup, tokenize, splitLine, splitDashDash, parse, render, replyWarnings });
})();
