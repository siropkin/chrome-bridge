// Unit tests for the shared command grammar (extension/commands.js). It is
// loaded the way the service worker will load it: a classic script in a bare
// global (no require, process or Buffer). Objects cross the vm realm boundary,
// so comparisons go through JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extension/commands.js', import.meta.url), 'utf8');
const load = () => {
  const context = vm.createContext({});
  // fetch's URL validation needs the URL constructor. Every real host (Node,
  // a service worker) provides it as a global; a bare vm.createContext({})
  // does not — add it non-enumerable so the script can resolve the bare
  // identifier without it showing up in the "leaks no globals" check below.
  Object.defineProperty(context, 'URL', { value: URL, enumerable: false });
  vm.runInContext(source, context);
  return context;
};
const context = load();
const C = context.BridgeCommands;
const json = (v) => JSON.stringify(v);
// parse() is async (A1b: paste/upload/eval/wait take injected io) — the test
// helper awaits it so callers read the same as the A1a sync version did.
const parse = async (line, io) => JSON.parse(json(await C.parse(C.tokenize(line), io)));

test('loads as a classic script with no Node globals and publishes one frozen API', () => {
  assert.deepEqual(Object.keys(context), ['BridgeCommands'], 'the IIFE leaks no other globals into the worker scope');
  assert.ok(Object.isFrozen(C) && Object.isFrozen(C.REGISTRY) && C.REGISTRY.every((e) => Object.isFrozen(e)));
  // splitDashDash stays internal (A1b): fill/type/paste use it, but nothing
  // outside commands.js needs it anymore now that paste moved in.
  for (const k of ['GROUPS', 'REGISTRY', 'lookup', 'tokenize', 'splitLine', 'parse', 'render', 'replyWarnings']) assert.ok(k in C, k);
  assert.ok(!('splitDashDash' in C), 'splitDashDash is not exported — nothing outside the module calls it');
  assert.doesNotThrow(() => vm.runInContext(source, context), 'a second load (worker restart path) does not collide with the first');
});

test('registry entries are well-formed and every name or alias resolves once', () => {
  const words = C.REGISTRY.flatMap((e) => [e.name, ...e.aliases]);
  assert.equal(new Set(words).size, words.length, 'names and aliases are unique');
  for (const e of C.REGISTRY) {
    assert.ok(C.GROUPS.includes(e.group), `${e.name}: group ${e.group}`);
    assert.ok(e.scope === 'browser' || e.scope === 'local-only', `${e.name}: scope ${e.scope}`);
    assert.ok(!(e.readOnly && e.destructive), `${e.name}: readOnly and destructive at once`);
    assert.ok(e.diskBound === false || (typeof e.diskBound === 'string' && e.diskBound), `${e.name}: diskBound`);
    assert.ok(e.pageCode === false || (typeof e.pageCode === 'string' && e.pageCode && !e.readOnly), `${e.name}: pageCode is false, or set on a non-readOnly command`);
    assert.ok(e.usage === e.name || e.usage.startsWith(e.name + ' '), `${e.name}: usage starts with the name`);
    for (const w of [e.name, ...e.aliases]) assert.equal(C.lookup(w), e);
  }
  assert.equal(C.lookup('nope'), null);
  assert.equal(C.lookup('__proto__'), null);
  assert.equal(C.lookup('constructor'), null);
});

test('parse returns the wire message plus render-only view, canonical name for aliases', async () => {
  assert.equal(json(await parse('navigate m https://a.test --diff')), json({ name: 'nav', msg: { type: 'navigate', urlMatch: 'm', url: 'https://a.test', diff: true }, view: {} }));
  assert.equal(json(await parse('tabs github')), json({ name: 'tabs', msg: { type: 'tabs' }, view: { match: 'github' } }));
  await assert.rejects(() => C.parse(['nope']), /^Error: unknown command: nope$/);
  await assert.rejects(() => C.parse(['start']), /start is local-only .* node cli\.mjs start/);
});

