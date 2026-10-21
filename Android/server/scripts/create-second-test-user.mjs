// One-off: second throwaway local test account + pet, matched with the
// existing claude_qa/Buddy pair, so calling can be tested end-to-end
// between two real logged-in sessions. Delete after use.
import bcrypt from 'bcryptjs';
import pg from 'pg';

const client = new pg.Client({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:5433/sniffr_dev' });
const EMAIL = 'claude-qa2@example.invalid';
const USERNAME = 'claude_qa2';
const PASSWORD = 'TestPass123!';

async function main() {
  await client.connect();
  const hash = await bcrypt.hash(PASSWORD, 10);
  const { rows: [user] } = await client.query(
    `INSERT INTO users (email, username, password_hash, full_name, email_verified)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id`,
    [EMAIL, USERNAME, hash, 'Claude QA 2']
  );

  const { rows: [existingPet] } = await client.query('SELECT id FROM pets WHERE user_id = $1', [user.id]);
  let petId;
  if (existingPet) {
    petId = existingPet.id;
  } else {
    const { rows: [pet] } = await client.query(
      `INSERT INTO pets (user_id, name, pet_username, type, gender, age, breed_type, breed_name, bio, country, state, city, area, latitude, longitude)
       VALUES ($1, 'Rex', '@claude_qa2_pup', 'dog', 'male', 2, 'Original', 'Labrador', 'Local QA test pup 2', 'India', 'Tamil Nadu', 'Chennai', 'Zone 9 Teynampet', 13.05, 80.25)
       RETURNING id`,
      [user.id]
    );
    petId = pet.id;
  }

  const { rows: [buddy] } = await client.query("SELECT id FROM pets WHERE pet_username = '@claude_qa_pup'");
  if (buddy) {
    const { rows: [existingMatch] } = await client.query(
      'SELECT id FROM matches WHERE (pet1_id = $1 AND pet2_id = $2) OR (pet1_id = $2 AND pet2_id = $1)',
      [buddy.id, petId]
    );
    if (!existingMatch) {
      await client.query('INSERT INTO matches (pet1_id, pet2_id, source) VALUES ($1, $2, $3)', [buddy.id, petId, 'meet']);
    }
  }

  console.log(JSON.stringify({ userId: user.id, petId, buddyId: buddy?.id, email: EMAIL, username: USERNAME, password: PASSWORD }));
  await client.end();
}

main().catch(err => { console.error(err); process.exit(1); });
