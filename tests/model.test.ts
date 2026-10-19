import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, matchesTitle, jstDate, officialUrl, validatePreferences } from '../shared/model';
import { parseNhk, pollSlot } from '../worker/nhk';
import { reconcile } from '../worker/reconcile';
import type { Broadcast } from '../shared/model';

const now = Date.parse('2026-01-10T01:00:00Z');
const fixture = (start = '2026-01-11T12:00:00+09:00', id = 'a'): Broadcast => ({
  id, favoriteId: 'dramatic', title: '地球ドラマチック テスト回', channel: 'e1',
  start: new Date(start).toISOString(), end: new Date(Date.parse(start) + 3600_000).toISOString(),
  queryDate: '2026-01-11', url: DEFAULTS.favorites[1].url, verifiedAt: now, revision: 1, change: 'new',
});

test('matches Japanese full-width punctuation, whitespace and rerun suffixes', () => {
  assert.ok(matchesTitle('弾丸！ 空港トンボがえりツアー [再]', DEFAULTS.favorites[0].title));
  assert.ok(matchesTitle('世界ふれあい街歩き 選', '世界ふれあい街歩き'));
  assert.ok(!matchesTitle('別の番組', '鉄オタ選手権'));
});

test('validates official URLs, selected channels and unique favorite IDs', () => {
  assert.deepEqual(validatePreferences(DEFAULTS), DEFAULTS);
  for (const url of ['javascript:alert(1)', 'https://nhk.jp.evil.example/', 'https://user@nhk.jp/', 'https://nhk.jp:4433/']) assert.ok(!officialUrl(url, 'nhk'));
  assert.ok(officialUrl('https://www.web.nhk/tv/', 'nhk'));
  assert.throws(() => validatePreferences({ ...DEFAULTS, channels: [] }));
  assert.throws(() => validatePreferences({ ...DEFAULTS, channels: ['constructor'] }));
  assert.throws(() => validatePreferences({ ...DEFAULTS, favorites: [...DEFAULTS.favorites, DEFAULTS.favorites[0]] }));
  assert.throws(() => validatePreferences({ ...DEFAULTS, favorites: [{ ...DEFAULTS.favorites[0], title: '！！' }] }));
});

test('poll dates use JST at the midnight boundary and eight date offsets', () => {
  assert.equal(jstDate(Date.parse('2026-01-10T15:00:00Z')), '2026-01-11');
  assert.deepEqual(pollSlot(Date.parse('2026-01-10T15:51:00Z')), { cycle: '2026-01-10T15', part: 7, date: '2026-01-18' });
  assert.throws(() => pollSlot(Date.parse('2026-01-10T15:00:00Z')));
});

test('parses v3 service/publication data without storing description or archive data', () => {
  const f = fixture();
  const data = { e1: { publication: [{ name: `${f.title} [再]`, startDate: f.start, endDate: f.end, description: 'DO NOT STORE' }] } };
  const result = parseNhk(data, f.queryDate, { ...DEFAULTS, channels: ['e1'] }, now);
  assert.equal(result.length, 1);
  assert.equal(result[0].favoriteId, 'dramatic');
  assert.ok(!JSON.stringify(result).includes('DO NOT STORE'));
  assert.equal(parseNhk(data, f.queryDate, { ...DEFAULTS, channels: ['e1'] }, Date.parse(f.end)).length, 0);
  assert.throws(() => parseNhk({ error: 'upstream error' }, f.queryDate, DEFAULTS, now));
  assert.throws(() => parseNhk({ e1: {} }, f.queryDate, { ...DEFAULTS, channels: ['e1'] }, now));
  assert.throws(() => parseNhk({ e1: { publication: [{ name: '地球ドラマチック', startDate: '2026-01-11T12:00:00', endDate: f.end }] } }, f.queryDate, { ...DEFAULTS, channels: ['e1'] }, now));
});

test('identical simulcasts on subchannels are deduplicated without losing distinct broadcasts', () => {
  const f = fixture();
  const event = { name: f.title, startDate: f.start, endDate: f.end };
  const data = Object.fromEntries(['g1', 'g2', 'e1', 'e3', 's1', 's2', 's5'].map(channel => [channel, { publication: [event] }]));
  const prefs = { ...DEFAULTS, channels: ['g1', 'g2', 'e1', 'e3', 's1', 's2', 's5'] as const };
  const selected = { ...prefs, channels: [...prefs.channels] };
  assert.deepEqual(parseNhk(data, f.queryDate, selected, now).map(b => b.channel), ['g1', 'e1', 's1', 's5']);
  assert.equal(parseNhk(data, f.queryDate, { ...DEFAULTS, channels: ['e3'] }, now)[0].channel, 'e3');
  data.e3.publication = [{ ...event, name: '地球ドラマチック 別のエピソード' }];
  assert.equal(parseNhk(data, f.queryDate, DEFAULTS, now).length, 3);
  data.e3.publication = [{ ...event, startDate: new Date(Date.parse(f.start) + 60_000).toISOString() }];
  assert.equal(parseNhk(data, f.queryDate, DEFAULTS, now).length, 3);
  data.e3.publication = [{ ...event, endDate: new Date(Date.parse(f.end) + 60_000).toISOString() }];
  assert.equal(parseNhk(data, f.queryDate, DEFAULTS, now).length, 3);
});

test('repeated slots and duplicate API rows do not create repeat notifications', () => {
  const a = fixture();
  const result = reconcile([a], [fixture(a.start, 'b'), fixture(a.start, 'c')], [a.queryDate], now);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].id, 'a');
  assert.equal(result.notify.length, 0);
});

test('a distinct rerun is new, while a unique shifted slot preserves identity', () => {
  const a = fixture();
  const rerun = fixture('2026-01-11T16:00:00+09:00', 'rerun');
  let result = reconcile([a], [fixture(), rerun], [a.queryDate], now);
  assert.equal(result.notify.length, 1);
  assert.equal(result.notify[0].id, 'rerun');
  result = reconcile([a], [fixture('2026-01-11T12:30:00+09:00', 'shifted')], [a.queryDate], now);
  assert.equal(result.notify[0].id, 'a');
  assert.equal(result.notify[0].revision, 2);
  assert.equal(result.notify[0].change, 'changed');
  const shifted = result.events[0];
  assert.equal(reconcile([shifted], [fixture(shifted.start, 'later')], [a.queryDate], now).notify.length, 0);
});

test('ambiguous multiple reruns are not silently collapsed into a single change', () => {
  const a = fixture();
  const b = fixture('2026-01-11T14:00:00+09:00', 'b');
  const result = reconcile([a, b], [fixture('2026-01-11T16:00:00+09:00', 'new')], [a.queryDate], now);
  assert.equal(result.notify[0].change, 'new');
  assert.equal(result.removed.length, 2);
});

test('failed query dates preserve prior slots instead of pretending they were cancelled', () => {
  const a = fixture();
  assert.deepEqual(reconcile([a], [], ['2026-01-12'], now).events, [a]);
  assert.equal(reconcile([a], [], ['2026-01-12'], now).removed.length, 0);
  assert.equal(reconcile([a], [], [a.queryDate], now).removed.length, 1);
});
