// Support tool: deletes ("SniffedOut") an account for a user who can't reach
// their email, by the same path as the in-app deletion -- deleteUserAccount()
// with skipCode, then the same post-commit steps as the endpoint
// (services/accountDeletionFollowUp.js): socket announcements (handed to the
// running server(s) through Postgres NOTIFY, since this process has no
// sockets) and the Cloudinary media purge.
//
//   node scripts/deleteAccount.js --user-id N
//
// Shows who the account is first, refuses user 1, admins and accounts that
// are already deleted, and asks you to type the user id again and then
// "production" before anything changes.

import config from '../config.js';
import readline from 'readline/promises';
import { pathToFileURL } from 'url';
import { initDb, getDb, dbAdapter as db } from '../db/connection.js';
import { deleteUserAccount, AccountDeletionError } from '../services/accountDeletion.js';
import { afterAccountDeletion } from '../services/accountDeletionFollowUp.js';

const PROTECTED_USER_ID = 1;
// The support tool can wait longer for the media purge than a request can.
const PURGE_TIMEOUT_MS = 60000;

// Why this account must not be deleted by this tool, or null if it may be.
// `user` is a users row (id, is_admin, deleted_at) or null.
export function deletionRefusal(user) {
  if (!user) return 'no such user';
  if (Number(user.id) === PROTECTED_USER_ID) return 'user 1 is protected';
  if (user.is_admin) return "admin accounts can't be deleted";
  if (user.deleted_at) return 'this account is already deleted';
  return null;
}

// What support sees before confirming.
export async function loadUserSummary(q, userId) {
  const user = await q.get(
    `SELECT id, username, email, full_name, is_admin, deleted_at, created_at,
            current_plan, plan_source, subscription_status, plan_expiry_date
     FROM users WHERE id = ?`, [userId]);
  if (!user) return null;
  const pets = await q.all('SELECT id, name, pet_username, deleted_at FROM pets WHERE user_id = ? ORDER BY id', [userId]);
  return { user, pets };
}

function parseUserId(argv) {
  const i = argv.indexOf('--user-id');
  const raw = i >= 0 ? argv[i + 1] : argv.find(a => a.startsWith('--user-id='))?.split('=')[1];
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const fmtDate = d => (d ? new Date(d).toISOString().slice(0, 10) : '-');

async function main() {
  const userId = parseUserId(process.argv.slice(2));
  if (!userId) {
    console.log('Usage: node scripts/deleteAccount.js --user-id N');
    process.exitCode = 1;
    return;
  }

  await initDb();
  try {
    const summary = await loadUserSummary(db, userId);
    if (summary) {
      const { user, pets } = summary;
      console.log(`\nUser #${user.id}`);
      console.log(`  username:  ${user.username}`);
      console.log(`  email:     ${user.email}`);
      console.log(`  name:      ${user.full_name || '-'}`);
      console.log(`  created:   ${fmtDate(user.created_at)}`);
      console.log(`  plan:      ${user.current_plan} (${user.subscription_status}, source ${user.plan_source}, expires ${fmtDate(user.plan_expiry_date)})`);
      console.log(`  pets:      ${pets.length ? pets.map(p => `#${p.id} ${p.name}${p.pet_username ? ` (@${p.pet_username})` : ''}`).join(', ') : 'none'}`);
    }
    const refusal = deletionRefusal(summary?.user || null);
    if (refusal) {
      console.error(`\nRefusing to delete user #${userId}: ${refusal}.`);
      process.exitCode = 1;
      return;
    }

    const target = new URL(process.env.DATABASE_URL);
    console.log(`\nDatabase: ${target.hostname}:${target.port || 5432}${target.pathname}   Cloudinary: ${config.CLOUDINARY_CLOUD_NAME || '(not set)'}`);
    console.log('This permanently deletes the account above (pets, posts, media). It cannot be undone.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const typedId = await rl.question('Type the user id again to confirm: ');
    if (typedId.trim() !== String(userId)) {
      rl.close();
      console.log('The id did not match -- nothing was done.');
      return;
    }
    const answer = await rl.question('Type "production" to continue: ');
    rl.close();
    if (answer.trim() !== 'production') {
      console.log('Aborted -- nothing was done.');
      return;
    }

    let deleted;
    try {
      deleted = await deleteUserAccount(userId, { skipCode: true });
    } catch (err) {
      if (err instanceof AccountDeletionError) {
        console.error(`\nNot deleted (${err.code}): ${err.message}`);
      } else {
        console.error('\nDeletion failed -- everything was rolled back, nothing was deleted:', err.message);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`\nDeleted user #${userId} (now SniffedOut).`);

    // Same post-commit steps as the in-app deletion.
    const { mediaCleanup, authCleanup } = await afterAccountDeletion(userId, deleted, { purgeTimeoutMs: PURGE_TIMEOUT_MS });
    const left = await db.get(
      "SELECT count(*)::int AS n FROM pending_media_deletions WHERE deleted_user_id = ? AND source <> 'tag_sweep'", [userId]);

    console.log(`  pets tombstoned:       ${deleted.petIds.length}${deleted.petIds.length ? ` (#${deleted.petIds.join(', #')})` : ''}`);
    console.log(`  circles frozen:        ${deleted.ownedCircleIds.length}${deleted.ownedCircleIds.length ? ` (#${deleted.ownedCircleIds.join(', #')})` : ''}`);
    console.log(`  chats now read-only:   ${deleted.conversationIds.length}`);
    console.log(`  media files queued:    ${deleted.pendingMediaCount}`);
    console.log(`  media files purged:    ${Math.max(0, deleted.pendingMediaCount - left.n)}${left.n ? ` (${left.n} left for the hourly retry)` : ''}  [${mediaCleanup}]`);
    console.log(`  Supabase identity:     ${deleted.authUserId ? (authCleanup === 'complete' ? 'deleted' : 'queued for retry (hourly)') : 'none (not an email/password account)'}`);
    console.log('  live sessions:         told to sign out (via the running server, if one is up)');
    console.log('  final tag sweep:       queued for the hourly job');
  } finally {
    await getDb().end();
  }
}

// Runs only when executed directly (the test imports deletionRefusal).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  }).then(() => process.exit(process.exitCode || 0));
}
