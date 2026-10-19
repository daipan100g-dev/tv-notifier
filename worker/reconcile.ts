import { normalizeTitle, type Broadcast } from '../shared/model';

export interface Reconciliation {
  events: Broadcast[];
  removed: Broadcast[];
  notify: Broadcast[];
}

export function reconcile(previous: Broadcast[], incoming: Broadcast[], refreshedDates: string[], now: number): Reconciliation {
  const active = previous.filter(b => Date.parse(b.end) > now);
  const candidates = active.filter(b => refreshedDates.includes(b.queryDate));
  const used = new Set<string>();
  const matched = new Map<Broadcast, Broadcast>();
  const uniqueIncoming = [...new Map(incoming.map(b => [`${b.favoriteId}|${b.channel}|${b.start}`, b])).values()];
  const exactKey = (b: Broadcast) => `${b.favoriteId}|${b.channel}|${b.start}`;
  for (const event of uniqueIncoming) {
    const old = candidates.find(b => !used.has(b.id) && exactKey(b) === exactKey(event));
    if (old) { matched.set(event, old); used.add(old.id); }
  }
  const equivalent = (a: Broadcast, b: Broadcast) => a.favoriteId === b.favoriteId && a.channel === b.channel &&
    (a.sourceId && b.sourceId && a.sourceId === b.sourceId || normalizeTitle(a.title) === normalizeTitle(b.title)) &&
    Math.abs(Date.parse(a.start) - Date.parse(b.start)) <= 86400_000;
  const unmatched = uniqueIncoming.filter(b => !matched.has(b));
  const orphans = candidates.filter(b => !used.has(b.id));
  for (const event of unmatched) {
    const possible = orphans.filter(old => !used.has(old.id) && equivalent(old, event));
    if (possible.length === 1 && unmatched.filter(b => equivalent(possible[0], b)).length === 1) {
      matched.set(event, possible[0]); used.add(possible[0].id);
    }
  }
  const notify: Broadcast[] = [];
  const events = uniqueIncoming.map(event => {
    const old = matched.get(event);
    if (!old) { notify.push(event); return event; }
    const changed = event.start !== old.start || event.end !== old.end || event.channel !== old.channel;
    const next: Broadcast = { ...event, id: old.id, revision: old.revision + (changed ? 1 : 0), change: changed ? 'changed' : old.change };
    if (changed) notify.push(next);
    return next;
  });
  return {
    events: [...active.filter(b => !refreshedDates.includes(b.queryDate)), ...events],
    removed: previous.filter(b => Date.parse(b.end) <= now || refreshedDates.includes(b.queryDate) && !used.has(b.id)),
    notify,
  };
}
