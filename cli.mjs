#!/usr/bin/env node
// chrome-bridge CLI — zero dependencies, Node >= 18.
// Run without arguments for usage.
import fs from 'node:fs';

const PORT = process.env.BRIDGE_PORT || 9333;
const BASE = `http://127.0.0.1:${PORT}`;

const fail = (msg) => {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
};
const print = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v));

// Image dimensions from the buffer header (PNG IHDR / JPEG SOF) — agents map
// shot pixels back to CSS px, and --max rescales server-side, so print them.
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
    fail('bridge server not running — start it: node server.mjs');
  }
  const out = await res.json();
  if (!out.ok) fail(out.error);
  return out.result;
}

async function stdin() {
  let s = '';
  for await (const c of process.stdin) s += c;
  return s.trim();
}

// POSIX-ish word split honoring 'single'/"double" quotes (quote whole args).
const tokenize = (line) => {
  const out = [];
  line.replace(/'([^']*)'|"([^"]*)"|(\S+)/g, (_, s, d, w) => out.push(s ?? d ?? w));
  return out;
};

// Page-side helpers (eval-based).
const measureSrc = (sel) =>
  `JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>{const r=e.getBoundingClientRect();const c=getComputedStyle(e);return{text:(e.textContent||'').trim().slice(0,30),x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),display:c.display,alignItems:c.alignItems,justifyContent:c.justifyContent,textAlign:c.textAlign,gap:c.gap,padding:c.padding,radius:c.borderRadius,bg:c.backgroundColor,color:c.color,font:c.fontSize+'/'+c.fontWeight}}))`;
const GRID_SRC = `(()=>{const g=document.getElementById('bridge-grid');if(g){g.remove();return 'grid off'}const d=document.createElement('div');d.id='bridge-grid';d.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none;background-image:repeating-linear-gradient(0deg,rgba(255,0,0,.25) 0 1px,transparent 1px 8px),repeating-linear-gradient(90deg,rgba(255,0,0,.25) 0 1px,transparent 1px 8px)';document.body.appendChild(d);return 'grid on'})()`;

const USAGE = `chrome-bridge CLI — drive the user's real Chrome.

  batch                             read commands from stdin, one per line ('#' = comment,
                                    quotes honored) — one process for N commands; stops on first error
  tabs                              list tabs (compact JSON)
  open <url>                        open + mark a new tab
  nav <match> <url>                 navigate matching tab
  close <match>                     close matching tab
  snap <match> [css] [--diff] [--href]   a11y-tree snapshot with @eN refs (cheap — use before shot);
                                    [css] scopes to a subtree, --diff shows only changes since last snap,
                                    --href includes all link URLs (default: only nameless links)
  click <match> <@ref|css>          click an element (fails loudly if an overlay covers it)
  fill <match> <@ref|css> <value>   set input value (React-safe)
  type <match> <@ref|css> <text>    per-char typing — triggers autocomplete/keystroke UIs
  press <match> <key> [@ref|css]    key press (Enter/Tab/Escape/…) on focused or given element
  hover <match> <@ref|css>          hover an element (opens hover menus)
  wait <match> [css|--text t] [--timeout ms]
  eval <match> <js|-> [--world main|isolated]     '-' reads JS from stdin
  shot <match> <out> [--max px] [--scale N] [--format png|jpeg] [--quality N] [--crop x,y,w,h] [--full]
                                    --max caps the long edge (default 1280, 0 = native res)
  net <match> [--dur ms] [--filter s]   capture network for N ms (CDP, one line per request)
  measure <match> <css>             rect + computed styles as JSON
  console <match> [--clear]         page console + errors (hook installs on first call)
  grid <match>                      toggle 8px alignment grid
  mark|release <match>              add/remove driven-tab markers
  swlogs                            service-worker console tail (errors/warnings)
  emulate <match> <w> <h> [mobile]  CDP device view (no window resize)
  unemulate <match>                 clear emulation + detach debugger
  resize <match> <w> <h>            resize the window
  health                            server + extension status

<match> is a substring of the tab URL; the most recently active match wins.
Refs (@eN) come from snap; they survive re-snaps but expire on navigation.`;

