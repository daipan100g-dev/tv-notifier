import webPush from 'web-push';

export interface Subscription {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}
export interface PushEnv {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT: string;
}

function decoded(value: unknown, length: number): boolean {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return false;
  try { return atob(value.replace(/-/g, '+').replace(/_/g, '/')).length === length; }
  catch { return false; }
}

export function validateSubscription(value: unknown): Subscription {
  const sub = value as Subscription;
  if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint.length > 2048 || !sub.keys ||
    !decoded(sub.keys.p256dh, 65) || !decoded(sub.keys.auth, 16)) throw new Error('通知先が不正です。');
  const url = new URL(sub.endpoint);
  const allowed = ['fcm.googleapis.com', 'updates.push.services.mozilla.com'];
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.pathname.length < 2 ||
    !(allowed.includes(url.hostname) || url.hostname === 'web.push.apple.com' || url.hostname.endsWith('.push.apple.com'))) throw new Error('対応していないプッシュサービスです。');
  const point = atob(sub.keys.p256dh.replace(/-/g, '+').replace(/_/g, '/'));
  if (point.charCodeAt(0) !== 4) throw new Error('通知先の公開鍵が不正です。');
  return { endpoint: url.href, expirationTime: null, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
}

export function pushReady(env: PushEnv): boolean {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && /^(mailto:|https:\/\/)/.test(env.VAPID_SUBJECT));
}

export async function sendPush(env: PushEnv, subscription: Subscription, data: object, ttl = 3600): Promise<number> {
  if (!pushReady(env)) throw new Error('VAPID未設定');
  const payload = webPush.generateRequestDetails(subscription, JSON.stringify(data), {
    TTL: ttl, contentEncoding: 'aes128gcm',
    vapidDetails: { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY! },
  });
  const response = await fetch(subscription.endpoint, {
    method: 'POST', headers: payload.headers, body: new Uint8Array(payload.body!),
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  return response.status;
}
