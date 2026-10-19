import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index';
import { scheduled } from '../worker/scheduler';
import { validateSubscription } from '../worker/push';
import { DEFAULTS, jstDate } from '../shared/model';
import { database, fixtureEnv, fixtureSubscription } from './helpers';

test('API requires a private key, exact CORS origin and valid bounded JSON', async () => {
  const { db } = database(); const env = fixtureEnv(db);
  const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://worker.example/api/${path}`, init), env);
  assert.equal((await call('state')).status, 401);
  assert.equal((await call('state', { headers: { Origin: 'https://evil.example', Authorization: `Bearer ${env.OWNER_TOKEN}` } })).status, 403);
  const preflight = await call('state', { method: 'OPTIONS', headers: { Origin: env.APP_ORIGIN } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), env.APP_ORIGIN);
  const headers = { Authorization: `Bearer ${env.OWNER_TOKEN}`, 'Content-Type': 'application/json' };
  let response = await call('state', { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const state = await response.json();
  assert.equal(state.source.status, 'waiting');
  assert.equal(state.preferences.favorites.length, 6);
  assert.ok(!JSON.stringify(state).includes(env.OWNER_TOKEN!));
  response = await call('preferences', { method: 'PUT', headers, body: JSON.stringify({ preferences: DEFAULTS, revision: 1 }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revision, 2);
  assert.equal((await call('preferences', { method: 'PUT', headers, body: JSON.stringify({ preferences: DEFAULTS, revision: 1 }) })).status, 409);
  assert.equal((await call('preferences', { method: 'PUT', headers, body: 'not json' })).status, 400);
  assert.equal((await call('preferences', { method: 'PUT', headers, body: 'x'.repeat(32769) })).status, 413);
});

test('unconfigured API is explicit rather than reporting no broadcast', async () => {
  const { db } = database(); const env = fixtureEnv(db); delete env.NHK_API_KEY;
  const response = await worker.fetch(new Request('https://worker.example/api/state', { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env);
  assert.equal((await response.json()).source.status, 'unconfigured');
});

test('push allowlist rejects SSRF, lookalike hosts and invalid public keys', () => {
  const sub = fixtureSubscription();
  assert.deepEqual(validateSubscription(sub), sub);
  for (const endpoint of ['http://127.0.0.1/private', 'https://web.push.apple.com.evil.example/foo', 'https://fcm.googleapis.com@evil.example/x', 'https://example.com/']) {
    assert.throws(() => validateSubscription({ ...sub, endpoint }));
  }
  assert.throws(() => validateSubscription({ ...sub, keys: { ...sub.keys, p256dh: 'invalid' } }));
});

test('subscription registration, encrypted test push, throttling, expiry and deletion', async t => {
  const { db } = database(); const env = fixtureEnv(db);
  const headers = { Authorization: `Bearer ${env.OWNER_TOKEN}`, 'Content-Type': 'application/json' };
  const call = (path: string, method: string, body?: unknown) => worker.fetch(new Request(`https://worker.example/api/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  await call('state', 'GET');
  const sub = fixtureSubscription();
  assert.equal((await call('subscription', 'PUT', { id: 'test-device-123', subscription: sub })).status, 200);
  let expired = false;
  const send = t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers!['Content-Encoding' as keyof HeadersInit] ?? (options.headers as Record<string, string>)['Content-Encoding'] ?? (options.headers as Record<string, string>)['content-encoding'], 'aes128gcm');
    assert.ok((options.body as Uint8Array).length > 100);
    return new Response(null, { status: expired ? 410 : 201 });
  });
  assert.equal((await call('test-push', 'POST', { id: 'test-device-123' })).status, 200);
  assert.equal(send.mock.callCount(), 1);
  assert.equal((await call('test-push', 'POST', { id: 'test-device-123' })).status, 429);
  await db.prepare('UPDATE settings SET last_test_at = 0').run();
  expired = true;
  assert.equal((await call('test-push', 'POST', { id: 'test-device-123' })).status, 410);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM subscriptions').first<{ n: number }>())!.n, 0);
  assert.equal((await call('subscription', 'DELETE', { id: 'test-device-123' })).status, 200);
  send.mock.restore();
});

test('eight staggered polls create only one notification per slot, shifts replace pending revisions, and failures stay explicit', async t => {
  const store = database(); const { db } = store; const env = fixtureEnv(db);
  const base = new Date(); base.setUTCMinutes(0, 0, 0);
  const minutes = [2, 9, 16, 23, 30, 37, 44, 51];
  let offset = 0;
  let failDate = '';
  let nhkRequests = 0;
  let pushRequests = 0;
  let failPush = false;
  t.mock.method(globalThis, 'fetch', async (input: string | URL) => {
    const url = new URL(input);
    if (url.hostname === 'program-api.nhk.jp') {
      nhkRequests++;
      assert.equal(url.searchParams.get('area'), '140');
      assert.equal(url.searchParams.get('service'), 'tv');
      const date = url.searchParams.get('date')!;
      if (date === failDate) return new Response(null, { status: 503 });
      const start = Date.parse(`${date}T21:00:00+09:00`) + offset;
      const event = { name: '地球ドラマチック テスト番組', startDate: new Date(start).toISOString(), endDate: new Date(start + 3600_000).toISOString() };
      return Response.json({ g1: { publication: [] }, g2: { publication: [] }, e1: { publication: [event] }, e3: { publication: [] } });
    }
    assert.equal(url.hostname, 'web.push.apple.com');
    pushRequests++;
    return new Response(null, { status: failPush ? 503 : 201 });
  });
  const sub = fixtureSubscription();
  await db.prepare('INSERT INTO subscriptions VALUES (?, ?, ?, ?)').bind('device-123456', sub.endpoint, JSON.stringify(sub), Date.now()).run();
  for (const minute of minutes) {
    store.resetQueries();
    await scheduled(env, base.getTime() + minute * 60_000);
    assert.ok(store.queries < 50, `D1 Free query limit: ${store.queries}`);
  }
  assert.equal(nhkRequests, 8);
  const count = (await db.prepare('SELECT COUNT(*) AS n FROM broadcasts').first<{ n: number }>())!.n;
  assert.ok(count >= 7);
  assert.equal(pushRequests, 3);
  assert.equal((await db.prepare('SELECT status FROM source_status').first<{ status: string }>())!.status, 'ok');
  await scheduled(env, base.getTime() + 51 * 60_000);
  assert.equal(nhkRequests, 8, 'duplicate cron does not consume NHK quota');
  for (const minute of minutes) await scheduled(env, base.getTime() + 3600_000 + minute * 60_000);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM deliveries').first<{ n: number }>())!.n, count);
  const preserved = await db.prepare('SELECT id FROM broadcasts LIMIT 1').first<{ id: string }>();
  offset = 30 * 60_000;
  failDate = jstDate(base.getTime() + 3 * 86400_000);
  failPush = true;
  for (const minute of minutes) await scheduled(env, base.getTime() + 2 * 3600_000 + minute * 60_000);
  assert.equal((await db.prepare('SELECT status FROM source_status').first<{ status: string }>())!.status, 'partial');
  assert.ok(await db.prepare('SELECT id FROM broadcasts WHERE id = ?').bind(preserved!.id).first());
  const changed = await db.prepare('SELECT COUNT(*) AS n FROM broadcasts WHERE revision = 2').first<{ n: number }>();
  assert.ok(changed!.n > 0);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM deliveries d JOIN broadcasts b ON b.id=d.broadcast_id WHERE d.status='pending' AND d.revision != b.revision`).first<{ n: number }>())!.n, 0);
  assert.ok((await db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE status='pending' AND attempts > 0`).first<{ n: number }>())!.n > 0);
});