async function run(cmdName, args) {
  switch (cmdName) {
    case undefined:
    case 'help':
      console.log(USAGE);
      break;

    case 'health': {
      try {
        const res = await fetch(`${BASE}/health`);
        print(await res.json());
      } catch {
        fail('bridge server not running — start it: node server.mjs');
      }
      break;
    }

    case 'tabs':
      print(await cmd({ type: 'tabs' }));
      break;

    case 'swlogs':
      print((await cmd({ type: 'swlogs' })).join('\n') || '(no errors or warnings logged)');
      break;

    case 'batch': {
      // One node process for N commands — CLI startup (~60ms) is the biggest
      // per-command cost on this side of the WS, and one shell call for the
      // whole sequence saves the agent N-1 tool round trips. Stops on the
      // first error (`$ line` echoes show where). `eval <match> -` can't read
      // stdin here — batch owns it; inline the JS instead.
      const lines = (await stdin()).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      for (const line of lines) {
        console.log('$ ' + line);
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
    case 'navigate':
      if (!args[0] || !args[1]) fail('usage: nav <match> <url>');
      print(await cmd({ type: 'navigate', urlMatch: args[0], url: args[1] }));
      break;

    case 'close':
    case 'mark':
    case 'release':
    case 'unemulate':
      if (!args[0]) fail(`usage: ${cmdName} <match>`);
      print(await cmd({ type: cmdName, urlMatch: args[0] }));
      break;

    case 'snap': {
      if (!args[0]) fail('usage: snap <match> [css] [--diff] [--href]');
      const diff = args.includes('--diff');
      const href = args.includes('--href');
      const scope = args.slice(1).find((a) => !a.startsWith('--')) || null;
      print(await cmd({ type: 'snap', urlMatch: args[0], scope, diff, href }));
      break;
    }

    case 'click':
      if (!args[0] || !args[1]) fail('usage: click <match> <@ref|css>');
      print(await cmd({ type: 'click', urlMatch: args[0], target: args[1] }));
      break;

    case 'fill':
      if (!args[0] || !args[1] || args[2] === undefined) fail('usage: fill <match> <@ref|css> <value>');
      print(await cmd({ type: 'fill', urlMatch: args[0], target: args[1], value: args.slice(2).join(' ') }));
      break;

    case 'type':
      if (!args[0] || !args[1] || args[2] === undefined) fail('usage: type <match> <@ref|css> <text>');
      print(await cmd({ type: 'type', urlMatch: args[0], target: args[1], value: args.slice(2).join(' ') }));
      break;

    case 'press':
      if (!args[0] || !args[1]) fail('usage: press <match> <key> [@ref|css]');
      print(await cmd({ type: 'press', urlMatch: args[0], key: args[1], target: args[2] || null }));
      break;

    case 'hover':
      if (!args[0] || !args[1]) fail('usage: hover <match> <@ref|css>');
      print(await cmd({ type: 'hover', urlMatch: args[0], target: args[1] }));
      break;

    case 'net': {
      const [match, ...rest] = args;
      let duration = null;
      let filter = null;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--dur') duration = Number(rest[++i]);
        else if (rest[i] === '--filter') filter = rest[++i];
        else fail(`unknown flag ${rest[i]}`);
      }
      if (!match) fail('usage: net <match> [--dur ms] [--filter s]');
      print(await cmd({ type: 'net', urlMatch: match, duration, filter }));
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
        else pos.push(rest[i]);
      }
      const selector = pos[0] || null;
      if (!match || (!selector && !text)) fail('usage: wait <match> [css|--text t] [--timeout ms]');
      print(await cmd({ type: 'wait', urlMatch: match, selector, text, timeout }));
      break;
    }

    case 'eval': {
      const [match, ...rest] = args;
      let world = 'auto';
      const wi = rest.indexOf('--world');
      if (wi >= 0) {
        world = rest[wi + 1]?.toUpperCase() === 'MAIN' ? 'MAIN' : rest[wi + 1]?.toUpperCase() === 'ISOLATED' ? 'ISOLATED' : 'auto';
        rest.splice(wi, 2);
      }
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
      print(await cmd({ type: 'eval', urlMatch: args[0], code: measureSrc(args[1]) }));
      break;

    case 'console':
      if (!args[0]) fail('usage: console <match> [--clear]');
      print(await cmd({ type: 'console', urlMatch: args[0], clear: args.includes('--clear') }));
      break;

    case 'grid':
      if (!args[0]) fail('usage: grid <match>');
      print(await cmd({ type: 'eval', urlMatch: args[0], code: GRID_SRC }));
      break;

    case 'emulate':
      if (!args[0] || !args[1] || !args[2]) fail('usage: emulate <match> <w> <h> [mobile]');
      print(await cmd({ type: 'emulate', urlMatch: args[0], width: Number(args[1]), height: Number(args[2]), mobile: args[3] === 'mobile' }));
      break;

    case 'resize':
      if (!args[0] || !args[1] || !args[2]) fail('usage: resize <match> <w> <h>');
      print(await cmd({ type: 'resize', urlMatch: args[0], width: Number(args[1]), height: Number(args[2]) }));
      break;

    default:
      fail(`unknown command: ${cmdName}\n\n${USAGE}`);
  }
}

const [, , cmdName, ...args] = process.argv;
await run(cmdName, args);
