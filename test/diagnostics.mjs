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
    const text = fs.readFileSync(join(directory, 'events.jsonl'), 'utf8');
    const events = text.trim().split('\n').map(JSON.parse);
    assert.equal(text.includes(secret), false);
    assert.equal(events[1].id, events[2].id);
    assert.equal(events[2].outcome.verdict, 'uncertain');
    assert.equal(events[3].outcome.errorCode, 'syntax_error');
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

test('popup setup restarts fetched code and reloads stale extensions', () => {
  const prompt = fs.readFileSync(new URL('../extension/setup-prompt.txt', import.meta.url), 'utf8');
  assert.match(prompt, /cli\.mjs stop && node ~\/chrome-bridge\/cli\.mjs start/);
  assert.match(prompt, /cli\.mjs extreload/);
  assert.match(prompt, /Preserve existing diagnostic logs and settings/);
});

function popupHarness(sendMessage, { tab, health = { ok: true, extension: true } } = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', checked: false, hidden: true, handlers: {}, addEventListener(type, handler) { this.handlers[type] = handler; } });
    return elements.get(id);
  };
  vm.runInNewContext(fs.readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8'), {
    document: { getElementById: element },
    fetch: async () => ({ json: async () => health }),
    AbortSignal,
    chrome: { tabs: { query: async () => tab ? [tab] : [] }, runtime: { sendMessage } },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const open = async () => {
    element('settings').open = true;
    element('settings').handlers.toggle();
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
  await element('logging-form').handlers.submit({ preventDefault() {} });
  assert.equal(settings.enabled, true);
  assert.equal(settings.limitMiB, 25);
  element('log-limit').value = '0';
  await element('logging-form').handlers.submit({ preventDefault() {} });
  assert.equal(requests.length, 2);
  element('logging-delete').handlers.click();
  assert.equal(element('logging-confirmation').hidden, false);
  assert.equal(settings.bytes, 500);
  await element('logging-confirm').handlers.click();
  assert.equal(settings.bytes, 0);
  assert.equal(element('logging-delete').disabled, true);
  offline = true;
  element('settings').handlers.toggle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(element('logging-status').textContent, /unavailable/);
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
      if (action === 'configure') await element('logging-form').handlers.submit({ preventDefault() {} });
      else await element('logging-confirm').handlers.click();
      assert.deepEqual(requests, ['status', action, 'status']);
      assert.equal(element('logging-enabled').checked, settings.enabled);
      assert.equal(element('log-limit').value, String(settings.limitMiB));
      assert.equal(element('logging-delete').disabled, settings.bytes === 0);
      assert.equal(element('logging-save').disabled, false);
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
    await element('logging-form').handlers.submit({ preventDefault() {} });
    assert.equal(element('logging-enabled').indeterminate, true);
    assert.match(element('logging-status').textContent, /unknown.*unavailable/i);
    assert.doesNotMatch(element('logging-status').textContent, /private|\bOn\b|\bOff\b/);
    for (const id of ['logging-enabled', 'log-limit', 'logging-save', 'logging-delete', 'logging-confirm']) assert.equal(element(id).disabled, true, id);
    assert.equal(element('logging-retry').hidden, false);
    assert.equal(element('logging-retry').disabled, false);
    offline = false;
    if (recovery === 'retry') await element('logging-retry').handlers.click();
    else {
      element('settings').open = false;
      element('settings').handlers.toggle();
      await open();
    }
    assert.equal(element('logging-enabled').indeterminate, false);
    assert.equal(element('logging-enabled').checked, false);
    assert.equal(element('log-limit').value, '25');
    assert.equal(element('logging-save').disabled, false);
    assert.equal(element('logging-retry').hidden, true);
    offline = true;
    await open();
    assert.equal(element('logging-enabled').indeterminate, true);
    assert.equal(element('logging-save').disabled, true);
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
  await element('release-tab').handlers.click();
  assert.equal(element('driven').hidden, false);
  assert.match(element('driven-count').textContent, /1 tab driven/);
  assert.equal(element('release-tab').hidden, true);
  assert.equal(element('release-all').hidden, false);
  assert.match(element('release-all').textContent, /this profile/);
  await element('release-all').handlers.click();
  assert.equal(element('driven').hidden, true);
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
    assert.match(element('status').textContent, /Release failed/);
    assert.doesNotMatch(element('status').textContent, /Released/);
    assert.equal(element('driven').hidden, false);
    assert.equal(element('release-all').disabled, false);
    if (failure !== 'refresh') assert.match(element('driven-count').textContent, /1 tab driven/);
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