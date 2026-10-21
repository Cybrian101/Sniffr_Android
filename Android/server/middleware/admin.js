import UserRepo from '../models/UserRepository.js';
import { sendServerError } from '../utils/errors.js';

// Platform-admin authorization gate. Meant to run immediately after
// authenticateAccess:
//
//   router.get('/some-admin-route', authenticateAccess, requireAdmin, handler);
//
// authenticateAccess only verifies the JWT and sets req.user to the decoded
// token payload ({ id, email, iat, exp }) -- it never carries admin state,
// and deliberately so: is_admin is intentionally NOT added to the JWT (see
// generateAccessToken in middleware/auth.js). Every request re-checks the
// current is_admin value straight from the users table via the existing
// UserRepository, the same repository/BaseRepository.findById() pattern
// already used elsewhere in the app -- no separate admin lookup mechanism.
// That means revoking admin access (is_admin -> false) takes effect on the
// very next request, without waiting for an already-issued access token to
// expire the way a JWT-embedded claim would.
//
// community_members.role ('Admin'/'Moderator'/etc.) is a per-PawCircle role
// and is never consulted here -- it has no bearing on platform-level access.
export async function requireAdmin(req, res, next) {
  if (!req.user?.id) {
    return res.status(401).json({ error: 'NO_TOKEN', message: 'Access token required' });
  }
  try {
    const user = await UserRepo.findById(req.user.id);
    if (!user || !user.is_admin) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'You do not have permission to access this resource.' });
    }
    next();
  } catch (err) {
    sendServerError(res, err);
  }
}
