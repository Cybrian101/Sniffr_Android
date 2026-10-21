// Unit checks for the Phase 1 security fixes that need no database, no
// network and no running server: purpose-bound tokens (2FA temp token,
// Google sign-up ticket), the sealed Supabase session, the access-token
// check refusing temp tokens, the socket handler guard, the send_message
// validator, GPS stripping and the per-viewer live distance, and the
// client's safe link filter. The flows that need the database and the
// running backend are in testSecurityPhase1.js.
//
//   node scripts/testSecurityPhase1Unit.js

import { EventEmitter } from 'events';
import jwt from 'jsonwebtoken';
await import('../config.js');
const { default: config } = await import('../config.js');
const {
  signPurposeToken, verifyPurposeToken, sealSecret, openSecret,
  verifyAccessToken, generateAccessToken, authenticateAccess,
} = await import('../middleware/auth.js');
const { guardSocketHandlers, toId } = await import('../socket/safeHandlers.js');
const { validateSocketMessage } = await import('../socket/chat.js');
const { toPublicPet, toPublicPets } = await import('../utils/publicPet.js');
const { emitLiveLocation } = await import('../socket/meet.js');
const { safeLinkUrl } = await import('../../client/src/utils/media.js');

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail !== '' ? ` -- got ${detail}` : ''}`); }
}
const section = t => console.log(`\n── ${t}`);
const throws = fn => { try { fn(); return false; } catch { return true; } };
const tick = () => new Promise(r => setTimeout(r, 20));

let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

section('1. Purpose-bound tokens (H1, H2)');
{
  const t = signPurposeToken('2fa_login', { id: 42 }, '10m');
  check('2FA temp token verifies for its own purpose', verifyPurposeToken('2fa_login', t).id === 42);
  check('...but not as a Google sign-up ticket', throws(() => verifyPurposeToken('google_signup', t)));
  check('...and never as an access token', throws(() => verifyAccessToken(t)));
  const ticket = signPurposeToken('google_signup', { email: 'a@example.invalid' }, '30m');
  check('sign-up ticket carries the verified email', verifyPurposeToken('google_signup', ticket).email === 'a@example.invalid');
  check('a ticket signed with another key is refused',
    throws(() => verifyPurposeToken('google_signup', jwt.sign({ purpose: 'google_signup', email: 'x@example.invalid' }, 'not-our-key'))));
  check('a ticket signed with the ACCESS secret is refused',
    throws(() => verifyPurposeToken('google_signup', jwt.sign({ purpose: 'google_signup', email: 'x@example.invalid' }, config.JWT_ACCESS_SECRET))));
  check('an expired ticket is refused', throws(() => verifyPurposeToken('google_signup', signPurposeToken('google_signup', { email: 'e' }, -10))));
  check('garbage is refused', throws(() => verifyPurposeToken('google_signup', 'abc')) && throws(() => verifyPurposeToken('google_signup', undefined)));
}

section('2. Sealed Supabase session inside the temp token (H1)');
{
  const sealed = sealSecret('2fa_login', { a: 'access-xyz', r: 'refresh-xyz' });
  check('the token payload does not contain the session in readable form', !sealed.includes('access-xyz') && !Buffer.from(sealed, 'base64url').toString().includes('access-xyz'));
  const opened = openSecret('2fa_login', sealed);
  check('the server can open it', opened.a === 'access-xyz' && opened.r === 'refresh-xyz');
  const buf = Buffer.from(sealed, 'base64url'); buf[buf.length - 1] ^= 1;
  check('a tampered value is refused', throws(() => openSecret('2fa_login', buf.toString('base64url'))));
  check('another purpose cannot open it', throws(() => openSecret('google_signup', sealed)));
}

section('3. Access-token check refuses 2FA temp tokens (H1)');
{
  const run = token => new Promise(resolve => {
    const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; resolve({ res: this, next: false }); return this; } };
    authenticateAccess({ headers: { authorization: `Bearer ${token}` } }, res, () => resolve({ res, next: true }));
  });
  const oldTemp = jwt.sign({ id: 999999, is2FATemp: true }, config.JWT_ACCESS_SECRET, { expiresIn: '10m', algorithm: 'HS256' });
  const r1 = await run(oldTemp);
  check('an old-format temp token (signed with the access secret) is refused with 401', r1.res.code === 401 && r1.res.body?.error === 'INVALID_TOKEN' && !r1.next, JSON.stringify(r1.res.body));
  const purposeLike = jwt.sign({ id: 999999, purpose: 'x' }, config.JWT_ACCESS_SECRET, { algorithm: 'HS256' });
  const r2 = await run(purposeLike);
  check('a purpose token signed with the access secret is refused', r2.res.code === 401 && !r2.next);
  // A real access token passes the token stage and reaches the account
  // check, which needs the database (not initialised here) -> 500.
  const r3 = await run(generateAccessToken({ id: 999999, email: 'x@example.invalid' }));
  check('a real access token still passes the token check (reaches the account check)', r3.res.code === 500 && r3.res.body?.error === 'SERVER_ERROR', `${r3.res.code} ${JSON.stringify(r3.res.body)}`);
}

section('4. Socket handler guard (C2)');
{
  const socket = new EventEmitter();
  socket.user = { id: 7 };
  let nextCalled = false;
  guardSocketHandlers(socket, () => { nextCalled = true; });
  check('middleware calls next()', nextCalled);

  const seen = [];
  socket.on('join_conversation', ({ conversationId }) => { seen.push(conversationId); });
  let crashed = false;
  try {
    for (const payload of [null, undefined, 'text', 42, [1, 2], { conversationId: 3 }]) socket.emit('join_conversation', payload);
    socket.emit('join_conversation');
  } catch { crashed = true; }
  check('null / undefined / string / number / array / no payload never throw', !crashed);
  check('...and a real payload still arrives', seen.at(-2) === 3, JSON.stringify(seen));

  let ackResult = null;
  socket.on('join_community_chat', ({ communityId } = {}, ack) => { ack({ communityId: communityId ?? null }); });
  socket.emit('join_community_chat', (r) => { ackResult = r; });
  check('an ack sent without a payload keeps its place', ackResult && ackResult.communityId === null, JSON.stringify(ackResult));

  socket.on('throws_sync', () => { throw new Error('boom'); });
  let syncCrash = false;
  try { socket.emit('throws_sync', {}); } catch { syncCrash = true; }
  check('a handler that throws synchronously is contained', !syncCrash);

  socket.on('rejects_async', async ({ x }) => { throw new Error(`async boom ${x}`); });
  socket.emit('rejects_async', null);
  await tick();
  check('an async handler that rejects causes no unhandled rejection', unhandled === 0, unhandled);

  let reason = null;
  socket.on('disconnect', (r) => { reason = r; });
  socket.emit('disconnect', 'transport close');
  check("reserved events (disconnect) get their arguments unchanged", reason === 'transport close', reason);

  check('toId: integers and digit strings only',
    toId(5) === 5 && toId('12') === 12 && toId('x') === null && toId('1; DROP') === null && toId(-1) === null && toId(0) === null && toId(1.5) === null && toId(null) === null && toId({}) === null);
}

section('5. send_message validation (H5)');
{
  const ok = (t, c, m) => validateSocketMessage(t, c, m);
  check('plain text is accepted', ok('text', 'hello')?.messageType === 'text' && ok('text', 'hello').mediaUrl === null);
  check('empty text is refused', ok('text', '   ') === null && ok('text', '') === null);
  check('text carrying a link as media is refused', ok('text', 'hi', 'https://evil.example/pixel.png') === null);
  for (const t of ['image', 'video', 'voice', 'file', 'system', 'shared_post', 'call', '<script>']) {
    check(`type "${t}" cannot be sent over the socket`, ok(t, 'x', 'https://evil.example/a') === null && ok(t, 'x') === null);
  }
  check('pet_profile with a pet id is accepted (normalized)', ok('pet_profile', '🐶 Profile shared', '12')?.mediaUrl === '12' && ok('pet_profile', 'x', 12)?.mediaUrl === '12');
  check('pet_profile with a link is refused', ok('pet_profile', 'x', 'javascript:alert(1)') === null && ok('pet_profile', 'x', 'https://evil.example') === null);
  check('meetup with a JSON object is accepted', ok('meetup', JSON.stringify({ place: 'Park', time: 'now' }))?.messageType === 'meetup');
  check('meetup that is not a JSON object is refused', ok('meetup', 'not json') === null && ok('meetup', '[1,2]') === null && ok('meetup', '"str"') === null);
  check('meetup with media is refused', ok('meetup', '{}', 'https://evil.example') === null);
  check('non-string content is refused', ok('text', { a: 1 }) === null && ok('text', 123) === null);
  check('content over 10000 characters is refused', ok('text', 'a'.repeat(10001)) === null && !!ok('text', 'a'.repeat(10000)));
}

section('6. No GPS for other users (H4)');
{
  const pet = { id: 1, user_id: 2, name: 'Kitty', latitude: 12.97, longitude: 77.59, last_updated_location_timestamp: 't', city: 'Bengaluru' };
  const pub = toPublicPet(pet);
  check('coordinates and location timestamp removed', !('latitude' in pub) && !('longitude' in pub) && !('last_updated_location_timestamp' in pub));
  check('everything else kept (name, city)', pub.name === 'Kitty' && pub.city === 'Bengaluru');
  check('the original row is not modified (own-profile paths still have it)', pet.latitude === 12.97);
  check('arrays and nullish values handled', toPublicPets([pet])[0].latitude === undefined && toPublicPet(null) === null && toPublicPets(undefined) === undefined);

  const emitted = {};
  const mk = (id, userId, center) => ({ user: { id: userId }, data: { meetCenter: center }, emit: (ev, payload) => { emitted[id] = { ev, payload }; } });
  const sockets = new Map([
    ['viewer', mk('viewer', 9, { lat: 12.98, lng: 77.59 })],
    ['owner', mk('owner', 2, { lat: 12.97, lng: 77.59 })],
    ['nocenter', mk('nocenter', 10, null)],
  ]);
  const io = { sockets: { adapter: { rooms: new Map([['meet_live', new Set(sockets.keys())]]) }, sockets } };
  emitLiveLocation(io, { pet, latitude: 12.97, longitude: 77.59, timestamp: 't' });
  const v = emitted.viewer?.payload;
  check('a Meet viewer gets the distance from its own centre', emitted.viewer?.ev === 'location_updated' && Math.abs(v.distance - 1.11) < 0.05, JSON.stringify(v));
  check('...and no coordinates anywhere in the payload', !JSON.stringify(v).includes('latitude') && !JSON.stringify(v).includes('77.59'));
  check("the moving pet's owner is skipped", !emitted.owner);
  check('a viewer that sent no centre gets nothing', !emitted.nocenter);
}

section('7. Client link filter (H5)');
{
  check('https and same-origin paths kept', safeLinkUrl('https://res.cloudinary.com/x/raw/upload/a.pdf') === 'https://res.cloudinary.com/x/raw/upload/a.pdf' && safeLinkUrl('/uploads/chat/a.pdf') === '/uploads/chat/a.pdf');
  check('javascript: / data: / scheme-relative refused',
    safeLinkUrl('javascript:alert(1)') === undefined && safeLinkUrl(' JavaScript:alert(1)') === undefined
    && safeLinkUrl('data:text/html,<script>') === undefined && safeLinkUrl('//evil.example/x') === undefined);
  check('non-strings refused', safeLinkUrl(null) === undefined && safeLinkUrl({}) === undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