test('tricky parsers: snap --find, the -- separator, press order, stray and extra arguments', async () => {
  assert.equal(json((await parse('snap m #scope --find the --recursive flag --diff')).msg), json({ type: 'snap', urlMatch: 'm', scope: '#scope', diff: true, href: false, find: 'the --recursive flag' }));
  await assert.rejects(() => parse('snap m --dfif'), /unknown flag --dfif/);
  assert.equal((await parse('fill m @e1 -- --front matter')).msg.value, '--front matter');
  await assert.rejects(() => parse('fill m @e1 v --dfif'), /unknown flag --dfif \(flags: --diff;/);
  await assert.rejects(() => C.parse(['type', 'm', '@e1', 'x'.repeat(2001)]), /text is 2001 chars — .* paste/);
  assert.equal(json((await parse('press m @e3 Enter')).msg), json({ type: 'press', urlMatch: 'm', key: 'Enter', target: '@e3' }));
  await assert.rejects(() => parse('click m #list @e3'), /unexpected extra argument '@e3' — usage: click/);
  assert.equal(json((await parse('emulate m 390 844 mobile dsf=3')).msg), json({ type: 'emulate', urlMatch: 'm', width: 390, height: 844, mobile: true, dsf: 3 }));
  await assert.rejects(() => parse('emulate m 390 844 dsf=9'), /dsf must be 0\.1–4/);
});

test('render: tabs filters, doctor hides driven tabs, snap surfaces cut warnings', async () => {
  const tabs = [{ id: 1, url: 'https://a.test', title: 'A' }, { id: 22, url: 'https://b.test', title: 'B 1' }, { id: 3, title: 'no url' }];
  assert.equal(C.render(await parse('tabs id:22'), tabs).text, json([tabs[1]]));
  assert.equal(C.render(await parse('tabs 1'), tabs).text, json([tabs[1]]), 'substring of url or title, not id');
  assert.equal(C.render(await parse('tabs'), tabs).text, json(tabs));
  assert.equal(C.render(await parse('doctor'), [{ id: 1, driven: true }, { id: 2 }]).text, json([{ id: 2 }]));
  const tree = 'a @e1\n… truncated at 300 nodes — scope it\nb\n(modal layer past the cut — dialog)\n  button "x" @e9\n  more';
  assert.equal(json(C.render(await parse('snap m'), tree)), json({ text: tree, warnings: ['… truncated at 300 nodes — scope it', '(modal layer past the cut — dialog)\n  button "x" @e9'] }));
  const parsedSnap = await parse('snap m');
  assert.throws(() => C.render(parsedSnap, '  \n'), /^Error: empty tree — /);
  assert.equal(C.render(await parse('note m hi'), undefined).text, 'undefined', 'text is always a string');
  assert.equal(C.render(await parse('perf m'), { cpu: 1 }).text, '{"cpu":1}');
});

test('render: eval truncates past 50000 chars, every other command is untouched', async () => {
  const small = C.render(await parse('eval m 1+1'), { x: 1 });
  assert.equal(small.text, '{"x":1}');
  const big = C.render(await parse('eval m 1+1'), 'x'.repeat(50_010));
  assert.equal(big.text.length, 50_000 + '\n… eval output truncated at 50000 chars — return less (select narrower, slice in-page) or fetch --out the data instead'.length);
  assert.ok(big.text.startsWith('x'.repeat(50_000) + '\n… eval output truncated at 50000 chars'));
});

test('replyWarnings: server warnings, then page errors with control characters stripped', () => {
  assert.equal(json(C.replyWarnings({ ok: true })), '[]');
  assert.equal(
    json(C.replyWarnings({ warn: ['stale'], pageErrors: { count: 3, lines: ['bad\x1b[31m', 'two\nlines'] } })),
    json(['⚠ stale', '⚠ 3 new page errors since the last command (newest 2) — console <match> shows the log:', '  bad [31m', '  two lines'])
  );
});

test('splitLine: --profile routing, verbatim eval payloads, shell-tokenized everything else', () => {
  const split = (line) => JSON.parse(json(C.splitLine(line)));
  assert.equal(json(split('--profile birch snap m --diff')), json({ profile: 'birch', argv: ['snap', 'm', '--diff'] }));
  assert.equal(json(split('type m @e2 a"b c" \'d e\'')), json({ profile: null, argv: ['type', 'm', '@e2', 'ab c', 'd e'] }));
  assert.equal(json(split('eval m document.querySelector("button").textContent')), json({ profile: null, argv: ['eval', 'm', 'document.querySelector("button").textContent'] }));
  assert.equal(json(split('--profile oak eval "my tab" "a \\"q\\"" --world main')), json({ profile: 'oak', argv: ['eval', 'my tab', 'a "q"', '--world', 'main'] }));
  assert.throws(() => C.splitLine('eval m'), /usage: eval <match>/);
  assert.throws(() => C.splitLine("snap 'open"), /unterminated quote in batch line/);
  assert.throws(() => C.splitLine('--profile --x snap m'), /--profile needs an id or name/);
  assert.equal(json(C.tokenize('"\\u0041\\n" x')), json(['A\n', 'x']));
});

// A1b: paste, upload, eval, wait take an injected io ({ stdin, clipboard,
// syntaxError, resolveFile }) for the one call each needs the disk, the OS
// clipboard, stdin, or a syntax pre-check. A surface that omits a member (the
// cloud link won't have fs/stdin) gets a next-step error instead of a crash.

test('paste: explicit -- text skips the clipboard; otherwise io.clipboard() is read', async () => {
  assert.equal(json((await parse('paste m @e1 -- hello there')).msg), json({ type: 'paste', urlMatch: 'm', target: '@e1', value: 'hello there', clip: false }));
  const io = { clipboard: () => 'clip text' };
  assert.equal(json((await parse('paste m @e1', io)).msg), json({ type: 'paste', urlMatch: 'm', target: '@e1', value: 'clip text', clip: true }));
  await assert.rejects(() => parse('paste m @e1', { clipboard: () => '' }), /clipboard is empty/);
  await assert.rejects(() => parse('paste m @e1'), /reading the OS clipboard is not available here — pass the text/);
  await assert.rejects(() => parse('paste m @e1 --html', io), /paste --html needs the markup after --/);
});

test('upload: resolves every file through io.resolveFile, in order', async () => {
  const seen = [];
  const io = { resolveFile: (f) => { seen.push(f); return '/abs/' + f; } };
  assert.equal(json((await parse('upload m @e1 a.png b.png --chooser', io)).msg), json({ type: 'upload', urlMatch: 'm', target: '@e1', files: ['/abs/a.png', '/abs/b.png'], chooser: true }));
  assert.deepEqual(seen, ['a.png', 'b.png']);
  await assert.rejects(() => parse('upload m @e1 a.png'), /file uploads are not available here — run upload from the local CLI/);
});

test('eval: "-" reads stdin when io.stdin is given, else a next-step error', async () => {
  assert.equal(json((await parse('eval m 1+1 --world main')).msg), json({ type: 'eval', urlMatch: 'm', code: '1+1', world: 'MAIN' }));
  assert.equal((await parse('eval m -', { stdin: async () => 'document.title' })).msg.code, 'document.title');
  await assert.rejects(() => parse('eval m -'), /reading from stdin is not available here/);
});

test('wait: --js "-" reads stdin; io.syntaxError gates the expression the same way the CLI vm check did', async () => {
  assert.equal((await parse('wait m --js -', { stdin: async () => 'a === 1' })).msg.js, 'a === 1');
  await assert.rejects(() => parse('wait m --js -'), /reading from stdin is not available here/);
  // No io.syntaxError: the extension can't eval/new Function (CSP) so it
  // skips the client-side pre-check and lets the server be the judge.
  assert.equal((await parse('wait m --js "1 +"')).msg.js, '1 +');
  await assert.rejects(() => parse('wait m --js "1 +"', { syntaxError: () => true }), /--js needs ONE expression/);
  assert.equal((await parse('wait m --js "a === 1"', { syntaxError: () => false })).msg.js, 'a === 1');
});

test('shot: parses flags into the wire msg, keeps <out> and the effective --max in view only', async () => {
  const p = await parse('shot m out.png --max 0 --diff');
  assert.equal(json(p.msg), json({ type: 'shot', urlMatch: 'm', max: 0, diff: true }));
  assert.equal(json(p.view), json({ out: 'out.png', max: 0 }));
  await assert.rejects(() => parse('shot m out.png --full --crop 1,2,3,4'), /mutually exclusive/);
});

test('net: --har rides only in view (the wire msg just sets har:true)', async () => {
  const p = await parse('net m --har out.har --filter x');
  assert.equal(json(p.msg), json({ type: 'net', urlMatch: 'm', duration: null, filter: 'x', body: null, har: true }));
  assert.equal(p.view.har, 'out.har');
  const noHar = await parse('net m');
  assert.equal(noHar.view.har, null);
});

test('fetch: match/url/flags parse into msg, outFile/keep/host ride in view for the scratch-tab retry', async () => {
  const p = await parse('fetch m https://a.test/x --out f.json --keep --header "X: 1" --csrf');
  assert.equal(json(p.msg), json({ type: 'fetch', urlMatch: 'm', url: 'https://a.test/x', headers: { X: '1' }, csrf: true }));
  assert.equal(json(p.view), json({ outFile: 'f.json', keep: true, host: 'a.test' }));
  await assert.rejects(() => parse('fetch m not-a-url'), /fetch needs a full http\(s\) URL/);
});
