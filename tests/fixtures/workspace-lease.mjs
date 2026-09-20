import { SqliteDatabase, RepositoryLease } from '../../src/index.mjs';
const [path, identity, phase = 'acquire'] = process.argv.slice(2);
if (path) {
  const database = await SqliteDatabase.open({ path }), leases = new RepositoryLease({ database, leaseMs: 1 });
  try {
    const lease = leases.acquire(identity, 'child-task'); console.log('LEASE_OK');
    if (phase === 'hold') { process.send?.(lease); setInterval(() => {}, 1000); }
    else if (phase === 'release') { leases.release(lease.lease_id); database.close(); }
    else { database.close(); }
  } catch (error) { console.log(error.code); database.close(); }
}
