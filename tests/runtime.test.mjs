import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createECDH, randomBytes } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import webPush from 'web-push';

test('actual Worker runtime runs D1 migration and encrypted push without following redirects', async () => {
  const vapid = webPush.generateVAPIDKeys();
  const token = 'runtime-test-not-a-real-secret-123456';
  let pushRequests = 0;
  let redirectPush = false;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: 'worker-dist/index.js', compatibilityDate: '2025-10-01', compatibilityFlags: ['nodejs_compat'],
    bindings: { APP_ORIGIN: 'https://example.github.io', APP_URL: 'https://example.github.io/tv-notifier/', OWNER_TOKEN: token,
      VAPID_SUBJECT: 'https://example.com', VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey },
    d1Databases: { DB: '00000000-0000-0000-0000-000000000001' },
    outboundService: async req => {
      assert.equal(new URL(req.url).hostname, 'web.push.apple.com');
      assert.equal(req.headers.get('content-encoding'), 'aes128gcm');
      assert.ok((await req.arrayBuffer()).byteLength > 100);
      pushRequests++;
      return redirectPush ? new Response(null, { status: 307, headers: { Location: 'https://evil.example/' } }) : new Response(null, { status: 201 });
    },
  }));
  try {
    const db = await mf.getD1Database('DB');
    for (const sql of readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8').split(';').filter(s => s.trim())) await db.prepare(sql).run();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    let response = await mf.dispatchFetch('https://worker.example/api/state', { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).source.status, 'unconfigured');
    const ecdh = createECDH('prime256v1');
    const subscription = { endpoint: 'https://web.push.apple.com/test-runtime', expirationTime: null,
      keys: { p256dh: ecdh.generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    response = await mf.dispatchFetch('https://worker.example/api/subscription', { method: 'PUT', headers, body: JSON.stringify({ id: 'runtime-device-123', subscription }) });
    assert.equal(response.status, 200);
    const push = () => mf.dispatchFetch('https://worker.example/api/test-push', { method: 'POST', headers, body: JSON.stringify({ id: 'runtime-device-123' }) });
    response = await push();
    assert.equal(response.status, 200);
    assert.equal(pushRequests, 1);
    await db.prepare('UPDATE settings SET last_test_at = 0').run();
    redirectPush = true;
    response = await push();
    assert.equal(response.status, 502);
    assert.equal(pushRequests, 2, 'redirect target is never contacted');
  } finally { await mf.dispose(); }
});
