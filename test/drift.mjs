import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driftWarnings, updateTarget, versionNewer } from '../drift.mjs';

const base = { bootVersion: '1.30.6', diskVersion: '1.30.6', serverStale: false, manifestVersion: '1.30.6', extMtime: 0, seats: [] };

test('a pulled-but-not-restarted server warns, globally', () => {
  const w = driftWarnings({ ...base, diskVersion: '1.30.7' });
  assert.equal(w.length, 1);
  assert.equal(w[0].pid, null);
  assert.match(w[0].text, /runs 1\.30\.6 code but its checkout now has 1\.30\.7 — restart it: `cli\.mjs update`/);
  const same = driftWarnings({ ...base, serverStale: true });
  assert.match(same[0].text, /server code on disk changed after this server started/);
});

test('store seats: newer and older than the checkout both point at update', () => {
  const seats = [
    { pid: 'a', name: 'oak', v: '1.30.7', install: 'store' },
    { pid: 'b', name: 'elm', v: '1.30.5', install: 'store' },
    { pid: 'c', name: 'ash', v: '1.30.6', install: 'store' },
  ];
  const w = driftWarnings({ ...base, seats });
  assert.equal(w.length, 2);
  assert.deepEqual(w.map((x) => x.pid), ['a', 'b']);
  assert.match(w[0].text, /extension 1\.30\.7 \(Chrome Web Store, profile oak\) is newer than this bridge download \(1\.30\.6\) — run `cli\.mjs update`/);
  assert.match(w[1].text, /this bridge download \(1\.30\.6\) is ahead of the Chrome Web Store extension 1\.30\.5 \(profile elm\)/);
  assert.ok(w.every((x) => !x.text.includes('extreload')));
});

test('dev seats: version mismatch beats mtime; --profile only when several are connected', () => {
  const one = driftWarnings({ ...base, seats: [{ pid: 'a', name: 'oak', v: '1.30.5', install: 'dev', boot: 1 }] });
  assert.match(one[0].text, /extension 1\.30\.5 is loaded \(profile oak\), the repo has 1\.30\.6 — run `cli\.mjs extreload`/);
  const two = driftWarnings({
    ...base,
    extMtime: 10_000,
    seats: [
      { pid: 'a', name: 'oak', v: '1.30.6', install: 'dev', boot: 1 },
      { pid: 'b', name: 'elm', v: '1.30.6', install: 'dev', boot: 20_000 },
    ],
  });
  assert.equal(two.length, 1);
  assert.match(two[0].text, /code on disk changed .* `cli\.mjs extreload --profile "oak"`/);
});

test('update targets: store pins to its tag, unpacked or mixed follows the branch, none refuses', () => {
  assert.deepEqual(updateTarget([{ v: '1.30.4', install: 'store' }, { v: '1.30.5', install: 'store' }]), { target: 'tag', tag: 'v1.30.5' });
  assert.deepEqual(updateTarget([{ v: '1.30.6', install: 'dev' }]), { target: 'branch' });
  const mixed = updateTarget([{ v: '1.30.6', install: 'dev' }, { v: '1.30.4', install: 'store' }]);
  assert.equal(mixed.target, 'branch');
  assert.match(mixed.note, /unpacked build loads from this checkout/);
  assert.match(updateTarget([]).error, /no extension connected/);
});

test('versionNewer compares numerically', () => {
  assert.equal(versionNewer('1.30.10', '1.30.9'), true);
  assert.equal(versionNewer('1.30.5', '1.30.5'), false);
  assert.equal(versionNewer('1.29.9', '1.30.0'), false);
});
