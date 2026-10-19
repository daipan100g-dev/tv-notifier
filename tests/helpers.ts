import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createECDH, randomBytes } from 'node:crypto';
import webPush from 'web-push';
import type { Env } from '../worker/scheduler';

export function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  let queries = 0;
  class Statement {
    constructor(readonly sql: string, readonly values: (string | number | null)[] = []) {}
    bind(...values: (string | number | null)[]) { return new Statement(this.sql, values); }
    async first() { queries++; return sqlite.prepare(this.sql).get(...this.values) || null; }
    async all() { queries++; return { results: sqlite.prepare(this.sql).all(...this.values), success: true }; }
    async run() { queries++; return { success: true, meta: { changes: Number(sqlite.prepare(this.sql).run(...this.values).changes) } }; }
  }
  const db = {
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN');
      try { const result = await Promise.all(statements.map(s => s.run())); sqlite.exec('COMMIT'); return result; }
      catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
  } as unknown as D1Database;
  return { db, sqlite, get queries() { return queries; }, resetQueries() { queries = 0; } };
}

export function fixtureEnv(db: D1Database): Env {
  const keys = webPush.generateVAPIDKeys();
  return { DB: db, NHK_API_KEY: 'test-api-key', OWNER_TOKEN: 'test-owner-token-not-a-real-secret-1234',
    APP_ORIGIN: 'https://example.github.io', APP_URL: 'https://example.github.io/tv-notifier/',
    VAPID_SUBJECT: 'https://example.com', VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey };
}

export function fixtureSubscription() {
  const ecdh = createECDH('prime256v1');
  return { endpoint: 'https://web.push.apple.com/test-subscription', expirationTime: null,
    keys: { p256dh: ecdh.generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}
