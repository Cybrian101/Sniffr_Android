// One-off: apply every server/db/sql/*.sql migration (in filename/date
// order) against the local throwaway Postgres from npm run db:local. Each
// file is additive/idempotent (IF NOT EXISTS, ON CONFLICT, etc.) by its own
// convention for the real Supabase project, so safe to run here too.
import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(__dirname, '..', 'db', 'sql');

const client = new pg.Client({
  connectionString: 'postgresql://postgres:postgres@127.0.0.1:5433/sniffr_dev',
});

async function main() {
  await client.connect();
  const files = (await readdir(SQL_DIR)).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    console.log(`[apply-local-sql] ${file}`);
    const sql = await readFile(path.join(SQL_DIR, file), 'utf8');
    try {
      await client.query(sql);
    } catch (err) {
      console.error(`[apply-local-sql]   FAILED: ${err.message}`);
    }
  }
  await client.end();
  console.log('[apply-local-sql] done.');
}

main().catch(err => { console.error(err); process.exit(1); });
