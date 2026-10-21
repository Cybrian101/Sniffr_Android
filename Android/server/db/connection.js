import pg from 'pg';
const { Pool } = pg;

let pool;

export async function initDb() {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Supabase requires SSL; DATABASE_SSL=false opts out for a plain local
    // Postgres (e.g. local dev) that has no SSL configured.
    //
    // rejectUnauthorized is false here deliberately, on a wrong assumption
    // corrected the hard way: Supabase's connection *pooler* (Supavisor,
    // the :6543 "pooler.supabase.com" endpoint most apps actually use, as
    // this one does) presents a certificate chain Node's default trusted
    // CA store does not recognize -- turning this on crashed the server on
    // every boot in production with SELF_SIGNED_CERT_IN_CHAIN. The traffic
    // is still encrypted (TLS is on), this only skips validating the
    // chain against a CA bundle, which is the standard/accepted tradeoff
    // for Supabase's pooler specifically -- their own client libraries and
    // docs use the same setting for this exact endpoint.
    ssl: process.env.DATABASE_SSL === 'false'
      ? false
      : { rejectUnauthorized: false },
  });

  // An idle pooled connection can be dropped by the Supabase pooler or a
  // Postgres restart. pg reports that as an 'error' event on the pool, and
  // an EventEmitter 'error' with no listener throws and exits the process.
  // The pool discards the broken client and opens a new one when needed.
  pool.on('error', (err) => {
    console.error('[pg pool] idle connection error (client discarded):', err.message);
  });

  // quick connectivity check on boot, fails loudly if DATABASE_URL is wrong
  await pool.query('SELECT 1');
  // Host and port only (never the password) -- e.g. to confirm the session
  // pooler (5432), which the account-deletion LISTEN/NOTIFY hand-off needs.
  let where = '';
  try {
    const url = new URL(process.env.DATABASE_URL);
    where = ` (${url.hostname}:${url.port || 5432})`;
  } catch { /* unparsable URL: leave it out */ }
  console.log(`✅ Connected to Postgres${where}`);

  return pool;
}

export function getDb() {
  if (!pool) throw new Error('Database not initialized. Call initDb() first.');
  return pool;
}

// Converts '?' placeholders (SQLite style) to '$1, $2, ...' (Postgres style)
// so the rest of the app's SQL strings don't need to change.
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Builds the run/get/all/exec interface on top of anything with a pg-style
// .query() -- the pool (dbAdapter below) or one checked-out client
// (withTransaction). `getQueryable` is resolved per call, so dbAdapter still
// throws "Database not initialized" lazily, exactly as before.
function createAdapter(getQueryable) {
  return {
    async run(sql, params = []) {
      const pgSql = toPgPlaceholders(sql);
      const result = await getQueryable().query(pgSql, params);
      // Postgres doesn't have lastInsertRowid — callers that need the new row's id
      // should use `... RETURNING id` in their SQL and read result.rows[0].id instead.
      return { rowCount: result.rowCount, rows: result.rows };
    },
    async get(sql, params = []) {
      const pgSql = toPgPlaceholders(sql);
      const result = await getQueryable().query(pgSql, params);
      return result.rows[0] || null;
    },
    async all(sql, params = []) {
      const pgSql = toPgPlaceholders(sql);
      const result = await getQueryable().query(pgSql, params);
      return result.rows;
    },
    async exec(sql) {
      return getQueryable().query(sql);
    }
  };
}

// DB-agnostic query interface — same method names as the old sql.js adapter
export const dbAdapter = createAdapter(getDb);

// Runs fn(tx) inside one transaction on a single pooled client. `tx` has the
// same run/get/all/exec methods as dbAdapter, but every query goes through
// that client, so they all commit or roll back together. Any error thrown by
// fn (or by COMMIT) rolls back and is rethrown; the client is always released.
export async function withTransaction(fn) {
  const client = await getDb().connect();
  let rollbackFailed = false;
  // A checked-out client has no pool listener: if its connection drops
  // between two queries, its 'error' event would otherwise crash the process.
  // The next query on it rejects, which rolls the transaction back below.
  const onClientError = (err) => console.error('[withTransaction] connection error:', err.message);
  client.on('error', onClientError);
  try {
    await client.query('BEGIN');
    const result = await fn(createAdapter(() => client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      rollbackFailed = true;
      console.error('[withTransaction] ROLLBACK failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    // A client whose ROLLBACK failed may be mid-transaction -- destroy it
    // rather than hand it back to the pool.
    client.removeListener('error', onClientError);
    client.release(rollbackFailed);
  }
}

export default dbAdapter;