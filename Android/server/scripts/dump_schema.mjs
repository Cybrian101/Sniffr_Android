import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:5433/sniffr_dev' });

async function main() {
  const tablesRes = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE'
    ORDER BY table_name
  `);
  const tables = tablesRes.rows.map(r => r.table_name);

  let out = '-- Auto-generated schema dump from live local Postgres (sniffr_dev)\n';
  out += `-- Generated ${new Date().toISOString()}\n\n`;

  // Enum types (referenced by columns below, must exist before CREATE TABLE)
  const enumsRes = await pool.query(`
    SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) as labels
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    GROUP BY t.typname
    ORDER BY t.typname
  `);
  if (enumsRes.rows.length) {
    out += '-- ============================================================\n-- Enum types\n-- ============================================================\n';
    enumsRes.rows.forEach(en => {
      const labels = (Array.isArray(en.labels) ? en.labels : String(en.labels).replace(/[{}]/g, '').split(','));
      out += `DO $$ BEGIN\n  CREATE TYPE ${en.typname} AS ENUM (${labels.map(l => `'${l}'`).join(', ')});\nEXCEPTION WHEN duplicate_object THEN null;\nEND $$;\n\n`;
    });
  }

  const deferredFks = []; // emitted as ALTER TABLE at the end, after every table exists -- avoids ordering CREATE TABLE by FK dependency

  for (const table of tables) {
    const cols = await pool.query(`
      SELECT column_name, data_type, udt_name, is_nullable, column_default,
             character_maximum_length, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1
      ORDER BY ordinal_position
    `, [table]);

    const pk = await pool.query(`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema='public' AND tc.table_name=$1 AND tc.constraint_type='PRIMARY KEY'
      ORDER BY kcu.ordinal_position
    `, [table]);

    const fks = await pool.query(`
      SELECT
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name,
        rc.update_rule, rc.delete_rule,
        tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      JOIN information_schema.referential_constraints rc
        ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
      WHERE tc.table_schema='public' AND tc.table_name=$1 AND tc.constraint_type='FOREIGN KEY'
    `, [table]);

    const uniques = await pool.query(`
      SELECT tc.constraint_name, array_agg(kcu.column_name ORDER BY kcu.ordinal_position) as cols
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema='public' AND tc.table_name=$1 AND tc.constraint_type='UNIQUE'
      GROUP BY tc.constraint_name
    `, [table]);

    const checks = await pool.query(`
      SELECT cc.constraint_name, cc.check_clause
      FROM information_schema.check_constraints cc
      JOIN information_schema.table_constraints tc
        ON cc.constraint_name = tc.constraint_name AND cc.constraint_schema = tc.table_schema
      WHERE tc.table_schema='public' AND tc.table_name=$1 AND tc.constraint_type='CHECK'
    `, [table]);

    out += `-- ============================================================\n-- Table: ${table}\n-- ============================================================\n`;
    out += `CREATE TABLE IF NOT EXISTS ${table} (\n`;

    const colLines = cols.rows.map(c => {
      let type = c.udt_name;
      const typeMap = {
        int4: 'INTEGER', int8: 'BIGINT', int2: 'SMALLINT',
        varchar: c.character_maximum_length ? `VARCHAR(${c.character_maximum_length})` : 'VARCHAR',
        bpchar: 'CHAR', text: 'TEXT', bool: 'BOOLEAN',
        timestamptz: 'TIMESTAMPTZ', timestamp: 'TIMESTAMP',
        float8: 'DOUBLE PRECISION', float4: 'REAL',
        numeric: c.numeric_precision ? `NUMERIC(${c.numeric_precision}${c.numeric_scale != null ? ',' + c.numeric_scale : ''})` : 'NUMERIC',
        jsonb: 'JSONB', json: 'JSON', uuid: 'UUID', date: 'DATE',
      };
      type = typeMap[c.udt_name] || (c.data_type === 'USER-DEFINED' ? c.udt_name : c.udt_name.toUpperCase());
      // A column whose default is nextval() on its own sequence is a
      // SERIAL/BIGSERIAL -- emit it as such so this file is self-contained
      // (CREATE TABLE ... DEFAULT nextval('x_id_seq') alone would fail
      // against a fresh DB since that sequence doesn't exist yet).
      const isOwnedSequence = c.column_default && /^nextval\(/.test(c.column_default);
      let line;
      if (isOwnedSequence) {
        const serialType = type === 'BIGINT' ? 'BIGSERIAL' : type === 'SMALLINT' ? 'SMALLSERIAL' : 'SERIAL';
        line = `  ${c.column_name.padEnd(35)} ${serialType}`;
      } else {
        line = `  ${c.column_name.padEnd(35)} ${type}`;
        if (c.column_default) line += ` DEFAULT ${c.column_default}`;
      }
      if (c.is_nullable === 'NO') line += ' NOT NULL';
      return line;
    });

    if (pk.rows.length) {
      colLines.push(`  PRIMARY KEY (${pk.rows.map(r => r.column_name).join(', ')})`);
    }
    uniques.rows.forEach(u => {
      const colsArr = Array.isArray(u.cols) ? u.cols : String(u.cols).replace(/[{}]/g, '').split(',');
      colLines.push(`  CONSTRAINT ${u.constraint_name} UNIQUE (${colsArr.join(', ')})`);
    });
    fks.rows.forEach(fk => {
      deferredFks.push(`ALTER TABLE ${table} ADD CONSTRAINT ${fk.constraint_name} FOREIGN KEY (${fk.column_name}) REFERENCES ${fk.foreign_table_name}(${fk.foreign_column_name}) ON UPDATE ${fk.update_rule} ON DELETE ${fk.delete_rule};`);
    });
    checks.rows.forEach(chk => {
      colLines.push(`  CONSTRAINT ${chk.constraint_name} CHECK (${chk.check_clause})`);
    });

    out += colLines.join(',\n');
    out += '\n);\n\n';

    const idx = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname='public' AND tablename=$1
      ORDER BY indexname
    `, [table]);
    const constraintNames = new Set([
      ...pk.rows.length ? [`${table}_pkey`] : [],
      ...uniques.rows.map(u => u.constraint_name),
    ]);
    idx.rows.forEach(i => {
      if (!constraintNames.has(i.indexname)) {
        out += i.indexdef + ';\n';
      }
    });
    out += '\n';
  }

  if (deferredFks.length) {
    out += '-- ============================================================\n-- Foreign keys (added after all tables exist)\n-- ============================================================\n';
    out += deferredFks.join('\n') + '\n';
  }

  console.log(out);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
