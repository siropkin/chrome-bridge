import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const [profile, out] = process.argv.slice(2);
assert.ok(profile && out, 'usage: node test/stress/safety.mjs <profile> <output-directory>');
const cliPath = fileURLToPath(new URL('../../cli.mjs', import.meta.url));
const suffix = `safety-${randomUUID()}`;
const origin = `http://${suffix}.review.localhost:9334`;
const staticUrl = `${origin}/fixtures/static.html?${suffix}`;
const counterUrl = `${origin}/fixtures/counter.html?${suffix}`;
const destination = `http://localhost:9334/fixtures/counter.html?${suffix}-destination`;
const urls = new Set([staticUrl, counterUrl, destination]);
const created = new Set();
const token = `synthetic-${suffix}`;
let cookieTab;
let failed = false;
let baseline;

function cli(...args) {
  const result = spawnSync(process.execPath, [cliPath, ...args, '--profile', profile], {
    encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, BRIDGE_DIAGNOSTICS_TEST: '1' },
  });
  assert.ifError(result.error);
  return result;
}

function run(...args) {
  const result = cli(...args);
  assert.equal(result.status, 0, `${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function tabs() {
  const result = JSON.parse(run('tabs'));
  assert.ok(Array.isArray(result) && result.every((tab) => Number.isInteger(tab.id)), 'valid tab inventory');
  return result;
}

function activeIds() {
  return tabs().filter((tab) => tab.active).map((tab) => tab.id).sort((left, right) => left - right);
}

function unchanged(label) {
  assert.deepEqual(activeIds(), baseline, `${label}: active tabs changed`);
  console.log(`PASS [safety] ${label}: active tabs unchanged`);
}

function evaluate(tab, code) {
  return JSON.parse(run('eval', tab, code, '--world', 'main'));
}

function open(url) {
  const result = JSON.parse(run('open', url));
  assert.ok(Number.isInteger(result.id), 'open returned an exact tab ID');
  created.add(result.id);
  unchanged('inactive open');
  const tab = `id:${result.id}`;
  assert.equal(evaluate(tab, `location.href === ${JSON.stringify(url)}`), true, 'fixture loaded at the requested URL');
  return tab;
}

try {
  baseline = activeIds();
  assert.ok(baseline.length, 'an existing active tab is required');
  cookieTab = open(staticUrl);
  const counter = open(counterUrl);
  assert.equal(evaluate(cookieTab, `
    document.documentElement.dataset.safetyFocus = '0';
    const record = () => { document.documentElement.dataset.safetyFocus = String(Number(document.documentElement.dataset.safetyFocus) + 1); };
    window.addEventListener('focus', record);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) record(); });
    true
  `), true);
  assert.match(run('snap', cookieTab), /Static button one/);
  unchanged('snap');
  assert.equal(evaluate(counter, `document.getElementById('c').textContent = '1'; Number(document.getElementById('c').textContent)`), 1);
  unchanged('eval');
  assert.equal(evaluate(cookieTab, `
    document.querySelector('button').addEventListener('click', (event) => {
      document.documentElement.dataset.safetyClick = event.isTrusted ? 'trusted' : 'synthetic';
    });
    true
  `), true);
  run('click', cookieTab, 'button');
  assert.equal(evaluate(cookieTab, `document.documentElement.dataset.safetyClick === 'synthetic'`), true);
  unchanged('synthetic click');
  const screenshot = path.join(out, `${suffix}.png`);
  run('shot', cookieTab, screenshot);
  const png = readFileSync(screenshot);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'CDP shot is PNG data');
  assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0, 'CDP shot has nonzero dimensions');
  unchanged('background CDP shot');
  assert.equal(evaluate(cookieTab, `Number(document.documentElement.dataset.safetyFocus)`), 0, 'no transient fixture activation');
  console.log('PASS [safety] background operations never made the fixture visible or focused');

  for (const [index, message] of [
    'application failure',
    'Refused to evaluate because Content Security Policy blocks unsafe-eval',
  ].entries()) {
    const key = `safetyEval${index}`;
    const result = cli('eval', counter, `
      document.documentElement.dataset.${key} = String(Number(document.documentElement.dataset.${key} || 0) + 1);
      throw new EvalError(${JSON.stringify(message)});
    `, '--world', 'main');
    assert.notEqual(result.status, 0, 'application EvalError must propagate');
    assert.ok(result.stderr.includes(message), 'original application error is returned');
    assert.equal(evaluate(counter, `Number(document.documentElement.dataset.${key})`), 1, 'application mutation ran exactly once');
    console.log(`PASS [safety] ${index ? 'CSP-like' : 'ordinary'} application EvalError never replays`);
    unchanged('application EvalError');
  }

  assert.equal(evaluate(cookieTab, `
    document.cookie = ${JSON.stringify(`JSESSIONID=${token}; Path=/api/data; SameSite=Lax; Max-Age=120`)};
    window.__safetyHook = { calls: 0, sawToken: false };
    window.fetch = async (input, options) => {
      window.__safetyHook.calls++;
      const headers = new Headers(options?.headers || (input instanceof Request ? input.headers : undefined));
      window.__safetyHook.sawToken ||= headers.has('csrf-token');
      return new Response(JSON.stringify({ fake: true }), { headers: { 'Content-Type': 'application/json' } });
    };
    true
  `), true);
  assert.deepEqual(evaluate(cookieTab, `(async () => {
    const value = await (await window.fetch('/api/data')).json();
    const working = value.fake === true && window.__safetyHook.calls === 1;
    window.__safetyHook.calls = 0;
    return working;
  })()`), true, 'hostile MAIN hook is installed and functional');
  const wrongOrigin = cli('fetch', cookieTab, 'http://localhost:9334/api/data', '--csrf');
  assert.notEqual(wrongOrigin.status, 0, 'cross-origin CSRF fetch must fail');
  assert.match(wrongOrigin.stderr, /same HTTP\(S\) origin/);
  const response = run('fetch', cookieTab, `${origin}/api/data`, '--csrf');
  const newline = response.indexOf('\n');
  assert.match(response.slice(0, newline), /^200 application\/json/);
  assert.deepEqual(JSON.parse(response.slice(newline + 1)), { ok: true, items: [1, 2, 3] });
  assert.deepEqual(evaluate(cookieTab, 'window.__safetyHook'), { calls: 0, sawToken: false }, 'MAIN never sees the CSRF request or header');
  console.log('PASS [safety] CSRF refuses wrong origin; isolated fetch bypasses hostile MAIN and returns fixture JSON');
  unchanged('CSRF fetch');

  const marker = `prior-note-${suffix}`;
  run('note', counter, marker);
  const pillContains = `(() => {
    const root = document.getElementById('bridge-banner')?.shadowRoot;
    if (!root?.querySelector('[role="group"]')) throw new Error('new document pill is missing');
    return root.innerHTML.includes(${JSON.stringify(marker)});
  })()`;
  assert.equal(evaluate(counter, pillContains), true, 'prior note is present before navigation');
  run('nav', counter, destination);
  assert.equal(evaluate(counter, `location.href === ${JSON.stringify(destination)}`), true, 'cross-origin navigation completed');
  assert.equal(evaluate(counter, pillContains), false, 'new pill DOM has no prior note');
  run('snap', counter);
  assert.equal(evaluate(counter, pillContains), false, 'prior note stays absent after another activity update');
  console.log('PASS [safety] cross-origin navigation clears prior note from pill DOM and history');
  unchanged('cross-origin navigation');
} catch (error) {
  failed = true;
  console.error(`FAIL [safety] ${error.message}`);
} finally {
  try {
    if (cookieTab) {
      assert.equal(evaluate(cookieTab, `
        document.cookie = 'JSESSIONID=; Path=/api/data; SameSite=Lax; Max-Age=0';
        true
      `), true);
    }
  } catch (error) {
    failed = true;
    console.error(`FAIL [safety] synthetic cookie cleanup: ${error.message}`);
  }
  try {
    for (const tab of tabs()) if (urls.has(tab.url)) created.add(tab.id);
  } catch (error) {
    failed = true;
    console.error(`FAIL [safety] disposable tab inventory: ${error.message}`);
  }
  for (const id of created) {
    try { run('close', `id:${id}`); } catch (error) {
      failed = true;
      console.error(`FAIL [safety] exact-ID cleanup: ${error.message}`);
    }
  }
  try {
    assert.equal(tabs().some((tab) => created.has(tab.id) || urls.has(tab.url)), false, 'all disposable tabs closed');
    if (baseline) unchanged('cleanup');
    console.log('PASS [safety] exact-ID cleanup left no disposable tabs');
  } catch (error) {
    failed = true;
    console.error(`FAIL [safety] cleanup verification: ${error.message}`);
  }
}
process.exitCode = failed ? 1 : 0;