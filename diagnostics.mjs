import fs from 'node:fs';
import crypto from 'node:crypto';
import { join } from 'node:path';

const COMMANDS = new Set('open navigate close mark release activate unemulate tabs doctor swlogs extreload snap click drag dialog fill clear type paste press hover scroll upload fetch ask wait eval shot net perf measure console grid note emulate resize swipe health profiles start stop watch history batch'.split(' '));
const ERROR_CODES = [
  ['tab_missing', /no tab with id:|no tab matching/],
  ['tab_ambiguous', /tabs match|matches tabs in|multiple profiles|several profiles/],
  ['tab_hidden', /tab is hidden|occluded|foreground|minimized/],
  ['page_restricted', /off-limits|blocks cross-extension|cannot access/i],
  ['human_reclaimed', /human released/],
  ['timeout_after_dispatch', /timeout after dispatch/],
  ['timeout_before_dispatch', /timeout before dispatch/],
  ['disconnected', /not connected|disconnected|server not running|dropped the connection/],
  ['timeout', /timeout|timed out/i],
  ['target_stale', /re-snap|refs expire|now resolves to|removed or hid|re-rendered since the snap/],
  ['target_missing', /not found|no element matches|no text field/],
  ['target_covered', /covered by/],
  ['unknown_command', /unknown type|unknown command/],
  ['invalid_arguments', /usage:|unknown argument|unknown flag|needs an id|needs numeric/],
  ['syntax_error', /SyntaxError/],
  ['type_error', /TypeError/],
  ['dialog_missing', /No dialog is showing/],
  ['unresponsive', /^unresponsive$/],
];

