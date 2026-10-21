// Throwaway local Postgres for dev/testing — NOT the real Supabase project.
// Spawns a self-contained Postgres cluster (binary lives in node_modules,
// data lives in server/.local-pg-data/) and keeps it running until this
// process is killed. server/.env points DATABASE_URL at it.
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import EmbeddedPostgres from 'embedded-postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '.local-pg-data');
const SCHEMA_FILE = path.join(__dirname, '..', 'db', 'local-schema.sql');
const DB_NAME = 'sniffr_dev';
const PORT = 5433;

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: true,
  // Force UTF8/C locale — the OS default locale here maps to a WIN1252 server
  // encoding, which can't store the emoji this app writes into text columns
  // (notification titles, etc.), and this only matters at initdb time.
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
});

async function main() {
  const alreadyInitialised = existsSync(path.join(DATA_DIR, 'PG_VERSION'));
  if (!alreadyInitialised) {
    console.log('[local-db] initialising new Postgres data directory...');
    await pg.initialise();
  }

  console.log('[local-db] starting Postgres...');
  await pg.start();

  const client = pg.getPgClient();
  await client.connect();
  const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
  if (rows.length === 0) {
    console.log(`[local-db] creating database "${DB_NAME}"...`);
    await client.query(`CREATE DATABASE ${client.escapeIdentifier(DB_NAME)}`);
  }
  await client.end();

  if (existsSync(SCHEMA_FILE)) {
    console.log('[local-db] applying schema...');
    const schemaSql = await readFile(SCHEMA_FILE, 'utf8');
    const dbClient = pg.getPgClient(DB_NAME);
    await dbClient.connect();
    await dbClient.query(schemaSql);
    await dbClient.end();
    console.log('[local-db] schema applied.');
  } else {
    console.warn(`[local-db] no schema file at ${SCHEMA_FILE} — database is empty.`);
  }

  console.log(`[local-db] ready on postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB_NAME}`);
  console.log('[local-db] leave this running — Ctrl+C to stop.');
}

main().catch(err => {
  console.error('[local-db] failed:', err);
  process.exit(1);
});
