import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const secretKeys = /^(authorization|proxy-authorization|cookie|set-cookie|token|access_token|refresh_token|id_token|client_secret|clientSecret|password|secret|(?:x[-_])?api[-_]?key|cpf|cnpj|email|phone|telefone|accountNumber|numeroConta)$/i;
export function redact(value, secrets = []) {
  if (typeof value === 'string') {
    let result = value.replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer ••••••••');
    for (const secret of secrets.filter(v => typeof v === 'string' && v.length > 2)) result = result.split(secret).join('••••••••');
    return result;
  }
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, secretKeys.test(k) ? '••••••••' : redact(v, secrets)]));
  return value;
}
export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function checkPassword(password, hash) {
  const [salt, expected] = hash.split(':');
  return timingSafeEqual(Buffer.from(hashPassword(password, salt).split(':')[1], 'hex'), Buffer.from(expected, 'hex'));
}
export const digest = value => createHash('sha256').update(value).digest('hex');

export function openStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, 'encryption.key');
  if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error('A chave de criptografia deve conter 32 bytes.');
  const dbPath = join(directory, 'nexo.sqlite');
  const db = new DatabaseSync(dbPath);
  chmodSync(dbPath, 0o600);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS documents_kind ON documents(kind);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL);
  `);
  function encrypt(value) {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64')).join('.');
  }
  function decrypt(value) {
    const [iv, tag, data] = value.split('.').map(s => Buffer.from(s, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString());
  }
  function decode(row) {
    if (!row) return null;
    const doc = JSON.parse(row.data);
    if (doc.sealed) return { ...doc, ...decrypt(doc.sealed), sealed: undefined };
    return doc;
  }
  return {
    db, encrypt, decrypt,
    list(kind) { return db.prepare('SELECT data FROM documents WHERE kind = ? ORDER BY rowid DESC').all(kind).map(decode); },
    get(kind, id) { if (!id) return null; return decode(db.prepare('SELECT data FROM documents WHERE kind = ? AND id = ?').get(kind, id)); },
    save(kind, value) {
      const existing = value.id && this.get(kind, value.id);
      const doc = { ...value, id: value.id || randomUUID(), createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), revision: (existing?.revision || 0) + 1 };
      const stored = kind === 'auth' ? { id: doc.id, name: doc.name, type: doc.type, createdAt: doc.createdAt, updatedAt: doc.updatedAt, revision: doc.revision, sealed: encrypt({ environments: doc.environments }) } : doc;
      db.prepare('INSERT INTO documents(kind,id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(kind, doc.id, JSON.stringify(stored));
      return doc;
    },
    remove(kind, id) { db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run(kind, id); },
    settings() { const row = db.prepare("SELECT data FROM settings WHERE id='main'").get(); return row ? JSON.parse(row.data) : { allowedOrigins: [], sensitiveFields: [] }; },
    setSettings(value) { db.prepare("INSERT INTO settings(id,data) VALUES('main',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(JSON.stringify(value)); },
    audit(actor, action, target) { db.prepare('INSERT INTO audit VALUES(?,?,?,?,?)').run(randomUUID(), new Date().toISOString(), actor, action, target); },
    audits() { return db.prepare('SELECT id,created_at AS createdAt,actor,action,target FROM audit ORDER BY rowid DESC LIMIT 300').all(); },
    close() { db.close(); },
  };
}

export function publicAuth(doc) {
  return { ...doc, environments: Object.fromEntries(Object.entries(doc.environments || {}).map(([env, config]) => [env, {
    ...config, token: '', clientSecret: '', headers: {}, body: {},
    configured: Boolean(config.token || config.clientSecret || Object.keys(config.body || {}).length || Object.keys(config.headers || {}).length),
  }])) };
}
