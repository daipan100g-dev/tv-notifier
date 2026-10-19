import { DEFAULTS, type Broadcast, type Preferences } from '../shared/model';

export interface SettingsRow { revision: number; preferences: string; last_test_at: number }
export async function settings(db: D1Database): Promise<{ revision: number; preferences: Preferences }> {
  await db.prepare('INSERT OR IGNORE INTO settings (id, preferences) VALUES (1, ?)').bind(JSON.stringify(DEFAULTS)).run();
  const row = (await db.prepare('SELECT revision, preferences FROM settings WHERE id = 1').first<SettingsRow>())!;
  return { revision: row.revision, preferences: JSON.parse(row.preferences) as Preferences };
}

export async function events(db: D1Database): Promise<Broadcast[]> {
  const result = await db.prepare('SELECT event FROM broadcasts ORDER BY ends_at').all<{ event: string }>();
  return result.results.map(row => JSON.parse(row.event) as Broadcast);
}

export async function prune(db: D1Database, now: number) {
  await db.batch([
    db.prepare('DELETE FROM broadcasts WHERE ends_at <= ?').bind(now),
    db.prepare('DELETE FROM poll_parts WHERE created_at < ?').bind(now - 2 * 3600_000),
    db.prepare('DELETE FROM subscriptions WHERE updated_at < ?').bind(now - 90 * 86400_000),
  ]);
}

export async function sourceStatus(db: D1Database, status: string, checked: number, message: string) {
  await db.prepare(`INSERT INTO source_status (id, status, checked_at, last_success_at, message) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status, checked_at=excluded.checked_at,
    last_success_at=COALESCE(excluded.last_success_at, source_status.last_success_at), message=excluded.message`)
    .bind(status, checked, status === 'ok' ? checked : null, message).run();
}
