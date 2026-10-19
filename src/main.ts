import './style.css';
import { CHANNELS, DEFAULTS, formatTime, validatePreferences, type AppState, type Favorite, type Preferences } from '../shared/model';

const root = document.querySelector<HTMLDivElement>('#app')!;
const STORE = 'tv-notifier-v1';
interface LocalSettings { api: string; token: string; deviceId: string; preferences: Preferences }
let local: LocalSettings = { api: import.meta.env.VITE_API_URL || '', token: '', deviceId: crypto.randomUUID(), preferences: structuredClone(DEFAULTS) };
let storageError = false;
try {
  const stored = JSON.parse(localStorage.getItem(STORE) || 'null');
  if (stored) local = { ...local, ...stored, preferences: validatePreferences(stored.preferences) };
} catch { storageError = true; }
let state: AppState | null = null;
let tab: 'favorites' | 'schedule' | 'settings' = 'favorites';
let notice = storageError ? '端末の保存設定を読み込めませんでした。初期設定を表示しています。' : '';
let busy = false;
let connected = false;
let permission = 'Notification' in window ? Notification.permission : 'unsupported';
let subscribed = false;
let registration: ServiceWorkerRegistration | null = null;

function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function persist() {
  try { localStorage.setItem(STORE, JSON.stringify(local)); }
  catch { notice = 'この端末に設定を保存できません。ブラウザの保存設定を確認してください。'; }
}
function standalone() {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone;
}
function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1; }
function canPush() { return 'PushManager' in window && 'Notification' in window && 'serviceWorker' in navigator; }

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (!local.api || !local.token) throw new Error('設定からWorker URLと接続キーを登録してください。');
  const res = await fetch(`${local.api.replace(/\/$/, '')}/api/${path}`, {
    method, headers: { Authorization: `Bearer ${local.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json() as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `接続エラー (${res.status})`);
  return data;
}

async function refresh() {
  state = await api<AppState>('state');
  local.preferences = state.preferences;
  connected = true;
  persist();
  const sub = await registration?.pushManager?.getSubscription();
  if (sub) {
    await api('subscription', 'PUT', { id: local.deviceId, subscription: sub.toJSON() });
    subscribed = true;
  } else { subscribed = false; }
}

function statusLabel() {
  if (!navigator.onLine) return 'オフライン';
  if (!connected) return '通知サーバー未接続';
  return state?.source.status === 'ok' ? '番組表を確認済み' : '取得状況を要確認';
}

function favoriteCard(f: Favorite, index: number) {
  const events = state?.broadcasts.filter(b => b.favoriteId === f.id && new Date(b.end).getTime() > Date.now()) || [];
  const supported = f.provider === 'nhk';
  const ready = state?.source.status === 'ok';
  const label = !f.enabled ? '通知対象外' : !supported ? '自動取得未対応' : !connected ? 'サーバー接続後に取得' : events.length ? `${events.length}件の放送予定` : ready ? '取得範囲内の予定はありません' : '未確認・取得状況を確認';
  return `<article class="program-card ${!f.enabled ? 'muted-card' : ''}">
    <div class="program-top"><span class="station">${{ nhk: 'NHK', tbs: 'TBS', ntv: '日本テレビ' }[f.provider]}</span>${DEFAULTS.favorites.some(item => item.id === f.id) ? `<span class="program-number">${String(index + 1).padStart(2, '0')}</span>` : `<button class="text-button" data-remove="${esc(f.id)}" aria-label="${esc(f.title)}を削除" ${busy ? 'disabled' : ''}>削除</button>`}</div>
    <h3>${esc(f.title)}</h3><p class="program-status"><span class="dot ${supported && f.enabled ? 'green' : ''}"></span>${label}</p>
    ${events[0] ? `<p class="next-time">${esc(formatTime(events[0].start))}<small>${CHANNELS[events[0].channel]}</small></p>` : ''}
    <div class="program-bottom"><a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">公式サイト <span aria-hidden="true">↗</span></a>
    <label class="toggle"><input type="checkbox" data-favorite="${esc(f.id)}" ${f.enabled ? 'checked' : ''} ${busy ? 'disabled' : ''} aria-label="${esc(f.title)}を通知対象にする"><span aria-hidden="true"></span></label></div>
  </article>`;
}

function favoritesView() {
  return `<div class="section-heading"><div><p class="eyebrow">MY PROGRAMS</p><h2>お気に入りの番組 <span class="count">${local.preferences.favorites.filter(f => f.enabled).length}</span></h2></div><button class="button secondary" id="add-program">＋ 番組を追加</button></div>
  <p class="section-note">スイッチをONにした番組をチェック。再放送もお知らせします。</p>
  <div class="program-grid">${local.preferences.favorites.map(favoriteCard).join('')}</div>
  <div class="info-line"><strong>民放の番組について</strong><p>TBS・日本テレビの自動取得は未対応です。スイッチをONにしても通知は届きません。公式サイトで放送予定をご確認ください。</p></div>
  <dialog id="add-dialog"><form id="add-form"><p class="eyebrow">ADD A PROGRAM</p><h2>NHKの番組を追加</h2><p class="section-note">番組名の部分一致で探します。「選」や再放送も対象です。</p>
  <label class="field">番組名<input name="title" required minlength="2" maxlength="100" placeholder="例：ブラタモリ"></label>
  <label class="field">NHK公式ページのURL<input name="url" type="url" required placeholder="https://www.nhk.jp/…"></label>
  <div class="dialog-actions"><button type="button" class="button secondary" id="close-dialog">キャンセル</button><button class="button" type="submit">追加する</button></div><p id="form-error" role="alert"></p></form></dialog>`;
}

function scheduleView() {
  const events = state?.broadcasts.filter(b => new Date(b.end).getTime() > Date.now()) || [];
  return `<div class="section-heading"><div><p class="eyebrow">UPCOMING</p><h2>これからの放送</h2></div><button class="button secondary" id="refresh" ${busy || !local.token ? 'disabled' : ''}>表示を更新</button></div>
    <p class="section-note">神奈川（横浜）・当日から7日先まで。時刻は日本時間です。</p>
    ${state ? `<div class="source-message ${state.source.status === 'ok' ? 'success' : ''}"><strong>${state.source.status === 'ok' ? 'NHK番組表' : '取得状況'}</strong><p>${esc(state.source.message)}</p>${state.source.lastSuccessAt ? `<small>直近の全件取得：${esc(formatTime(state.source.lastSuccessAt))}</small>` : ''}</div>` : ''}
    ${events.length ? `<div class="schedule-list">${events.map(b => `<article class="schedule-item"><div class="schedule-date">${esc(formatTime(b.start))}<small>${CHANNELS[b.channel]}</small></div><div><span class="badge">${b.change === 'changed' ? '日時変更' : '放送予定'}</span><h3>${esc(b.title)}</h3><small>確認：${esc(formatTime(b.verifiedAt))} ／ 再放送も含む</small></div><a class="schedule-link" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(b.title)}の公式サイト">↗</a></article>`).join('')}</div>` : `<div class="empty-state"><div class="tv-outline" aria-hidden="true">▶</div><h3>${!connected ? '番組表の接続を待っています' : state?.source.status === 'ok' ? '取得範囲内の予定はありません' : '放送予定はまだ確認できていません'}</h3><p>${!connected ? '「設定」で通知サーバーに接続すると、実際の放送予定がここに並びます。' : '取得失敗・未対応は「放送なし」とは異なります。取得状況と公式サイトをご確認ください。'}</p></div>`}
    <p class="attribution">ＮＨＫ番組の情報提供:ＮＨＫ<br><small>本アプリは個人開発の非公式アプリです。NHK・各放送局との提携はありません。</small></p>`;
}

function settingsView() {
  const channels = local.preferences.channels;
  return `<div class="section-heading"><div><p class="eyebrow">SETTINGS</p><h2>視聴環境と通知</h2></div></div>
    <div class="settings-grid"><section class="panel"><h3>視聴するチャンネル</h3><p class="section-note">地域：神奈川県（横浜・140）<br>BS・4Kは、ご自宅で視聴できる場合だけONにしてください。</p>
    ${[['地上波', ['g1', 'g2', 'e1', 'e3']], ['BS', ['s1', 's2']], ['BSプレミアム4K', ['s5']]].map(([name, values]) => `<label class="setting-row"><span>${name}</span><input type="checkbox" data-channels="${(values as string[]).join(',')}" ${(values as string[]).every(v => channels.includes(v as keyof typeof CHANNELS)) ? 'checked' : ''} ${busy ? 'disabled' : ''}></label>`).join('')}
    <p class="section-note">新作／再放送は区別せず、別日時の放送枠をそれぞれ通知します。</p></section>
    <section class="panel"><h3>このiPhone・端末の通知</h3><p class="section-note">通知許可：${{ granted: '許可済み', denied: '拒否されています', default: '未設定', unsupported: 'このブラウザでは非対応' }[permission]}<br>サーバー登録：${subscribed && connected ? '登録済み' : '未確認／未登録'}</p>
    <div class="stack-actions"><button class="button" id="enable-push" ${busy || !connected || !state?.vapidPublicKey || !registration || subscribed ? 'disabled' : ''}>${subscribed ? '通知は有効です' : 'この端末の通知を有効にする'}</button><button class="button secondary" id="test-push" ${busy || !connected || !subscribed ? 'disabled' : ''}>テスト通知を送る</button><button class="text-button" id="disable-push" ${busy || !connected ? 'disabled' : ''}>この端末の通知を解除</button></div>
    <p class="section-note">iOS 16.4以降が必要です。Safariの共有メニュー →「ホーム画面に追加」→ 追加したアプリから通知を許可してください。拒否した場合はiPhoneの通知設定を確認してください。</p></section>
    <section class="panel connection-panel"><h3>通知サーバーへの接続</h3><p class="section-note">Cloudflare WorkersのURLと個人用接続キーを入力します。接続後は、他の端末と共通のお気に入り設定が読み込まれます。</p>
    <form id="connect-form"><label class="field">Worker URL<input type="url" name="api" value="${esc(local.api)}" placeholder="https://tv-notifier.…workers.dev" required autocomplete="url"></label>
    <label class="field">個人用接続キー<input type="password" name="token" value="${esc(local.token)}" required autocomplete="off" minlength="32" placeholder="OWNER_TOKEN（32文字以上）"></label>
    <div class="dialog-actions"><button type="button" class="text-button" id="disconnect">接続情報をこの端末から消す</button><button class="button" ${busy ? 'disabled' : ''}>接続・同期する</button></div></form>
    <p class="section-note">接続キーと番組設定はこの端末のブラウザに保存されます。共用端末では使用しないでください。接続情報を消すときは先に通知を解除してください。</p></section></div>`;
}

function render() {
  root.innerHTML = `<header class="site-header"><a href="#" class="brand" aria-label="放送メモ ホーム"><span class="brand-icon" aria-hidden="true">▹</span>放送メモ<span class="brand-en">TV NOTIFIER</span></a><span class="location">神奈川・横浜 <span class="dot green"></span></span></header>
    <main><section class="hero"><div><p class="eyebrow">YOUR NEXT FAVORITE MOMENT</p><h1>次の放送を、<br>見逃さない。</h1><p class="hero-copy">好きな番組の新しい放送予定を、あなたのiPhoneへ。<br>いつもの番組も、うれしい再放送も。</p><div class="hero-tags"><span>再放送も対象</span><span>約1時間ごとに確認</span><span>個人用・無料枠構成</span></div></div>
    <aside class="hero-aside"><div class="hero-tv" aria-hidden="true"><span>ON YOUR RADAR</span><strong>▶</strong><span>好きな番組を、これからも。</span></div><p><span class="dot ${connected ? 'green' : ''}"></span>${statusLabel()}</p></aside></section>
    ${!standalone() ? `<section class="install-tip"><span class="tip-icon" aria-hidden="true">＋</span><div><strong>ホーム画面に、あなただけの番組ガイド。</strong><p>iPhoneはSafariの共有メニューから「ホーム画面に追加」。通知は追加したアプリで有効にできます。</p></div></section>` : ''}
    ${!connected ? `<div class="setup-banner"><div><strong>番組登録からはじめましょう</strong><p>画面は利用できますが、放送取得・通知にはサーバー設定が必要です。</p></div><button class="text-button" data-tab="settings">接続を設定する →</button></div>` : ''}
    <div id="notice" role="status" aria-live="polite" ${notice ? '' : 'hidden'}>${esc(notice)}</div>
    <nav class="tabs" aria-label="表示切替">${[['favorites', 'お気に入り'], ['schedule', '放送予定'], ['settings', '設定']].map(([id, name]) => `<button data-tab="${id}" aria-current="${tab === id ? 'page' : 'false'}">${name}</button>`).join('')}</nav>
    <section class="tab-content">${tab === 'favorites' ? favoritesView() : tab === 'schedule' ? scheduleView() : settingsView()}</section>
    </main><footer><span class="footer-brand">放送メモ</span><span>好きな番組と、いい時間を。</span><a href="https://github.com/daipan100g-dev/tv-notifier" target="_blank" rel="noopener noreferrer">使い方・ソースコード ↗</a></footer>`;
  bind();
}

async function action(fn: () => Promise<void>) {
  busy = true; notice = ''; render();
  try { await fn(); }
  catch (e) { notice = e instanceof Error ? e.message : '操作に失敗しました。'; }
  finally { busy = false; render(); }
}

async function savePreferences(next: Preferences) {
  next = validatePreferences(next);
  if (connected && state) {
    const saved = await api<{ revision: number }>('preferences', 'PUT', { preferences: next, revision: state.revision });
    state.revision = saved.revision;
    state.preferences = next;
    state.broadcasts = [];
  }
  local.preferences = next; persist();
  notice = connected ? '保存しました。変更は次の番組表確認サイクルから反映されます。' : 'この端末に保存しました。通知にはサーバー接続が必要です。';
}

function bind() {
  document.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(button => button.onclick = () => {
    const next = structuredClone(local.preferences);
    next.favorites = next.favorites.filter(f => f.id !== button.dataset.remove);
    void action(() => savePreferences(next));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.onclick = () => { tab = button.dataset.tab as typeof tab; render(); });
  document.querySelectorAll<HTMLInputElement>('[data-favorite]').forEach(input => input.onchange = () => {
    const next = structuredClone(local.preferences);
    next.favorites.find(f => f.id === input.dataset.favorite)!.enabled = input.checked;
    void action(() => savePreferences(next));
  });
  document.querySelectorAll<HTMLInputElement>('[data-channels]').forEach(input => input.onchange = () => {
    const selected = input.dataset.channels!.split(',') as Preferences['channels'];
    const next = structuredClone(local.preferences);
    next.channels = input.checked ? [...new Set([...next.channels, ...selected])] : next.channels.filter(c => !selected.includes(c));
    void action(() => savePreferences(next));
  });
  const on = (id: string, fn: () => void) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('add-program', () => (document.querySelector('#add-dialog') as HTMLDialogElement).showModal());
  on('close-dialog', () => (document.querySelector('#add-dialog') as HTMLDialogElement).close());
  const add = document.querySelector<HTMLFormElement>('#add-form');
  if (add) add.onsubmit = event => {
    event.preventDefault();
    const data = new FormData(add);
    const next = structuredClone(local.preferences);
    next.favorites.push({ id: crypto.randomUUID(), title: String(data.get('title')), url: String(data.get('url')), provider: 'nhk', enabled: true });
    try { validatePreferences(next); } catch (error) { document.querySelector('#form-error')!.textContent = (error as Error).message; return; }
    void action(() => savePreferences(next));
  };
  const connect = document.querySelector<HTMLFormElement>('#connect-form');
  if (connect) connect.onsubmit = event => {
    event.preventDefault();
    const data = new FormData(connect);
    void action(async () => {
      const url = new URL(String(data.get('api')));
      if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('WorkerのルートURL（HTTPS）を指定してください。');
      const previous = { ...local };
      local.api = url.origin; local.token = String(data.get('token')).trim();
      try { await refresh(); notice = '接続しました。サーバー側の設定を同期しました。'; }
      catch (error) { local = previous; connected = false; state = null; throw error; }
    });
  };
  on('disconnect', () => { if (subscribed) { notice = '先に「この端末の通知を解除」を押してください。'; render(); return; } local.token = ''; state = null; connected = false; persist(); render(); });
  on('refresh', () => void action(async () => { await refresh(); notice = '表示を更新しました。番組表の取得はサーバーで約1時間ごとに行われます。'; }));
  on('enable-push', () => {
    if (!canPush() || isIOS() && !standalone()) { notice = 'iPhoneはiOS 16.4以降で、ホーム画面に追加したアプリから操作してください。'; render(); return; }
    const permissionRequest = Notification.requestPermission();
    void action(async () => {
      permission = await permissionRequest;
      if (permission !== 'granted') throw new Error('通知は許可されていません。端末の通知設定をご確認ください。');
      if (!registration || !state?.vapidPublicKey) throw new Error('接続またはService Workerの準備が完了していません。');
      const raw = atob(state.vapidPublicKey.replace(/-/g, '+').replace(/_/g, '/'));
      const key = Uint8Array.from(raw, c => c.charCodeAt(0));
      const sub = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await api('subscription', 'PUT', { id: local.deviceId, subscription: sub.toJSON() });
      subscribed = true; notice = 'この端末の通知を有効にしました。テスト通知で受信を確認してください。';
    });
  });
  on('test-push', () => void action(async () => { await api('test-push', 'POST', { id: local.deviceId }); notice = 'プッシュサービスが通知を受け付けました。端末で受信をご確認ください。'; }));
  on('disable-push', () => void action(async () => {
    await api('subscription', 'DELETE', { id: local.deviceId });
    const sub = await registration?.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
    subscribed = false; notice = 'この端末への通知を解除しました。';
  }));
}

window.addEventListener('offline', () => { connected = false; state = null; notice = 'オフラインです。番組表は表示せず、お気に入り設定のみ利用できます。'; render(); });
window.addEventListener('online', () => { if (local.token) void action(refresh); else render(); });
render();
async function start() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL });
      registration = await navigator.serviceWorker.ready;
      subscribed = !!(await registration.pushManager?.getSubscription());
    } catch { notice = 'オフライン機能・通知の準備に失敗しました。HTTPSで開き直してください。'; }
  }
  if (local.token && local.api) await action(refresh);
  else render();
}
void start();
