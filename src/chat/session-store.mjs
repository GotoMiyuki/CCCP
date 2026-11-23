import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function openSessionStore(path) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 14)) throw new Error('交互宿主需要 Node.js 24.14 或以上');

  await mkdir(dirname(path), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { timeout: 5000, allowExtension: false });
  try {
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    create(project) {
      const session = { id: randomUUID(), project, messages: [], drafts: [] };
      db.prepare('INSERT INTO chat_sessions VALUES (?, 0, ?)').run(session.id, JSON.stringify(session));
      return { ...session, revision: 0 };
    },
    load(id) {
      const row = db.prepare('SELECT revision, data FROM chat_sessions WHERE id = ?').get(id);
      if (!row) throw new Error('找不到这个会话，请检查会话 ID 和启动目录');
      return { ...JSON.parse(row.data), revision: row.revision };
    },
    save(session, changes) {
      const { revision, ...current } = session;
      const next = { ...current, ...changes };
      const result = db.prepare('UPDATE chat_sessions SET revision = revision + 1, data = ? WHERE id = ? AND revision = ?')
        .run(JSON.stringify(next), session.id, revision);
      if (result.changes === 0) throw new Error('另一终端已更新该会话，请退出并重新打开后继续');
      return { ...next, revision: revision + 1 };
    },
    close() { db.close(); },
  };
}
