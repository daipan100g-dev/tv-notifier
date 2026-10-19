export type Provider = 'nhk' | 'tbs' | 'ntv';
export const CHANNELS = {
  g1: 'NHK総合1', g2: 'NHK総合2', e1: 'NHK Eテレ1', e3: 'NHK Eテレ3',
  s1: 'NHK BS', s2: 'NHK BS（102ch）', s5: 'NHK BSプレミアム4K',
} as const;
export type Channel = keyof typeof CHANNELS;

export interface Favorite {
  id: string;
  title: string;
  provider: Provider;
  enabled: boolean;
  url: string;
}

export interface Preferences {
  favorites: Favorite[];
  channels: Channel[];
}

export const DEFAULTS: Preferences = {
  favorites: [
    { id: 'airport', title: '弾丸!空港トンボがえりツアー', provider: 'nhk', enabled: true, url: 'https://www.web.nhk/tv/pl/series-tep-PM4Y6MK5PR' },
    { id: 'dramatic', title: '地球ドラマチック', provider: 'nhk', enabled: true, url: 'https://www.nhk.jp/p/dramatic/ts/9GWL7677L9/' },
    { id: 'walking', title: '世界ふれあい街歩き', provider: 'nhk', enabled: true, url: 'https://www.nhk.jp/p/sekaimachi/ts/NJVPP9ZYK6/' },
    { id: 'rail', title: '鉄オタ選手権', provider: 'nhk', enabled: true, url: 'https://www.nhk.jp/p/ts/17N78VVM83/' },
    { id: 'heritage', title: '世界遺産', provider: 'tbs', enabled: true, url: 'https://www.tbs.co.jp/heritage/next/' },
    { id: 'sky', title: 'アナザースカイ', provider: 'ntv', enabled: true, url: 'https://www.ntv.co.jp/anothersky/' },
  ],
  channels: ['g1', 'g2', 'e1', 'e3'],
};

export interface Broadcast {
  id: string;
  sourceId?: string;
  favoriteId: string;
  title: string;
  channel: Channel;
  start: string;
  end: string;
  queryDate: string;
  url: string;
  verifiedAt: number;
  revision: number;
  change: 'new' | 'changed';
}

export interface SourceStatus {
  status: 'unconfigured' | 'waiting' | 'ok' | 'partial' | 'error';
  checkedAt: number | null;
  lastSuccessAt: number | null;
  message: string;
}

export interface AppState {
  preferences: Preferences;
  revision: number;
  broadcasts: Broadcast[];
  source: SourceStatus;
  subscriptions: number;
  vapidPublicKey: string | null;
}

export function normalizeTitle(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

export function matchesTitle(title: string, favorite: string): boolean {
  return normalizeTitle(title).includes(normalizeTitle(favorite));
}

export function jstDate(time: number): string {
  return new Date(time + 9 * 3600_000).toISOString().slice(0, 10);
}

export function formatTime(value: string | number): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

export function officialUrl(value: unknown, provider: Provider): boolean {
  if (typeof value !== 'string' || value.length > 500) return false;
  try {
    const url = new URL(value);
    const allowed = { nhk: ['nhk.jp', 'nhk.or.jp', 'web.nhk'], tbs: ['tbs.co.jp'], ntv: ['ntv.co.jp'] }[provider];
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      allowed.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

export function validatePreferences(value: unknown): Preferences {
  const prefs = value as Preferences;
  if (!prefs || !Array.isArray(prefs.favorites) || prefs.favorites.length > 30 ||
    !Array.isArray(prefs.channels) || !prefs.channels.length || prefs.channels.length > 7 ||
    prefs.channels.some(c => !Object.hasOwn(CHANNELS, c))) throw new Error('設定が不正です。');
  const ids = new Set<string>();
  for (const f of prefs.favorites) {
    if (!f || typeof f.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(f.id) || ids.has(f.id) ||
      typeof f.title !== 'string' || f.title.length > 100 || normalizeTitle(f.title).length < 2 ||
      !['nhk', 'tbs', 'ntv'].includes(f.provider) || typeof f.enabled !== 'boolean' ||
      !officialUrl(f.url, f.provider)) throw new Error('番組名・公式URL・IDを確認してください。');
    ids.add(f.id);
  }
  return {
    favorites: prefs.favorites.map(f => ({ id: f.id, title: f.title.trim(), provider: f.provider, enabled: f.enabled, url: f.url })),
    channels: [...new Set(prefs.channels)],
  };
}
