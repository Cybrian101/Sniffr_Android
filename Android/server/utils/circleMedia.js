import db from '../db/connection.js';

// The message_type of a PawCircle chat message carrying media, so it's saved
// (and shown) as a photo or video instead of a plain text message.
// From an uploaded file's mimetype, or else from the media URL
// (Cloudinary URLs say /video/upload/ or /image/upload/; a file extension
// is the fallback). Circles accept images and videos only.
const VIDEO_EXT = /\.(mp4|mov|webm|m4v)(\?|#|$)/i;

export function circleMediaType({ mimetype = null, url = null } = {}) {
  if (mimetype) return mimetype.startsWith('video/') ? 'video' : 'image';
  if (!url) return 'text';
  const u = String(url);
  if (u.includes('/video/upload/') || VIDEO_EXT.test(u)) return 'video';
  return 'image';
}

// A media URL a client sends with a circle message (instead of uploading a
// file) must be one of OUR uploads: every upload is recorded in media_files
// (services/mediaService.js uploadWithQuota). Re-sharing a photo already on
// Sniffr works; arbitrary outside links don't. Payment proofs never.
export async function isOwnUploadUrl(url) {
  if (typeof url !== 'string' || !url || url.length > 2048) return false;
  return !!(await db.get(
    "SELECT 1 FROM media_files WHERE url = ? AND COALESCE(subdir, '') <> 'payment_proofs' LIMIT 1", [url]));
}

export const INVALID_MEDIA_BODY = { error: 'INVALID_MEDIA', message: 'Only photos and videos uploaded to Sniffr can be shared here.' };
