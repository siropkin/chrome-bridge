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

// Page-side helpers (eval-based).
const measureSrc = (sel) =>
  `JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>{const r=e.getBoundingClientRect();const c=getComputedStyle(e);return{text:(e.textContent||'').trim().slice(0,30),x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),display:c.display,alignItems:c.alignItems,justifyContent:c.justifyContent,textAlign:c.textAlign,gap:c.gap,padding:c.padding,radius:c.borderRadius,bg:c.backgroundColor,color:c.color,font:c.fontSize+'/'+c.fontWeight}}))`;
const GRID_SRC = `(()=>{const g=document.getElementById('bridge-grid');if(g){g.remove();return 'grid off'}const d=document.createElement('div');d.id='bridge-grid';d.style.cssText='position:fixed;inset:0;z-index:2147483646;pointer-events:none;background-image:repeating-linear-gradient(0deg,rgba(255,0,0,.25) 0 1px,transparent 1px 8px),repeating-linear-gradient(90deg,rgba(255,0,0,.25) 0 1px,transparent 1px 8px)';document.body.appendChild(d);return 'grid on'})()`;

const USAGE = `chrome-bridge CLI — drive the user's real Chrome.

  tabs                              list tabs (compact JSON)
  open <url>                        open + mark a new tab
  nav <match> <url>                 navigate matching tab
  close <match>                     close matching tab
  snap <match>                      a11y-tree snapshot with @eN refs (cheap — use before shot)
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

<match> is a substring of the tab URL; the most recently active match wins.
Refs (@eN) come from snap and expire on navigation — re-snap after nav.`;

const [, , cmdName, ...args] = process.argv;

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

  case 'snap':
    if (!args[0]) fail('usage: snap <match>');
    print(await cmd({ type: 'snap', urlMatch: args[0] }));
    break;

  case 'click':
    if (!args[0] || !args[1]) fail('usage: click <match> <@ref|css>');
    print(await cmd({ type: 'click', urlMatch: args[0], target: args[1] }));
    break;

  case 'fill':
    if (!args[0] || !args[1] || args[2] === undefined) fail('usage: fill <match> <@ref|css> <value>');
    print(await cmd({ type: 'fill', urlMatch: args[0], target: args[1], value: args.slice(2).join(' ') }));
    break;

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
    if (!match || !out) fail('usage: shot <match> <out> [--scale N] [--format png|jpeg] [--quality N] [--crop x,y,w,h]');
    const msg = { type: 'shot', urlMatch: match };
    for (let i = 0; i < rest.length; i += 2) {
      const k = rest[i];
      const v = rest[i + 1];
      if (k === '--scale') msg.scale = Number(v);
      else if (k === '--format') msg.format = v;
      else if (k === '--quality') msg.quality = Number(v);
      else if (k === '--crop') msg.crop = v.split(',').map(Number);
      else fail(`unknown flag ${k}`);
    }
    const dataUrl = await cmd(msg);
    const b64 = dataUrl.includes(',') ? dataUrl.split(',', 2)[1] : dataUrl;
    const buf = Buffer.from(b64, 'base64');
    fs.writeFileSync(out, buf);
    console.log(`saved ${out} (${Math.round(buf.length / 1024)} KB)`);
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
