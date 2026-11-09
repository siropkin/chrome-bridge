import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { createDiagnostics } from '../diagnostics.mjs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

test('diagnostics are opt-in, private, correlated, persistent, bounded, and deletable', () => {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'bridge-diagnostics-'));
  const directory = join(root, 'data');
  try {
    const logger = createDiagnostics(directory, '1.29.1');
    const secret = 'secret-password-and-private-page';
    const msg = { type: 'eval', urlMatch: secret, code: `document.querySelector('${secret}').textContent`, profile: secret };
    assert.equal(logger.status().enabled, false);
    assert.equal(logger.start(msg), null);
    assert.equal(fs.existsSync(directory), false);
    assert.throws(() => logger.configure({ enabled: true, limitMiB: 0 }));
    logger.configure({ enabled: true, limitMiB: 1 });
    const token = logger.start(msg, { source: 'cli', invocation: 'one', parent: 'caller', test: true });
    logger.finish(token, { ...msg, type: 'click', diff: true }, { ok: true, result: 'uncertain · ' + secret }, '1.29.1');
    logger.client({ type: secret, ok: false, error: 'SyntaxError: ' + secret });
    logger.client({ type: 'click', ok: false, error: 'element not found: @e5 — the page re-rendered since the snap (this node is gone or hidden, no navigation happened); run snap again for fresh refs' });
    logger.client({ type: 'click', ok: false, error: 'tab is hidden — trusted (CDP) input reaches only the foreground tab' });
    const text = fs.readFileSync(join(directory, 'events.jsonl'), 'utf8');
    const events = text.trim().split('\n').map(JSON.parse);
    assert.equal(text.includes(secret), false);
    assert.equal(events[1].id, events[2].id);
    assert.equal(events[2].outcome.verdict, 'uncertain');
    assert.equal(events[3].outcome.errorCode, 'syntax_error');
    assert.equal(events[4].outcome.errorCode, 'target_stale');
    assert.equal(events[5].outcome.errorCode, 'tab_hidden');
    assert.equal(events[1].caller.test, true);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(join(directory, 'events.jsonl')).mode & 0o777, 0o600);
    assert.equal(createDiagnostics(directory, '1.29.1').status().enabled, true);
    for (let index = 0; index < 4000; index++) logger.client({ type: 'tabs', ok: true });
    assert.ok(fs.existsSync(join(directory, 'events.1.jsonl')));
    assert.ok(logger.status().bytes <= 1024 * 1024);
    for (const file of ['events.1.jsonl', 'events.jsonl']) fs.readFileSync(join(directory, file), 'utf8').trim().split('\n').forEach((line) => JSON.parse(line));
    logger.configure({ enabled: true, limitMiB: 2 });
    for (let index = 0; index < 4000; index++) logger.client({ type: 'tabs', ok: true });
    logger.configure({ enabled: true, limitMiB: 1 });
    assert.ok(logger.status().bytes <= 1024 * 1024);
    assert.doesNotThrow(() => logger.client({ type: 'tabs', ok: false, error: Object.create(null) }));
    logger.configure({ enabled: false, limitMiB: 1 });
    const bytes = logger.status().bytes;
    logger.client({ type: 'tabs', ok: true });
    assert.equal(logger.status().bytes, bytes);
    logger.clear();
    assert.equal(logger.status().bytes, 0);
    assert.equal(createDiagnostics(directory, '1.29.1').status().enabled, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('partial appends recover without losing complete records and report loss', () => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), 'bridge-diagnostics-'));
  const append = fs.appendFileSync;
  try {
    const logger = createDiagnostics(directory, '1.29.1');
    logger.configure({ enabled: true, limitMiB: 1 });
    const file = join(directory, 'events.jsonl');
    const original = fs.readFileSync(file, 'utf8');
    fs.appendFileSync = (path, data, options) => {
      append(path, data.slice(0, 37), options);
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    };
    logger.client({ type: 'tabs', ok: true });
    assert.equal(logger.status().error, 'ENOSPC');
    fs.appendFileSync = append;
    logger.client({ type: 'tabs', ok: true });
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.startsWith(original));
    assert.equal(text.trim().split('\n').map(JSON.parse).length, 2);
    assert.equal(logger.status().error, null);
    assert.equal(logger.status().droppedRecords, 1);
    assert.equal(logger.status().recoveredBytes, 37);
    logger.client({ type: 'tabs', ok: true });
    assert.equal(logger.status().droppedRecords, 1);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(logger.status().bytes <= 1024 * 1024);
  } finally {
    fs.appendFileSync = append;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('startup repairs both crash tails, preserves complete records, and does not rescan on each event', () => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), 'bridge-diagnostics-'));
  const read = fs.readSync;
  try {
    createDiagnostics(directory, '1.29.1').configure({ enabled: true, limitMiB: 1 });
    const active = join(directory, 'events.jsonl');
    const archived = join(directory, 'events.1.jsonl');
    const original = fs.readFileSync(active, 'utf8');
    fs.writeFileSync(archived, original + 'x'.repeat(9000), { mode: 0o600 });
    fs.appendFileSync(active, '{"crash":');
    const logger = createDiagnostics(directory, '1.29.1');
    assert.equal(fs.readFileSync(archived, 'utf8'), original);
    assert.equal(fs.readFileSync(active, 'utf8'), original);
    assert.equal(logger.status().recoveredTails, 2);
    assert.equal(logger.status().recoveredBytes, 9009);
    fs.readSync = () => { throw new Error('unexpected tail scan'); };
    logger.client({ type: 'tabs', ok: true });
    logger.client({ type: 'tabs', ok: true });
    assert.equal(logger.status().error, null);
    assert.equal(logger.status().droppedRecords, 0);
    fs.readSync = read;
    assert.equal(fs.readFileSync(active, 'utf8').trim().split('\n').map(JSON.parse).length, 3);
    assert.equal(logger.status().recoveredTails, 2);
  } finally {
    fs.readSync = read;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('known merged results report failed rows without exposing payloads or interpreting eval data', () => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), 'bridge-diagnostics-'));
  try {
    const logger = createDiagnostics(directory, '1.29.1');
    logger.configure({ enabled: true, limitMiB: 1 });
    const secret = 'private-profile-and-page';
    const healthy = [{ id: 7, profile: secret, title: secret }];
    const failed = [...healthy, { profile: secret, error: 'unresponsive' }, { profile: secret, error: 'TypeError: ' + secret }];
    const summaries = [];
    for (const type of ['tabs', 'doctor', 'eval']) {
      for (const result of [healthy, failed]) {
        const msg = { type };
        logger.finish(logger.start(msg), msg, { ok: true, result });
        logger.client({ type, ok: true, result });
      }
    }
    const text = fs.readFileSync(join(directory, 'events.jsonl'), 'utf8');
    assert.equal(text.includes(secret), false);
    summaries.push(...text.trim().split('\n').map(JSON.parse).filter((event) => event.outcome).map((event) => event.outcome));
    for (const offset of [0, 4]) {
      for (const index of [offset, offset + 1]) {
        assert.equal(summaries[index].failedRows, 0);
        assert.deepEqual(summaries[index].rowErrorCodes, {});
        assert.equal(summaries[index + 2].failedRows, 2);
        assert.deepEqual(summaries[index + 2].rowErrorCodes, { unresponsive: 1, type_error: 1 });
        assert.equal(summaries[index + 2].ok, true);
      }
    }
    for (const summary of summaries.slice(8)) {
      assert.equal(summary.failedRows, undefined);
      assert.equal(summary.rowErrorCodes, undefined);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('routing captures actual dispatch metadata without changing messages and retains it after disconnect', async () => {
  const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const seats = new Map();
  const context = vm.createContext({ seats, CMD_TIMEOUT_MS: 100, setTimeout, clearTimeout, encodeFrame: (frame) => frame, journal: [] });
  vm.runInContext(source.slice(source.indexOf('function dropSeatPending('), source.indexOf('// --- activity feed')), context);
  let disconnect = false;
  const seat = {
    pid: 'private-profile-id', name: 'private-profile-name', v: '1.29.2', pending: new Map(), nextId: 1,
    socket: { write(frame) {
      const msg = JSON.parse(frame);
      queueMicrotask(() => {
        if (disconnect) {
          seats.delete(seat.pid);
          context.dropSeatPending(seat, 'extension disconnected mid-command');
        } else {
          const resolve = seat.pending.get(msg.id);
          seat.pending.delete(msg.id);
          resolve({ ok: true, result: msg.type === 'doctor' ? { rows: [] } : [] });
        }
      });
    } },
  };
  seats.set(seat.pid, seat);
  for (const msg of [{ type: 'eval' }, { type: 'tabs' }, { type: 'doctor' }, { type: 'wait', human: true }, { type: 'type', value: 'text' }]) {
    const dispatch = {};
    assert.equal((await context.route(msg, dispatch)).ok, true);
    assert.equal(msg.profile, undefined);
    assert.deepEqual(dispatch, { profile: seat.pid, extensionVersion: seat.v });
  }
  const pinned = { type: 'eval', profile: seat.name };
  const pinnedDispatch = {};
  await context.route(pinned, pinnedDispatch);
  assert.equal(pinned.profile, seat.pid);
  assert.deepEqual(pinnedDispatch, { profile: seat.pid, extensionVersion: seat.v });
  const replacementDispatch = {};
  await context.ask({ ...seat, v: '0.0.1' }, { type: 'eval' }, 100, replacementDispatch);
  assert.equal(replacementDispatch.extensionVersion, seat.v);
  disconnect = true;
  const dispatch = {};
  const msg = { type: 'eval' };
  const out = await context.route(msg, dispatch);
  assert.equal(out.ok, false);
  assert.equal(seats.size, 0);
  assert.deepEqual(dispatch, { profile: seat.pid, extensionVersion: seat.v });
  const directory = fs.mkdtempSync(join(os.tmpdir(), 'bridge-diagnostics-'));
  try {
    const logger = createDiagnostics(directory, '1.29.1');
    logger.configure({ enabled: true, limitMiB: 1 });
    logger.finish(logger.start(msg), { ...msg, profile: dispatch.profile }, out, dispatch.extensionVersion);
    const text = fs.readFileSync(join(directory, 'events.jsonl'), 'utf8');
    const finish = text.trim().split('\n').map(JSON.parse).at(-1);
    assert.match(finish.profile, /^[a-f0-9]{24}$/);
    assert.equal(finish.extensionVersion, seat.v);
    assert.equal(finish.outcome.errorCode, 'disconnected');
    assert.equal(text.includes(seat.pid), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('parallel stress labels workers and curl probes but never the restarted production server', () => {
  const source = fs.readFileSync(new URL('./stress/parallel.sh', import.meta.url), 'utf8');
  const directory = fs.mkdtempSync(join(os.tmpdir(), 'bridge-diagnostics-'));
  try {
    fs.writeFileSync(join(directory, 'node'), '#!/bin/sh\nprintf "%s" "${BRIDGE_DIAGNOSTICS_TEST-unset}" > "$REPO/$2.env"\n', { mode: 0o700 });
    fs.writeFileSync(join(directory, 'curl'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$REPO/curl.args"\n', { mode: 0o700 });
    const cli = source.match(/^CLI=.*$/m)?.[0];
    const curl = source.match(/^CURL=.*$/m)?.[0];
    const start = source.match(/^\s*env -u BRIDGE_DIAGNOSTICS_TEST node .* start[^\n]*$/m)?.[0];
    assert.ok(cli && curl && start);
    assert.doesNotMatch(source, /^\s*export\s+BRIDGE_DIAGNOSTICS_TEST/m);
    assert.doesNotMatch(source, /(?:^\s*|\$\()curl\s/m);
    const result = spawnSync('bash', ['-c', [cli, curl, '"${CLI[@]}" eval', '"${CURL[@]}" http://example.invalid', start].join('\n')], {
      env: { ...process.env, REPO: directory, PATH: directory + ':' + process.env.PATH, BRIDGE_DIAGNOSTICS_TEST: '1' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(join(directory, 'eval.env'), 'utf8'), '1');
    assert.equal(fs.readFileSync(join(directory, 'start.env'), 'utf8'), 'unset');
    assert.equal(fs.readFileSync(join(directory, 'curl.args'), 'utf8'), '-H\nx-bridge-test: 1\nhttp://example.invalid\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('popup width is independent of the viewport Chrome sizes from its content', () => {
  const html = fs.readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
  const body = html.match(/body\s*\{([^}]+)\}/)[1];
  assert.match(body, /\bwidth:\s*340px\s*;/);
  assert.match(body, /\bmin-width:\s*340px\s*;/);
  assert.match(body, /box-sizing:\s*border-box\s*;/);
  assert.doesNotMatch(body, /\b(?:max-width|vw|dvw|svw)\b/);
});

test('popup: a toggled element whose CSS sets display still hides (author display beats the hidden attribute)', () => {
  const html = fs.readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  for (const [, tag] of html.matchAll(/<(\w+\b[^>]*\shidden\b[^>]*)>/g)) {
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    const classes = (/\bclass="([^"]+)"/.exec(tag)?.[1] || '').split(/\s+/).filter(Boolean);
    for (const sel of [id && '#' + id, ...classes.map((c) => '.' + c)].filter(Boolean)) {
      const esc = sel.replace(/[.#]/g, '\\$&');
      if (new RegExp(`${esc}\\s*\\{[^}]*\\bdisplay\\s*:`).test(css))
        assert.match(css, new RegExp(`${esc}\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`), `${sel} sets display — it needs ${sel}[hidden] { display: none } or the hidden attribute does nothing`);
    }
  }
});

test('popup setup restarts fetched code and reloads stale extensions', () => {
  const prompt = fs.readFileSync(new URL('../extension/setup-prompt.txt', import.meta.url), 'utf8');
  assert.match(prompt, /cli\.mjs stop && node ~\/chrome-bridge\/cli\.mjs start/);
  assert.match(prompt, /cli\.mjs extreload/);
  assert.match(prompt, /cli\.mjs update — it moves the download to the release of this extension/);
  assert.match(prompt, /Preserve existing diagnostic logs and settings/);
});

function popupHarness(sendMessage, { tab, health = { ok: true, extension: true }, healthDown = false, manifestVersion, clipboard, management } = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', checked: false, hidden: true, handlers: {}, addEventListener(type, handler) { this.handlers[type] = handler; } });
    return elements.get(id);
  };
  vm.runInNewContext(fs.readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8'), {
    document: { getElementById: element },
    URL, // a real popup has it; the Cloud section reads the hub's host with it
    fetch: async () => { if (healthDown) throw new Error('connection refused'); return { json: async () => health }; },
    AbortSignal,
    ...(clipboard ? { navigator: { clipboard } } : {}),
    chrome: { tabs: { query: async () => tab ? [tab] : [] }, runtime: { sendMessage, ...(manifestVersion ? { getManifest: () => ({ version: manifestVersion }) } : {}) }, ...(management ? { management } : {}) },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // ⚙ opens the Settings view (it reloads the logging status); ‹ Back leaves it.
  const open = async () => {
    element('open-settings').handlers.click();
    await settle();
  };
  return { element, settle, open };
}

test('popup settings save, validate, confirm deletion, and surface unavailable servers', async () => {
  let settings = { enabled: false, limitMiB: 10, bytes: 500, directory: '/local/logs', error: null };
  let offline = false;
  const requests = [];
  const { element, open } = popupHarness(async (msg) => {
      requests.push(msg);
      if (offline) return { ok: false, error: 'Settings unavailable' };
      if (msg.action === 'configure') settings = { ...settings, enabled: msg.enabled, limitMiB: msg.limitMiB };
      if (msg.action === 'clear') settings.bytes = 0;
      return { ok: true, result: { ...settings } };
  });
  await open();
  assert.equal(element('logging-enabled').checked, false);
  element('logging-enabled').checked = true;
  element('log-limit').value = '25';
  await element('logging-details').handlers.submit({ preventDefault() {} });
  assert.equal(settings.enabled, true);
  assert.equal(settings.limitMiB, 25);
  element('log-limit').value = '0';
  await element('logging-details').handlers.submit({ preventDefault() {} });
  assert.equal(requests.length, 2);
  element('logging-delete').handlers.click();
  assert.equal(element('logging-confirmation').hidden, false);
  assert.equal(element('logging-delete').hidden, true, 'the confirm replaces the link');
  element('logging-cancel').handlers.click();
  assert.equal(element('logging-confirmation').hidden, true);
  assert.equal(element('logging-delete').hidden, false, 'Cancel brings the link back');
  element('logging-delete').handlers.click();
  assert.equal(settings.bytes, 500);
  await element('logging-confirm').handlers.click();
  assert.equal(settings.bytes, 0);
  assert.equal(element('logging-delete').disabled, true);
  offline = true;
  element('close-settings').handlers.click();
  await open();
  assert.match(element('logging-status').textContent, /^Couldn't read this setting/);
});

test('popup reconciles applied mutations after lost or failed acknowledgements', async () => {
  for (const action of ['configure', 'clear']) {
    for (const failure of ['rejected', 'missing', 'error']) {
      let settings = { enabled: false, limitMiB: 10, bytes: 500, directory: '/local/logs', error: null };
      const requests = [];
      const { element, open } = popupHarness(async (message) => {
        requests.push(message.action);
        if (message.action === 'status') return { ok: true, result: { ...settings } };
        settings = action === 'configure' ? { ...settings, enabled: true, limitMiB: 25 } : { ...settings, bytes: 0 };
        if (failure === 'rejected') throw new Error('private transport payload');
        if (failure === 'error') return { ok: false, error: 'private server payload' };
      });
      await open();
      element('logging-enabled').checked = true;
      element('log-limit').value = '25';
      if (action === 'configure') await element('logging-details').handlers.submit({ preventDefault() {} });
      else await element('logging-confirm').handlers.click();
      assert.deepEqual(requests, ['status', action, 'status']);
      assert.equal(element('logging-enabled').checked, settings.enabled);
      assert.equal(element('log-limit').value, String(settings.limitMiB));
      assert.equal(element('logging-delete').disabled, settings.bytes === 0);
      assert.equal(element('log-limit').disabled, false);
      assert.match(element('logging-status').textContent, /acknowledgement.*current status/i);
      assert.doesNotMatch(element('logging-status').textContent, /private|saved|deleted/i);
    }
  }
});

test('popup unknown logging state disables mutations and recovers by retry or reopening', async () => {
  for (const recovery of ['retry', 'reopen']) {
    let offline = false;
    let settings = { enabled: true, limitMiB: 10, bytes: 500, directory: '/local/logs', error: null };
    const { element, open } = popupHarness(async (message) => {
      if (message.action === 'configure') {
        settings = { ...settings, enabled: false, limitMiB: 25 };
        offline = true;
      }
      if (offline) throw new Error('private transport payload');
      return { ok: true, result: { ...settings } };
    });
    await open();
    element('logging-enabled').checked = false;
    element('log-limit').value = '25';
    await element('logging-details').handlers.submit({ preventDefault() {} });
    assert.equal(element('logging-enabled').indeterminate, true);
    assert.match(element('logging-status').textContent, /^Couldn't read this setting/);
    assert.doesNotMatch(element('logging-status').textContent, /private|\bOn\b|\bOff\b/);
    for (const id of ['logging-enabled', 'log-limit', 'logging-delete', 'logging-confirm']) assert.equal(element(id).disabled, true, id);
    assert.equal(element('logging-retry').hidden, false);
    assert.equal(element('logging-retry').disabled, false);
    offline = false;
    if (recovery === 'retry') await element('logging-retry').handlers.click();
    else {
      element('close-settings').handlers.click();
      await open();
    }
    assert.equal(element('logging-enabled').indeterminate, false);
    assert.equal(element('logging-enabled').checked, false);
    assert.equal(element('log-limit').value, '25');
    assert.equal(element('log-limit').disabled, false);
    assert.equal(element('logging-retry').hidden, true);
    offline = true;
    await open();
    assert.equal(element('logging-enabled').indeterminate, true);
    assert.equal(element('log-limit').disabled, true);
  }
});

test('popup active release preserves remaining controls and refreshes the active state', async () => {
  const driven = new Set([7, 8]);
  const { element, settle } = popupHarness(async (message) => {
    if (message.type === 'bridge-state') return { count: driven.size, active: driven.has(7), connected: true };
    if (message.type === 'release-active') driven.delete(7);
    else driven.clear();
    return { count: driven.size };
  }, { tab: { id: 7 }, health: { ok: true, extension: true, profiles: [{}, {}] } });
  await settle();
  assert.equal(element('status-text').textContent, 'AI is working in 2 tabs');
  assert.equal(element('idle').hidden, false, 'the tab ID stays copyable while the agent works');
  assert.equal(element('stop-row').hidden, false);
  assert.equal(element('release-all').textContent, 'Stop all');
  assert.equal(element('release-tab').hidden, false, 'this tab is one of them: Stop this tab shows');
  assert.equal(element('release-all').title, 'Stop the agent in all 2 tabs (this Chrome profile)', 'several profiles: the stop must not read wider than it is');
  await element('release-tab').handlers.click();
  assert.equal(element('stop-row').hidden, false);
  assert.equal(element('status-text').textContent, 'AI is working in 1 tab');
  assert.equal(element('release-all').textContent, 'Stop', 'one tab left: a single Stop covers it');
  assert.equal(element('release-tab').hidden, true);
  assert.equal(element('release-all').title, 'Stop the agent in its tab (this Chrome profile)');
  assert.equal(element('status').textContent, 'Stopped ✓ — the tabs are yours again');
  await element('release-all').handlers.click();
  assert.equal(element('stop-row').hidden, true);
  assert.equal(element('status-text').textContent, 'Ready for your AI agent');
});

test('popup shows one card per state: setup when the bridge is down, the tab ID copy when idle', async () => {
  const state = async () => ({ count: 0, active: false, connected: true, profile: 'poplar' });
  const down = popupHarness(state, { tab: { id: 7 }, healthDown: true });
  await down.settle();
  assert.equal(down.element('status-text').textContent, 'Not connected to an AI agent');
  assert.equal(down.element('setup-card').hidden, false);
  assert.equal(down.element('idle').hidden, true, 'no agent to paste a tab ID to');
  assert.equal(down.element('release-all').hidden, true);
  assert.match(down.element('local-status').textContent, /isn't running/);
  let copied = '';
  const up = popupHarness(state, { tab: { id: 7 }, clipboard: { writeText: async (t) => { copied = t; } } });
  await up.settle();
  assert.equal(up.element('status-text').textContent, 'Ready for your AI agent');
  assert.match(up.element('local-status').textContent, /^Connected/);
  assert.equal(up.element('setup-card').hidden, true);
  assert.equal(up.element('idle').hidden, false);
  assert.equal(up.element('copy').title, 'id:7 --profile poplar');
  await up.element('copy').handlers.click();
  await up.settle();
  assert.equal(copied, 'id:7 --profile poplar');
  assert.equal(up.element('status').textContent, 'Copied id:7 --profile poplar ✓ — paste it to your agent');
  assert.equal(up.element('profile-name').textContent, 'poplar', 'the header names the profile the way agents do');
  assert.equal(up.element('profile').hidden, false);
});

test('popup update banner: version drift shows it with a copyable update prompt; in step or an old server stays quiet', async () => {
  const state = async () => ({ count: 0, active: false, connected: true, profile: 'poplar' });
  const health = (extra) => ({ ok: true, extension: true, repo: '/home/u/chrome-bridge/', ...extra });
  let copied = '';
  const clipboard = { writeText: async (t) => { copied = t; } };
  const older = popupHarness(state, { tab: { id: 7 }, health: health({ v: '1.30.6', disk: '1.30.6' }), manifestVersion: '1.30.5', clipboard });
  await older.settle();
  assert.equal(older.element('update').hidden, false);
  assert.equal(older.element('status-text').textContent, 'Update needed');
  assert.equal(older.element('update-text').textContent, 'Chrome Bridge on your computer and this extension are different versions. Copy this prompt to your AI agent and it will update it.', 'plain words for the person');
  assert.equal(older.element('update-text').title, 'This extension is 1.30.5; the bridge on your computer is 1.30.6.', 'exact versions on hover');
  await older.element('copy-update').handlers.click();
  await older.settle();
  assert.match(copied, /node "\/home\/u\/chrome-bridge\/cli\.mjs" update/);
  assert.match(older.element('update-status').textContent, /Copied/);
  const restart = popupHarness(state, { tab: { id: 7 }, health: health({ v: '1.30.6', disk: '1.30.7' }), manifestVersion: '1.30.6' });
  await restart.settle();
  assert.match(restart.element('update-text').textContent, /^Chrome Bridge on your computer was updated but still runs the old version\./);
  assert.match(restart.element('update-text').title, /updated to 1\.30\.7 but still runs 1\.30\.6/);
  const inStep = popupHarness(state, { tab: { id: 7 }, health: health({ v: '1.30.6', disk: '1.30.6' }), manifestVersion: '1.30.6' });
  await inStep.settle();
  assert.equal(inStep.element('update').hidden, true);
  const oldServer = popupHarness(state, { tab: { id: 7 }, health: health({}), manifestVersion: '1.30.6' });
  await oldServer.settle();
  assert.equal(oldServer.element('update').hidden, true);
});

test('popup release errors and missing acknowledgements never claim success', async () => {
  for (const failure of ['error', 'missing', 'rejected', 'refresh']) {
    let count = 2;
    const { element, settle } = popupHarness(async (message) => {
      if (message.type === 'bridge-state') {
        if (failure === 'refresh' && count === 1) throw new Error('state unavailable');
        return { count, active: true, connected: true };
      }
      count = 1;
      if (failure === 'error') return { error: 'release unavailable' };
      if (failure === 'rejected') throw new Error('reply lost');
      if (failure === 'refresh') return { count };
    }, { tab: { id: 7 } });
    await settle();
    await element('release-all').handlers.click();
    assert.match(element('status').textContent, /Stop failed/);
    assert.doesNotMatch(element('status').textContent, /Stopped/);
    assert.equal(element('stop-row').hidden, false);
    assert.equal(element('release-all').disabled, false);
    if (failure !== 'refresh') assert.equal(element('status-text').textContent, 'AI is working in 1 tab');
  }
});

test('clearing or disabling invalidates in-flight records; storage failures do not break commands', () => {
  const directory = fs.mkdtempSync(join(os.tmpdir(), 'bridge-diagnostics-'));
  try {
    const logger = createDiagnostics(directory, '1.29.1');
    logger.configure({ enabled: true, limitMiB: 1 });
    const token = logger.start({ type: 'tabs' });
    logger.clear();
    logger.finish(token, {}, { ok: true });
    assert.equal(logger.status().bytes, 0);
    fs.mkdirSync(join(directory, 'events.jsonl'));
    assert.doesNotThrow(() => logger.client({ type: 'tabs', ok: true }));
    assert.ok(logger.status().error);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('popup Cloud access (Settings): unpaired, the switch opens the address form; pairing shows the code', async () => {
  const sent = [];
  let cloud = { paired: false, enabled: false, connected: false, hub: '', profile: 'poplar', pairing: null, notice: '' };
  const { element, settle } = popupHarness(async (message) => {
    sent.push(message);
    if (message.type === 'bridge-state') return { count: 0, active: false, connected: true, profile: 'poplar', cloud };
    if (message.type === 'cloud-pair') {
      if (!message.hub) return { ok: false, error: 'Enter the Cloud Bridge hub URL, e.g. https://cloud-bridge.<you>.workers.dev', ...cloud };
      cloud = { ...cloud, hub: 'http://localhost:8787', pairing: { code: 'ABCD-EFGH', verificationUri: 'http://localhost:8787/pair?code=ABCD-EFGH' } };
    }
    return { ok: true, ...cloud };
  }, { tab: { id: 7 } });
  await settle();
  assert.equal(element('cloud-status').textContent, 'Let Claude.ai or ChatGPT use this browser');
  assert.equal(element('cloud-enabled').checked, false);
  assert.equal(element('cloud-pair-row').hidden, true, 'the form waits for the switch');
  assert.equal(element('cloud-paired').hidden, true);
  element('cloud-enabled').checked = true;
  element('cloud-enabled').handlers.change();
  assert.equal(element('cloud-pair-row').hidden, false);
  assert.equal(sent.filter((m) => m.type.startsWith('cloud-')).length, 0, 'switching on unpaired only opens the form');
  await element('cloud-pair').handlers.click();
  assert.match(element('cloud-status').textContent, /^Enter the Cloud Bridge hub URL/, 'the worker\'s next step is shown');
  element('cloud-hub').value = ' http://localhost:8787 ';
  await element('cloud-pair').handlers.click();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { type: 'cloud-pair', hub: 'http://localhost:8787' });
  assert.equal(element('cloud-code').hidden, false);
  assert.equal(element('cloud-code-text').textContent, 'Your code: ABCD-EFGH. Check it matches, then click Connect on that page.');
  assert.equal(element('cloud-pair-row').hidden, true, 'waiting for the code: the address form gives way to the code');
  assert.equal(element('cloud-enabled').checked, true);
  assert.equal(element('cloud-open-page').href, 'http://localhost:8787/pair?code=ABCD-EFGH');
  assert.equal(element('cloud-status').textContent, 'Waiting for you to confirm on Cloud Bridge…');
  assert.equal(sent.filter((m) => m.type === 'cloud-state').length, 0, 'state comes with bridge-state: no extra round trip');
});

test('popup Cloud AI apps (Settings): connected shows how to add it to Claude or ChatGPT; the switch off signs out', async () => {
  const sent = [];
  let cloud = { paired: true, enabled: true, connected: true, hub: 'http://localhost:8787', profile: 'poplar', pairing: null, notice: '' };
  const { element, settle } = popupHarness(async (message) => {
    sent.push(message);
    if (message.type === 'bridge-state') return { count: 0, active: false, connected: true, profile: 'poplar', cloud };
    if (message.type === 'cloud-toggle') cloud = { ...cloud, enabled: message.enabled, connected: false };
    if (message.type === 'cloud-unpair') cloud = { ...cloud, paired: false, enabled: false };
    return { ok: true, ...cloud };
  }, { tab: { id: 7 } });
  await settle();
  assert.equal(element('cloud-status').textContent, 'Connected: Claude.ai and ChatGPT apps you add can use this browser', 'the switch says on; the line says what it means');
  assert.equal(element('cloud-off-hint').hidden, false, 'says what turning it off does');
  assert.equal(element('cloud-help').hidden, true);
  await element('cloud-add').handlers.click();
  assert.equal(element('cloud-help').hidden, false, 'Add to Claude or ChatGPT shows where the link goes');
  assert.equal(element('cloud-enabled').checked, true);
  assert.equal(element('cloud-pair-row').hidden, true, 'a paired profile shows no address form');
  assert.equal(element('cloud-paired').hidden, false);
  element('cloud-enabled').checked = false;
  await element('cloud-enabled').handlers.change();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { type: 'cloud-unpair' }, 'off = sign out: one control, no separate sign-out button');
  assert.equal(element('cloud-status').textContent, 'Let Claude.ai or ChatGPT use this browser');
  assert.equal(element('cloud-enabled').checked, false);
  assert.equal(element('cloud-pair-row').hidden, true);
  assert.equal(element('cloud-paired').hidden, true);
  // On again: the address form, prefilled with the last address.
  element('cloud-enabled').checked = true;
  await element('cloud-enabled').handlers.change();
  assert.equal(element('cloud-pair-row').hidden, false);
  assert.equal(element('cloud-hub').value, 'http://localhost:8787');
});

test('popup Cloud AI apps: a profile paused by an older version reconnects with its token when switched on', async () => {
  const sent = [];
  let cloud = { paired: true, enabled: false, connected: false, hub: 'http://localhost:8787', profile: 'poplar', pairing: null, notice: '' };
  const { element, settle } = popupHarness(async (m) => {
    sent.push(m);
    if (m.type === 'bridge-state') return { count: 0, active: false, connected: true, profile: 'poplar', cloud };
    if (m.type === 'cloud-toggle') cloud = { ...cloud, enabled: m.enabled, connected: true };
    return { ok: true, ...cloud };
  }, { tab: { id: 7 } });
  await settle();
  assert.equal(element('cloud-enabled').checked, false);
  element('cloud-enabled').checked = true;
  await element('cloud-enabled').handlers.change();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { type: 'cloud-toggle', enabled: true });
  assert.equal(element('cloud-status').textContent, 'Connected: Claude.ai and ChatGPT apps you add can use this browser');
});

test('popup: Stop stays reachable when the local helper is down or reconnecting (review finding)', async () => {
  for (const variant of ['down', 'reconnecting']) {
    const { element, settle } = popupHarness(async (m) => (m.type === 'bridge-state' ? { count: 2, active: true, connected: variant !== 'reconnecting', profile: 'poplar' } : {}), { tab: { id: 7 }, healthDown: variant === 'down' });
    await settle();
    assert.equal(element('stop-row').hidden, false, variant);
    assert.equal(element('release-all').title, 'Stop the agent in all 2 tabs');
    assert.equal(element('release-tab').hidden, false, `${variant}: this tab is driven — Stop this tab shows too`);
    assert.equal(element('status-text').textContent, variant === 'down' ? 'Not connected to an AI agent' : 'Reconnecting to your AI agent…');
    assert.equal(element('idle').hidden, variant === 'down', 'reconnecting is a blip: the tab ID stays copyable');
  }
});

test('popup diagnostic logs: details show only while logging is on; Delete stays for old records', async () => {
  for (const [enabled, bytes, details, del, line] of [
    [true, 9_300_000, false, false, 'Using 8.9 of 10 MB'],
    [false, 2_400_000, true, false, '2.3 MB of older logs kept'],
    [false, 0, true, true, 'Local files that help debug problems'],
  ]) {
    const { element, open } = popupHarness(async () => ({ ok: true, result: { enabled, limitMiB: 10, bytes, directory: '/local/logs', error: null } }));
    await open();
    assert.equal(element('logging-details').hidden, details, `enabled=${enabled}: size limit and folder`);
    assert.equal(element('logging-delete').hidden, del, `bytes=${bytes}: Delete logs…`);
    assert.equal(element('logging-status').textContent, line);
  }
});

test('popup: the stop links live outside the cards that hide by state (review finding)', () => {
  const html = fs.readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
  for (const card of ['idle', 'setup-card', 'update']) {
    const start = html.indexOf(`<div id="${card}"`);
    const block = html.slice(start, html.indexOf('\n  </div>', start));
    assert.doesNotMatch(block, /id="(release-tab|release-all|stop-row)"/, `a stop control inside #${card} hides with it`);
  }
});

test('popup: cloud-only (no local helper) is a complete setup, not "not connected" (review finding)', async () => {
  const cloud = { paired: true, enabled: true, connected: true, hub: 'https://cb.example', profile: 'poplar', pairing: null, notice: '' };
  for (const [count, status] of [[2, 'AI is working in 2 tabs'], [0, 'Ready for cloud AI apps']]) {
    const { element, settle } = popupHarness(async (m) => (m.type === 'bridge-state' ? { count, active: true, connected: false, profile: 'poplar', cloud } : {}), { tab: { id: 7 }, healthDown: true });
    await settle();
    assert.equal(element('status-text').textContent, status);
    assert.equal(element('setup-card').hidden, true, 'no push to install a local helper');
    assert.equal(element('idle').hidden, false, 'the tab ID works for cloud AI apps too');
    assert.equal(element('stop-row').hidden, count === 0);
    assert.match(element('local-status').textContent, /isn't running/);
  }
});

test('popup: Settings says local agents are connected only when this profile really is (review finding)', async () => {
  for (const [health, connected] of [[{ ok: true, extension: false }, true], [{ ok: true, extension: true }, false]]) {
    const { element, settle } = popupHarness(async (m) => (m.type === 'bridge-state' ? { count: 0, active: false, connected, profile: 'poplar' } : {}), { tab: { id: 7 }, health });
    await settle();
    assert.equal(element('local-status').textContent, 'Connecting to the helper on this computer…');
  }
});

test('popup Cloud access: a failed Connect keeps the address form open (review finding)', async () => {
  const cloud = { paired: false, enabled: false, connected: false, hub: '', profile: 'poplar', pairing: null, notice: '' };
  const { element, settle } = popupHarness(async (m) => (m.type === 'bridge-state' ? { count: 0, active: false, connected: true, profile: 'poplar', cloud } : { ok: false, error: 'Could not reach the hub: Failed to fetch', ...cloud }), { tab: { id: 7 } });
  await settle();
  element('cloud-enabled').checked = true;
  element('cloud-enabled').handlers.change();
  element('cloud-hub').value = 'http://typo.example';
  await element('cloud-pair').handlers.click();
  assert.equal(element('cloud-pair-row').hidden, false, 'fix the typo and press Connect again');
  assert.equal(element('cloud-enabled').checked, true);
  assert.match(element('cloud-status').textContent, /^Could not reach the hub/);
});

test('popup diagnostic logs: the switch saves at once, keeping the limit', async () => {
  const sent = [];
  const settings = { enabled: false, limitMiB: 25, bytes: 0, directory: '/local/logs', error: null };
  const { element, open } = popupHarness(async (m) => {
    sent.push(m);
    if (m.action === 'configure') Object.assign(settings, { enabled: m.enabled, limitMiB: m.limitMiB });
    return { ok: true, result: { ...settings } };
  });
  await open();
  assert.equal(element('main').hidden, true);
  assert.equal(element('settings-view').hidden, false);
  element('log-limit').value = '0'; // unsaved and invalid in Details: must not block or ride along (review finding)
  element('logging-enabled').checked = true;
  await element('logging-enabled').handlers.change();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { type: 'diagnostics', action: 'configure', enabled: true, limitMiB: 25 });
  assert.equal(element('logging-status').textContent, 'Using 0 of 25 MB', 'the switch says on; the line says how much is used');
  element('log-limit').value = '30';
  await element('log-limit').handlers.change();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { type: 'diagnostics', action: 'configure', enabled: true, limitMiB: 30 }, 'the limit saves itself on change: no Save button');
  assert.equal(element('logging-status').textContent, 'Using 0 of 30 MB');
  element('close-settings').handlers.click();
  assert.equal(element('main').hidden, false);
  assert.equal(element('settings-view').hidden, true);
});

test('popup Cloud Bridge: an older worker without cloud state leaves the section untouched', async () => {
  const { element, settle } = popupHarness(async (message) => (message.type === 'bridge-state' ? { count: 0, active: false, connected: true } : {}), { tab: { id: 7 } });
  await settle();
  assert.equal(element('cloud-status').textContent, undefined, 'no claim about a link the worker did not describe');
});

test('popup Remove Chrome Bridge: the uninstall prompt names this checkout; the extension removes itself with Chrome\'s confirm', async () => {
  let copied = '';
  const { element, settle } = popupHarness(async (m) => (m.type === 'bridge-state' ? { count: 0, active: false, connected: true, profile: 'poplar' } : {}), {
    tab: { id: 7 }, health: { ok: true, extension: true, repo: '/home/u/chrome-bridge/' }, clipboard: { writeText: async (t) => { copied = t; } },
  });
  await settle();
  await element('copy-uninstall').handlers.click();
  await settle();
  assert.match(copied, /^Uninstall chrome-bridge from this computer\. Run node "\/home\/u\/chrome-bridge\/cli\.mjs" uninstall and show me what it lists\. Once I agree, run it again with --yes/);
  assert.equal(element('remove-status').textContent, 'Copied ✓ — paste it into your AI agent');
  element('remove-extension').handlers.click();
  assert.equal(element('remove-status').textContent, 'Open chrome://extensions and click Remove on Chrome Bridge.', 'no management API in this harness: the fallback names the manual step');
});

test('popup Remove extension asks Chrome to uninstall it with its own confirm dialog', async () => {
  const calls = [];
  const { element, settle } = popupHarness(async () => ({ count: 0, active: false, connected: true }), { tab: { id: 7 }, management: { uninstallSelf: async (o) => { calls.push(o); throw new Error('user cancelled'); } } });
  await settle();
  element('remove-extension').handlers.click();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ showConfirmDialog: true }]);
  assert.equal(element('remove-status').textContent, undefined, 'Cancel in Chrome\'s dialog: nothing to report');
});
