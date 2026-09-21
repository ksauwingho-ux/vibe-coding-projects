// 本地台账存储。仅 adapters/table.js 允许 import 这里；业务层一律走 Table 适配器。

import {DatabaseSync} from 'node:sqlite';
import {readFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {POLICY_DEFAULTS} from '../config.js';
import {nowUtc} from '../lib/util.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = process.env.DB_PATH || join(here, '../../../data/attendance.db');

let db = null;

export function openDb(path = DEFAULT_PATH) {
  if (db) return db;
  if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true});
  db = new DatabaseSync(path);
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  seedPolicies(db);
  return db;
}

export function getDb() {
  if (!db) return openDb();
  return db;
}

export function closeDb() {
  if (db) { db.close(); db = null; }
}

/** 政策默认值只在缺失时写入；已被管理员确认或修改过的条目不覆盖。 */
function seedPolicies(handle) {
  const exists = handle.prepare('SELECT key FROM policy_setting WHERE key = ?');
  const insert = handle.prepare(
    `INSERT INTO policy_setting (key, value, decision_ref, confirmed, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const p of POLICY_DEFAULTS) {
    if (!exists.get(p.key)) {
      insert.run(p.key, p.value, p.decision_ref, p.confirmed ? 1 : 0, p.note, nowUtc());
    }
  }
}
