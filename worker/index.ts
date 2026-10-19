import { DEFAULTS, matchesTitle, validatePreferences, type AppState, type SourceStatus } from '../shared/model';
import { events, prune, settings, sourceStatus } from './db';
import { pushReady, sendPush, validateSubscription } from './push';
import { scheduled, type Env } from './scheduler';

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function authenticate(req: Request, env: Env) {
  if (!env.OWNER_TOKEN || env.OWNER_TOKEN.length < 32) throw new HttpError(503, 'サーバーの接続キーが未設定です。');
  const provided = req.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
  if (provided.length > 512) throw new HttpError(401, '接続キーが違います。');
  const digest = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = await Promise.all([digest(provided), digest(env.OWNER_TOKEN)]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  if (diff) throw new HttpError(401, '接続キーが違います。');
}

async function body(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get('Content-Type')?.startsWith('application/json')) throw new HttpError(415, 'JSON形式が必要です。');
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, '本文が必要です。');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 32768) { await reader.cancel(); throw new HttpError(413, '設定データが大きすぎます。'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new HttpError(400, 'JSONが不正です。'); }
}

function deviceId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{10,80}$/.test(value)) throw new HttpError(400, '端末IDが不正です。');
  return value;
}

async function getState(env: Env): Promise<AppState> {
  const now = Date.now();
  await prune(env.DB, now);
  const config = await settings(env.DB);
  const source = await env.DB.prepare('SELECT * FROM source_status WHERE id = 1').first<{
    status: SourceStatus['status']; checked_at: number | null; last_success_at: number | null; message: string;
  }>();
  let status: SourceStatus = source ? {
    status: source.status, checkedAt: source.checked_at, lastSuccessAt: source.last_success_at, message: source.message,
  } : { status: 'waiting', checkedAt: null, lastSuccessAt: null, message: '初回確認を待っています。毎時51分ごろに8日分の取得結果を反映します。' };
  if (!env.NHK_API_KEY) status = { ...status, status: 'unconfigured', message: 'NHK APIキーが未設定です。放送予定は未確認です。' };
  else if (status.checkedAt && now - status.checkedAt > 2 * 3600_000) status = { ...status, status: 'error', message: '番組表の確認が2時間以上停止しています。最新の放送予定は未確認です。Cronの設定をご確認ください。' };
  return {
    ...config,
    broadcasts: env.NHK_API_KEY ? (await events(env.DB)).filter(b => b.verifiedAt > now - 2 * 3600_000 &&
      config.preferences.channels.includes(b.channel) && config.preferences.favorites.some(f => f.id === b.favoriteId && f.enabled && matchesTitle(b.title, f.title))).sort((a, b) => a.start.localeCompare(b.start)) : [],
    source: status,
    subscriptions: (await env.DB.prepare('SELECT COUNT(*) AS count FROM subscriptions').first<{ count: number }>())!.count,
    vapidPublicKey: pushReady(env) ? env.VAPID_PUBLIC_KEY! : null,
  };
}

async function route(req: Request, env: Env): Promise<unknown> {
  const path = new URL(req.url).pathname;
  if (path === '/api/state' && req.method === 'GET') return getState(env);
  if (path === '/api/preferences' && req.method === 'PUT') {
    const data = await body(req);
    let prefs;
    try { prefs = validatePreferences(data.preferences); } catch (e) { throw new HttpError(400, (e as Error).message); }
    if (!Number.isSafeInteger(data.revision)) throw new HttpError(400, '設定のバージョンが不正です。');
    const updated = await env.DB.prepare('UPDATE settings SET preferences = ?, revision = revision + 1 WHERE id = 1 AND revision = ?')
      .bind(JSON.stringify(prefs), data.revision).run();
    if (!updated.meta.changes) throw new HttpError(409, '他の端末で設定が変わりました。接続・同期し直してから変更してください。');
    const obsolete = (await events(env.DB)).filter(b => !prefs.channels.includes(b.channel) ||
      !prefs.favorites.some(f => f.id === b.favoriteId && f.enabled && f.provider === 'nhk' && matchesTitle(b.title, f.title)));
    await env.DB.batch([
      env.DB.prepare('DELETE FROM broadcasts WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(obsolete.map(b => b.id))),
    ]);
    await sourceStatus(env.DB, 'waiting', Date.now(), '設定を保存しました。次の取得サイクルの完了を待っています。');
    return { revision: (data.revision as number) + 1 };
  }
  if (path === '/api/subscription' && ['PUT', 'DELETE'].includes(req.method)) {
    const data = await body(req);
    const id = deviceId(data.id);
    if (req.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(id).run();
      return { ok: true };
    }
    if (!pushReady(env)) throw new HttpError(503, 'VAPIDキーが未設定です。');
    let subscription;
    try { subscription = validateSubscription(data.subscription); } catch { throw new HttpError(400, '通知先または公開鍵が不正です。'); }
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM subscriptions WHERE id != ? AND endpoint != ?').bind(id, subscription.endpoint).first<{ count: number }>();
    if (count!.count >= 3) throw new HttpError(409, '無料枠を守るため最大3端末です。使わない端末の通知を解除してください。');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ? AND id != ?').bind(subscription.endpoint, id),
      env.DB.prepare(`INSERT INTO subscriptions (id, endpoint, subscription, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET endpoint=excluded.endpoint, subscription=excluded.subscription, updated_at=excluded.updated_at`)
        .bind(id, subscription.endpoint, JSON.stringify(subscription), Date.now()),
    ]);
    return { ok: true };
  }
  if (path === '/api/test-push' && req.method === 'POST') {
    const data = await body(req);
    const id = deviceId(data.id);
    if (!pushReady(env)) throw new HttpError(503, 'VAPIDキーが未設定です。');
    const row = await env.DB.prepare('SELECT subscription FROM subscriptions WHERE id = ?').bind(id).first<{ subscription: string }>();
    if (!row) throw new HttpError(404, 'この端末の通知が登録されていません。');
    const now = Date.now();
    const claim = await env.DB.prepare('UPDATE settings SET last_test_at = ? WHERE id = 1 AND last_test_at < ?').bind(now, now - 60_000).run();
    if (!claim.meta.changes) throw new HttpError(429, 'テスト通知は1分おきに送信できます。');
    const status = await sendPush(env, JSON.parse(row.subscription), {
      title: '放送メモのテスト通知', body: '通知を受信できました。新しい放送予定が見つかると、ここに届きます。', tag: 'tv-test', url: env.APP_URL,
    });
    if (status === 404 || status === 410) {
      await env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(id).run();
      throw new HttpError(410, '通知先の期限が切れました。いったん解除してから再登録してください。');
    }
    if (status < 200 || status >= 300) throw new HttpError(502, 'プッシュサービスに送信できませんでした。VAPID設定を確認してください。');
    return { accepted: true };
  }
  throw new HttpError(404, 'APIが見つかりません。');
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get('Origin');
    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin',
    });
    if (origin === env.APP_ORIGIN) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      headers.set('Access-Control-Max-Age', '600');
    }
    if (origin && origin !== env.APP_ORIGIN) return new Response(JSON.stringify({ error: '許可されていないオリジンです。' }), { status: 403, headers });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    try {
      await authenticate(req, env);
      return new Response(JSON.stringify(await route(req, env)), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: e instanceof HttpError ? e.message : 'サーバー処理に失敗しました。設定・D1マイグレーションを確認してください。' }), { status: e instanceof HttpError ? e.status : 503, headers });
    }
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await scheduled(env, controller.scheduledTime);
  },
};

export { DEFAULTS };