export function createDiagnostics(directory, version) {
  const configPath = join(directory, 'settings.json');
  const files = [join(directory, 'events.1.jsonl'), join(directory, 'events.jsonl')];
  const boot = crypto.randomUUID();
  let sequence = 0;
  let generation = 0;
  let error = null;
  let droppedRecords = 0;
  let recoveredTails = 0;
  let recoveredBytes = 0;
  let needsRepair = true;
  let settings = { enabled: false, limitMiB: 10, key: crypto.randomBytes(32).toString('hex') };
  try {
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (typeof saved.enabled !== 'boolean' || !Number.isInteger(saved.limitMiB) || saved.limitMiB < 1 || saved.limitMiB > 100 || !/^[a-f0-9]{64}$/.test(saved.key)) throw new Error('invalid_settings');
    settings = saved;
  } catch (cause) {
    if (cause.code !== 'ENOENT') error = 'settings_unreadable';
  }
  const fingerprint = (value) => crypto.createHmac('sha256', settings.key).update(typeof value === 'string' ? value : '').digest('hex').slice(0, 24);
  const textShape = (value) => typeof value === 'string' ? { chars: value.length, fingerprint: fingerprint(value) } : undefined;
  const size = (file) => {
    try { return fs.statSync(file).size; } catch (cause) { if (cause.code === 'ENOENT') return 0; throw cause; }
  };
  const repairTails = () => {
    if (!needsRepair) return;
    for (const file of files) {
      let descriptor;
      try { descriptor = fs.openSync(file, 'r+'); } catch (cause) { if (cause.code === 'ENOENT') continue; throw cause; }
      try {
        fs.fchmodSync(descriptor, 0o600);
        const bytes = fs.fstatSync(descriptor).size;
        const buffer = Buffer.alloc(4096);
        let boundary = bytes;
        while (boundary > 0) {
          const start = Math.max(0, boundary - buffer.length);
          const length = boundary - start;
          const read = fs.readSync(descriptor, buffer, 0, length, start);
          if (read !== length) throw new Error('tail_read_incomplete');
          const newline = buffer.subarray(0, read).lastIndexOf(10);
          if (newline !== -1) { boundary = start + newline + 1; break; }
          boundary = start;
        }
        if (boundary < bytes) {
          fs.ftruncateSync(descriptor, boundary);
          recoveredTails++;
          recoveredBytes += bytes - boundary;
        }
      } finally {
        fs.closeSync(descriptor);
      }
    }
    needsRepair = false;
  };
  if (settings.enabled) {
    try { repairTails(); } catch (cause) { error = cause.code || 'repair_failed'; }
  }
  const status = () => {
    let bytes = null;
    try { bytes = files.reduce((total, file) => total + size(file), 0); } catch { error = 'storage_unreadable'; }
    return { enabled: settings.enabled, limitMiB: settings.limitMiB, bytes, directory, error, droppedRecords, recoveredTails, recoveredBytes };
  };
  const write = (event) => {
    if (!settings.enabled) return;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      repairTails();
      const line = JSON.stringify({ schema: 1, timestamp: new Date().toISOString(), boot, sequence: ++sequence, version, ...event }) + '\n';
      const half = Math.floor(settings.limitMiB * 1024 * 1024 / 2);
      if (Buffer.byteLength(line) > half) throw new Error('record_too_large');
      if (size(files[1]) + Buffer.byteLength(line) > half) {
        fs.rmSync(files[0], { force: true });
        if (size(files[1])) fs.renameSync(files[1], files[0]);
      }
      fs.appendFileSync(files[1], line, { mode: 0o600 });
      error = null;
    } catch (cause) {
      droppedRecords++;
      needsRepair = true;
      error = cause.code || 'write_failed';
    }
  };
  const configure = (input) => {
    if (typeof input?.enabled !== 'boolean' || !Number.isInteger(input.limitMiB) || input.limitMiB < 1 || input.limitMiB > 100) throw new Error('Logging requires enabled (boolean) and limitMiB (integer, 1-100).');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const next = { ...settings, enabled: input.enabled, limitMiB: input.limitMiB };
    const temporary = configPath + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(next) + '\n', { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, configPath);
    settings = next;
    generation++;
    const half = settings.limitMiB * 1024 * 1024 / 2;
    for (const file of files) if (size(file) > half) fs.rmSync(file);
    error = null;
    write({ event: 'settings', enabled: settings.enabled, limitMiB: settings.limitMiB });
    return status();
  };
  const command = (msg) => {
    const name = typeof msg?.type === 'string' ? msg.type : '';
    const result = { name: COMMANDS.has(name) ? name : 'unknown', requested: COMMANDS.has(name) ? undefined : textShape(name) };
    for (const field of ['urlMatch', 'url', 'target', 'selector', 'scope', 'from', 'to', 'code', 'find', 'question', 'text', 'value', 'key']) {
      if (typeof msg?.[field] === 'string') result[field] = textShape(msg[field]);
    }
    if (typeof msg?.urlMatch === 'string') result.matchKind = /^id:\d+$/.test(msg.urlMatch) ? 'id' : 'substring';
    if (typeof msg?.target === 'string') result.targetKind = /^@e\d+$/.test(msg.target) ? 'ref' : 'selector';
    if (typeof msg?.url === 'string') {
      try { result.site = fingerprint(new URL(msg.url).origin); } catch {}
    }
    for (const field of ['diff', 'trusted', 'dbl', 'all', 'human', 'pixel', 'html', 'chooser', 'csrf', 'skeleton', 'href', 'full', 'mobile', 'focus', 'clear', 'ws', 'har', 'fix', 'accept']) {
      if (typeof msg?.[field] === 'boolean') result[field] = msg[field];
    }
    for (const field of ['timeout', 'duration', 'width', 'height', 'max', 'scale', 'quality', 'dsf']) {
      if (Number.isFinite(msg?.[field])) result[field] = msg[field];
    }
    if (Array.isArray(msg?.files)) result.fileCount = msg.files.length;
    if (typeof msg?.code === 'string') result.codeFeatures = ['querySelector', 'fetch', 'MutationObserver', 'getBoundingClientRect', 'textContent', 'click', 'focus'].filter((name) => msg.code.includes(name));
    return result;
  };
  const caller = (meta) => ({
    source: meta?.source === 'cli' ? 'cli' : 'http',
    invocation: typeof meta?.invocation === 'string' ? fingerprint(meta.invocation) : undefined,
    parent: typeof meta?.parent === 'string' ? fingerprint(meta.parent) : undefined,
    test: meta?.test === true,
  });
  const outcome = (out, msg) => {
    const result = out?.result;
    const summary = { ok: out?.ok === true, resultType: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result };
    if (typeof result === 'string') {
      summary.chars = result.length;
      summary.sampleLines = result.slice(0, 65536).split('\n').length;
      if (msg?.diff && ['click', 'drag', 'fill', 'clear', 'type', 'paste', 'press', 'hover', 'scroll', 'upload', 'navigate'].includes(msg.type)) summary.verdict = /^(succeeded|uncertain|needs_human|blocked) ·/.exec(result)?.[1];
    }
    if (Array.isArray(result)) {
      summary.items = result.length;
      if (['tabs', 'doctor'].includes(msg?.type)) {
        summary.failedRows = 0;
        summary.rowErrorCodes = {};
        for (const row of result) {
          if (typeof row?.profile !== 'string' || typeof row?.error !== 'string') continue;
          summary.failedRows++;
          const code = ERROR_CODES.find(([, pattern]) => pattern.test(row.error))?.[0] || 'other';
          summary.rowErrorCodes[code] = (summary.rowErrorCodes[code] || 0) + 1;
        }
      }
    }
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      for (const field of ['loaded', 'truncated', 'changed']) if (typeof result[field] === 'boolean') summary[field] = result[field];
      if (Number.isInteger(result.status) && result.status >= 100 && result.status <= 599) summary.httpStatus = result.status;
    }
    if (out?.ok !== true) {
      const message = typeof out?.error === 'string' ? out.error : 'unknown';
      summary.errorCode = ERROR_CODES.find(([, pattern]) => pattern.test(message))?.[0] || 'other';
      summary.error = textShape(message);
    }
    if (Array.isArray(out?.warn)) summary.warningCount = out.warn.length;
    return summary;
  };
  return {
    status,
    configure,
    clear() {
      generation++;
      for (const file of files) fs.rmSync(file, { force: true });
      error = null;
      return status();
    },
    start(msg, meta) {
      if (!settings.enabled) return null;
      const token = { id: crypto.randomUUID(), started: performance.now(), generation };
      write({ event: 'command_start', id: token.id, command: command(msg), caller: caller(meta) });
      return token;
    },
    finish(token, msg, out, extensionVersion) {
      if (!token || token.generation !== generation) return;
      write({ event: 'command_finish', id: token.id, durationMs: Math.round(performance.now() - token.started), profile: typeof msg?.profile === 'string' ? fingerprint(msg.profile) : undefined, extensionVersion: /^\d+\.\d+\.\d+$/.test(extensionVersion) ? extensionVersion : undefined, outcome: outcome(out, msg) });
    },
    client(msg, meta) {
      write({ event: 'cli_finish', command: command(msg), caller: caller(meta), durationMs: Number.isFinite(msg?.durationMs) ? Math.max(0, msg.durationMs) : undefined, outcome: outcome(msg, msg) });
    },
    lifecycle(msg, profile) {
      const known = ['self-release', 'mark', 'release', 'reap', 'boot', 'extreload', 'tab-closed', 'favicon-stuck', 'dbg-external-detach'];
      write({ event: 'tab', kind: known.includes(msg?.kind) ? msg.kind : 'other', tab: Number.isInteger(msg?.tabId) ? fingerprint('id:' + msg.tabId) : undefined, profile: fingerprint(profile) });
    },
  };
}