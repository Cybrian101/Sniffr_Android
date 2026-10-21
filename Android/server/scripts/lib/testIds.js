import crypto from 'crypto';

// Shared by the test/demo scripts in server/scripts.
//
// Pet usernames are required and must be 3-20 characters of lowercase
// letters, digits and underscores (server/utils/petUsername.js), and unique.
// Returns `<prefix>_<12 random hex chars>`: the prefix is trimmed to 7
// characters, so the result is at most 20, and the random part makes a
// collision (or a reserved page name such as "home") practically impossible.
// The result is also a valid @mention handle.
export function testPetUsername(prefix = 'pet') {
  const p = String(prefix).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 7) || 'pet';
  return `${p}_${crypto.randomBytes(6).toString('hex')}`;
}
