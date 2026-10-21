// Wraps the configured storage adapter (Cloudinary/local, see storage/index.js)
// with per-user quota enforcement and usage tracking in Postgres. Postgres
// never holds the media bytes themselves -- only the running total and a
// per-file record (url/size/provider), so quota checks don't need to ask
// Cloudinary for anything at request time.
import storage from '../storage/index.js';
import db from '../db/connection.js';
import config from '../config.js';
import { verifyFileSignature } from '../utils/fileSignature.js';
import { hasCurrentAccess } from './subscriptionService.js';

export class QuotaExceededError extends Error {
  constructor(usedBytes, quotaBytes) {
    super('Storage quota exceeded');
    this.name = 'QuotaExceededError';
    this.usedBytes = usedBytes;
    this.quotaBytes = quotaBytes;
  }
}

export class InvalidFileError extends Error {
  constructor() {
    super('File content does not match its declared type');
    this.name = 'InvalidFileError';
  }
}

function quotaForPlan(plan) {
  return config.STORAGE_QUOTA_BYTES[plan] || config.STORAGE_QUOTA_BYTES.free;
}

// M21: an expired plan's `current_plan` column stays whatever it last was
// (e.g. 'platinum') until something calls subscriptionService's lazy-expiry
// check for that user (login, a premium-state read) -- a storage-quota
// check in between must not trust that stale column, or an expired
// Platinum user keeps a 20GB quota indefinitely just by never logging out.
// hasCurrentAccess() is the same "is this plan actually still live" rule
// subscriptionService.js itself uses everywhere else, applied here too so
// quota and premium-gate state can never drift apart.
export async function getUserStorageStatus(userId) {
  const user = await db.get(
    'SELECT current_plan, subscription_status, plan_expiry_date, storage_used_bytes, storage_quota_override_bytes FROM users WHERE id = ?',
    [userId]
  );
  if (!user) throw new Error('User not found');
  const effectivePlan = hasCurrentAccess(user) ? (user.current_plan || 'free') : 'free';
  const quotaBytes = user.storage_quota_override_bytes != null
    ? Number(user.storage_quota_override_bytes)
    : quotaForPlan(effectivePlan);
  return { usedBytes: Number(user.storage_used_bytes) || 0, quotaBytes };
}

// Checks quota BEFORE spending upload bandwidth/Cloudinary usage, uploads via
// the existing storage adapter unchanged, then records the file and bumps
// the user's running total. Throws QuotaExceededError (handled centrally by
// utils/errors.js -> 413) if the file would put the user over quota.
export async function uploadWithQuota(userId, file, subdir) {
  // (userId also tags the upload with its owner -- see CloudStorage.ownerTag.)
  if (!verifyFileSignature(file.buffer, file.mimetype)) {
    throw new InvalidFileError();
  }

  const { usedBytes, quotaBytes } = await getUserStorageStatus(userId);
  // Gate check uses the raw upload size, not the (possibly smaller,
  // post-compression) stored size -- that isn't known until after the
  // upload actually runs. Conservative but safe: the real stored size can
  // only end up <= this, never more, so this can't under-reject.
  if (usedBytes + file.size > quotaBytes) {
    throw new QuotaExceededError(usedBytes, quotaBytes);
  }

  const { filePath, bytes: storedBytes } = await storage.upload(file, subdir, { userId });
  const url = storage.getUrl(filePath);

  const resourceType = file.mimetype.startsWith('audio') ? 'audio'
    : file.mimetype.startsWith('video') ? 'video'
    : config.ALLOWED_DOCUMENT_TYPES.includes(file.mimetype) ? 'document'
    : 'image';

  // storedBytes (not file.size) is what actually counts against quota --
  // for images on Cloudinary this is the post-compression size (see
  // CloudStorage.js), genuinely smaller than what was uploaded, so a
  // compressed image costs the user less of their quota than its original
  // size would have.
  await db.run(
    'INSERT INTO media_files (user_id, url, bytes, provider, resource_type, subdir) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, url, storedBytes, config.STORAGE_TYPE === 'cloud' ? 'cloudinary' : 'local', resourceType, subdir]
  );
  await db.run('UPDATE users SET storage_used_bytes = storage_used_bytes + ? WHERE id = ?', [storedBytes, userId]);

  return { url, bytes: storedBytes };
}
