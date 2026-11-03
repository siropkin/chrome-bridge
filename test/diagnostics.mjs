import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { createDiagnostics } from '../diagnostics.mjs';
import vm from 'node:vm';

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

test('popup settings save, validate, confirm deletion, and surface unavailable servers', async () => {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', checked: false, hidden: true, handlers: {}, addEventListener(type, handler) { this.handlers[type] = handler; } });
    return elements.get(id);
  };
  let settings = { enabled: false, limitMiB: 10, bytes: 500, directory: '/local/logs', error: null };
  let offline = false;
  const requests = [];
  vm.runInNewContext(fs.readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8'), {
    document: { getElementById: element },
    fetch: async () => ({ json: async () => ({ ok: true, extension: true }) }),
    AbortSignal,
    chrome: { tabs: { query: async () => [] }, runtime: { sendMessage: async (msg) => {
      requests.push(msg);
      if (offline) return { ok: false, error: 'Settings unavailable' };
      if (msg.action === 'configure') settings = { ...settings, enabled: msg.enabled, limitMiB: msg.limitMiB };
      if (msg.action === 'clear') settings.bytes = 0;
      return { ok: true, result: { ...settings } };
    } } },
  });
  element('settings').open = true;
  element('settings').handlers.toggle();
  await new Promise((resolve) => setImmediate(resolve));
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