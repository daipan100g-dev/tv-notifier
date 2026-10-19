import { CHANNELS, jstDate, matchesTitle, normalizeTitle, type Broadcast, type Preferences } from '../shared/model';

const SERVICE_GROUP = { g1: 'g1', g2: 'g1', e1: 'e1', e3: 'e1', s1: 's1', s2: 's1', s5: 's5' } as const;

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('NHK response schema');
  return value as JsonObject;
}

export function parseNhk(value: unknown, date: string, prefs: Preferences, now: number): Broadcast[] {
  const data = object(value);
  const broadcasts: Broadcast[] = [];
  const seen = new Set<string>();
  for (const channel of Object.keys(CHANNELS) as (keyof typeof CHANNELS)[]) {
    if (!prefs.channels.includes(channel)) continue;
    const service = object(data[channel]);
    if (!Array.isArray(service.publication)) throw new Error('NHK publication schema');
    for (const raw of service.publication) {
      const event = object(raw);
      if (typeof event.name !== 'string' || typeof event.startDate !== 'string' || typeof event.endDate !== 'string' ||
        !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(event.startDate) || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(event.endDate)) throw new Error('NHK event schema');
      const start = Date.parse(event.startDate);
      const end = Date.parse(event.endDate);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('NHK date schema');
      if (end <= now || start > now + 9 * 86400_000) continue;
      for (const f of prefs.favorites) {
        if (f.enabled && f.provider === 'nhk' && matchesTitle(event.name, f.title)) {
          const key = JSON.stringify([f.id, SERVICE_GROUP[channel], start, end, normalizeTitle(event.name)]);
          if (seen.has(key)) continue;
          seen.add(key);
          const sourceId = typeof event.id === 'string' ? event.id : typeof event.identifier === 'string' ? event.identifier : undefined;
          broadcasts.push({
            id: crypto.randomUUID(), sourceId, favoriteId: f.id,
            title: event.name.slice(0, 300), channel, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
            queryDate: date, url: f.url, verifiedAt: now, revision: 1, change: 'new',
          });
        }
      }
    }
  }
  return broadcasts;
}

export async function fetchDate(key: string, date: string, prefs: Preferences, now: number): Promise<Broadcast[]> {
  const url = new URL('https://program-api.nhk.jp/v3/papiPgDateTv');
  url.search = new URLSearchParams({ service: 'tv', area: '140', date, key }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'manual' });
  if (!response.ok) throw new Error('NHK request failed');
  // The upstream URL contains the API key; never include it in errors or logs.
  return parseNhk(await response.json(), date, prefs, now);
}

export function pollSlot(time: number): { cycle: string; part: number; date: string } {
  const minute = new Date(time).getUTCMinutes();
  const part = [2, 9, 16, 23, 30, 37, 44, 51].indexOf(minute);
  if (part < 0) throw new Error('Unsupported cron minute');
  return { cycle: new Date(time).toISOString().slice(0, 13), part, date: jstDate(time + part * 86400_000) };
}
