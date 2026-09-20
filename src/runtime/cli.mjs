import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { SqliteDatabase } from './stores/sqlite-database.mjs';
import { SqliteStateStore } from './stores/sqlite-state-store.mjs';

const [command, path, taskId] = process.argv.slice(2);
try {
  if (command === 'migrate' || command === 'inspect') {
    const database = await SqliteDatabase.open({ path });
    try {
      const state = new SqliteStateStore({ database });
      const result = command === 'migrate' ? { storage_schema_version: 1, database: database.path } : await state.recover(taskId);
      console.log(JSON.stringify(result, null, 2));
    } finally { database.close(); }
  } else if (command === 'recover') {
    // Configuration is local trusted executable code, not a model/message payload.
    const { createHost } = await import(pathToFileURL(resolve(path)).href);
    const { host, database } = await createHost();
    try {
      let input = ''; for await (const chunk of process.stdin) input += chunk;
      console.log(JSON.stringify(await host.recoverTask(JSON.parse(input)), null, 2));
    } finally { try { await host.close(); } finally { database?.close(); } }
  } else throw new Error('Usage: node src/runtime/cli.mjs migrate DB | inspect DB TASK | recover TRUSTED_CONFIG (request JSON on stdin)');
} catch (error) { console.error(JSON.stringify({ code: error.code ?? 'RUNTIME_FAILURE', message: error.message })); process.exitCode = 1; }
