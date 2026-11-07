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
  vm.runInContext(source, context);
  return context;
};
const context = load();
const C = context.BridgeCommands;
const json = (v) => JSON.stringify(v);
const parse = (line) => JSON.parse(json(C.parse(C.tokenize(line))));

test('loads as a classic script with no Node globals and publishes one frozen API', () => {
  assert.deepEqual(Object.keys(context), ['BridgeCommands'], 'the IIFE leaks no other globals into the worker scope');
  assert.ok(Object.isFrozen(C) && Object.isFrozen(C.REGISTRY) && C.REGISTRY.every((e) => Object.isFrozen(e)));
  for (const k of ['GROUPS', 'REGISTRY', 'lookup', 'tokenize', 'splitLine', 'splitDashDash', 'parse', 'render', 'replyWarnings']) assert.ok(k in C, k);
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

test('parse returns the wire message plus render-only view, canonical name for aliases', () => {
  assert.equal(json(parse('navigate m https://a.test --diff')), json({ name: 'nav', msg: { type: 'navigate', urlMatch: 'm', url: 'https://a.test', diff: true }, view: {} }));
  assert.equal(json(parse('tabs github')), json({ name: 'tabs', msg: { type: 'tabs' }, view: { match: 'github' } }));
  assert.throws(() => C.parse(['nope']), /^Error: unknown command: nope$/);
  assert.throws(() => C.parse(['start']), /start is local-only .* node cli\.mjs start/);
});

test('tricky parsers: snap --find, the -- separator, press order, stray and extra arguments', () => {
  assert.equal(json(parse('snap m #scope --find the --recursive flag --diff').msg), json({ type: 'snap', urlMatch: 'm', scope: '#scope', diff: true, href: false, find: 'the --recursive flag' }));
  assert.throws(() => parse('snap m --dfif'), /unknown flag --dfif/);
  assert.equal(parse('fill m @e1 -- --front matter').msg.value, '--front matter');
  assert.throws(() => parse('fill m @e1 v --dfif'), /unknown flag --dfif \(flags: --diff;/);
  assert.throws(() => C.parse(['type', 'm', '@e1', 'x'.repeat(2001)]), /text is 2001 chars — .* paste/);
  assert.equal(json(parse('press m @e3 Enter').msg), json({ type: 'press', urlMatch: 'm', key: 'Enter', target: '@e3' }));
  assert.throws(() => parse('click m #list @e3'), /unexpected extra argument '@e3' — usage: click/);
  assert.equal(json(parse('emulate m 390 844 mobile dsf=3').msg), json({ type: 'emulate', urlMatch: 'm', width: 390, height: 844, mobile: true, dsf: 3 }));
  assert.throws(() => parse('emulate m 390 844 dsf=9'), /dsf must be 0\.1–4/);
});

test('render: tabs filters, doctor hides driven tabs, snap surfaces cut warnings', () => {
  const tabs = [{ id: 1, url: 'https://a.test', title: 'A' }, { id: 22, url: 'https://b.test', title: 'B 1' }, { id: 3, title: 'no url' }];
  assert.equal(C.render(parse('tabs id:22'), tabs).text, json([tabs[1]]));
  assert.equal(C.render(parse('tabs 1'), tabs).text, json([tabs[1]]), 'substring of url or title, not id');
  assert.equal(C.render(parse('tabs'), tabs).text, json(tabs));
  assert.equal(C.render(parse('doctor'), [{ id: 1, driven: true }, { id: 2 }]).text, json([{ id: 2 }]));
  const tree = 'a @e1\n… truncated at 300 nodes — scope it\nb\n(modal layer past the cut — dialog)\n  button "x" @e9\n  more';
  assert.equal(json(C.render(parse('snap m'), tree)), json({ text: tree, warnings: ['… truncated at 300 nodes — scope it', '(modal layer past the cut — dialog)\n  button "x" @e9'] }));
  assert.throws(() => C.render(parse('snap m'), '  \n'), /^Error: empty tree — /);
  assert.equal(C.render(parse('note m hi'), undefined).text, 'undefined', 'text is always a string');
  assert.equal(C.render(parse('perf m'), { cpu: 1 }).text, '{"cpu":1}');
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
