import { CHANNELS, formatTime, type Broadcast } from '../shared/model';
import { events, prune, settings, sourceStatus } from './db';
import { fetchDate, pollSlot } from './nhk';
import { reconcile } from './reconcile';
import { pushReady, sendPush, type PushEnv, type Subscription } from './push';

export interface Env extends PushEnv {
  DB: D1Database;
  NHK_API_KEY?: string;
  OWNER_TOKEN?: string;
  APP_ORIGIN: string;
  APP_URL: string;
}
interface PollResult {
  date: string;
  revision: number;
  events: Broadcast[];
  ok: boolean;
}

async function finalize(env: Env, cycle: string, now: number) {
  const config = await settings(env.DB);
  const rows = await env.DB.prepare('SELECT result FROM poll_parts WHERE cycle = ? AND result IS NOT NULL').bind(cycle).all<{ result: string }>();
  const parts = rows.results.map(row => JSON.parse(row.result) as PollResult).filter(p => p.revision === config.revision);
  const successful = parts.filter(part => part.ok);
  if (!successful.length) {
    await sourceStatus(env.DB, 'error', now, 'NHK番組表を取得できませんでした。放送予定の有無は未確認です。APIキー・提供元の状態を確認してください。');
    return;
  }
  const previous = await events(env.DB);
  const result = reconcile(previous, successful.flatMap(p => p.events), successful.map(p => p.date), now);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM broadcasts WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(result.removed.map(b => b.id))),
    env.DB.prepare(`INSERT INTO broadcasts (id, event, revision, ends_at)
      SELECT json_extract(value, '$.id'), value, json_extract(value, '$.revision'), json_extract(value, '$.endsAt')
      FROM json_each(?) WHERE true
      ON CONFLICT(id) DO UPDATE SET event=excluded.event, revision=excluded.revision, ends_at=excluded.ends_at`)
      .bind(JSON.stringify(result.events.map(b => ({ ...b, endsAt: Date.parse(b.end) })))),
    env.DB.prepare(`DELETE FROM deliveries WHERE status = 'pending' AND EXISTS
      (SELECT 1 FROM broadcasts b WHERE b.id = deliveries.broadcast_id AND b.revision != deliveries.revision)`),
    env.DB.prepare(`INSERT OR IGNORE INTO deliveries (broadcast_id, revision, subscription_id)
      SELECT json_extract(j.value, '$.id'), json_extract(j.value, '$.revision'), s.id
      FROM json_each(?) j CROSS JOIN subscriptions s`).bind(JSON.stringify(result.notify)),
  ]);
  const complete = successful.length === 8;
  await sourceStatus(env.DB, complete ? 'ok' : 'partial', now, complete
    ? '神奈川（横浜）のNHK番組表を当日〜7日先まで確認しました。民放の自動取得は未対応です。'
    : `8日分のうち${successful.length}日分を確認しました。未取得の日付は放送予定の有無が未確認です。次の確認サイクルで再取得します。`);
}

interface PendingDelivery {
  broadcast_id: string;
  revision: number;
  subscription_id: string;
  subscription: string;
  event: string;
  attempts: number;
}

export async function drain(env: Env, now: number) {
  if (!pushReady(env)) return;
  const deliveries = await env.DB.prepare(`SELECT d.*, s.subscription, b.event FROM deliveries d
    JOIN subscriptions s ON s.id = d.subscription_id JOIN broadcasts b ON b.id = d.broadcast_id
    WHERE d.status = 'pending' AND d.revision = b.revision AND b.ends_at > ?
    AND d.next_attempt <= ? AND d.lease_until <= ? AND d.attempts < 5
    ORDER BY b.ends_at LIMIT 3`).bind(now, now, now).all<PendingDelivery>();
  for (const d of deliveries.results) {
    const claim = await env.DB.prepare(`UPDATE deliveries SET lease_until = ?, attempts = attempts + 1
      WHERE broadcast_id = ? AND revision = ? AND subscription_id = ? AND status = 'pending' AND lease_until <= ?`)
      .bind(now + 90_000, d.broadcast_id, d.revision, d.subscription_id, now).run();
    if (!claim.meta.changes) continue;
    const b = JSON.parse(d.event) as Broadcast;
    let status = 0;
    try {
      status = await sendPush(env, JSON.parse(d.subscription) as Subscription, {
        title: b.change === 'changed' ? '放送日時が変わりました' : '新しい放送予定があります',
        body: `${b.title}\n${formatTime(b.start)} / ${CHANNELS[b.channel]}\nＮＨＫ番組の情報提供:ＮＨＫ`,
        url: b.url, tag: `tv-${b.id}`,
      }, Math.max(60, Math.min(3600, Math.floor((Date.parse(b.end) - now) / 1000))));
    } catch { /* Network errors are retried without logging subscription URLs or keys. */ }
    if (status === 404 || status === 410) {
      await env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(d.subscription_id).run();
      continue;
    }
    const sent = status >= 200 && status < 300;
    const failed = !sent && status >= 400 && status < 500 && status !== 429 || d.attempts + 1 >= 5;
    await env.DB.prepare(`UPDATE deliveries SET status = ?, lease_until = 0, next_attempt = ?
      WHERE broadcast_id = ? AND revision = ? AND subscription_id = ?`)
      .bind(sent ? 'sent' : failed ? 'failed' : 'pending', now + Math.min(3600_000, 60_000 * 2 ** d.attempts), d.broadcast_id, d.revision, d.subscription_id).run();
  }
}

export async function scheduled(env: Env, scheduledTime: number) {
  const now = Date.now();
  await prune(env.DB, now);
  if (!env.NHK_API_KEY) {
    await sourceStatus(env.DB, 'unconfigured', now, 'NHK APIキーが未設定です。番組表は未確認です。');
    return;
  }
  const config = await settings(env.DB);
  if (!config.preferences.favorites.some(f => f.enabled && f.provider === 'nhk')) {
    await sourceStatus(env.DB, 'ok', now, 'NHKの通知対象がありません。民放の自動取得は未対応です。');
    return;
  }
  const { cycle, part, date } = pollSlot(scheduledTime);
  const claim = await env.DB.prepare('INSERT OR IGNORE INTO poll_parts (cycle, part, created_at) VALUES (?, ?, ?)').bind(cycle, part, now).run();
  if (!claim.meta.changes) return;
  let result: PollResult = { date, revision: config.revision, events: [], ok: false };
  try {
    result = { ...result, events: await fetchDate(env.NHK_API_KEY, date, config.preferences, now), ok: true };
  } catch { /* Do not log errors that could contain the upstream API key. */ }
  await env.DB.prepare('UPDATE poll_parts SET result = ? WHERE cycle = ? AND part = ?').bind(JSON.stringify(result), cycle, part).run();
  if (part === 7) await finalize(env, cycle, now);
  await drain(env, now);
}
