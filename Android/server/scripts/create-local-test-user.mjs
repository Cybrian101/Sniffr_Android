// One-off: create a throwaway test account directly in the local throwaway
// Postgres (no auth_user_id set, so routes/auth.js's /login falls back to
// the legacy bcrypt path -- same technique server/scripts/testBlocking.js
// uses -- no Supabase credentials needed for this local session).
import bcrypt from 'bcryptjs';
import pg from 'pg';

const client = new pg.Client({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:5433/sniffr_dev' });
const EMAIL = 'claude-qa@example.invalid';
const USERNAME = 'claude_qa';
const PASSWORD = 'TestPass123!';

async function main() {
  await client.connect();
  const hash = await bcrypt.hash(PASSWORD, 10);
  const { rows } = await client.query(
    `INSERT INTO users (email, username, password_hash, full_name, email_verified)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id`,
    [EMAIL, USERNAME, hash, 'Claude QA']
  );
  console.log(JSON.stringify({ userId: rows[0].id, email: EMAIL, username: USERNAME, password: PASSWORD }));
  await client.end();
}

main().catch(err => { console.error(err); process.exit(1); });
