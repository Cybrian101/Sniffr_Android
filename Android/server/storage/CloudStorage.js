import { StorageAdapter } from './StorageAdapter.js';
import { v2 as cloudinary } from 'cloudinary';
import config from '../config.js';

cloudinary.config({
  cloud_name: config.CLOUDINARY_CLOUD_NAME,
  api_key: config.CLOUDINARY_API_KEY,
  api_secret: config.CLOUDINARY_API_SECRET,
});

// Every upload is tagged with its owner so an account deletion can find all
// of a user's files, even ones no database row points at any more. Payment
// proofs get a different tag on purpose: they are kept for finance and must
// never be caught by a user_<id> sweep.
export function ownerTag(userId, subdir) {
  if (!userId) return null;
  return subdir === 'payment_proofs' ? `payproof_user_${userId}` : `user_${userId}`;
}

export class CloudStorage extends StorageAdapter {
  async upload(file, subdir = '', { userId = null } = {}) {
    const tag = ownerTag(userId, subdir);
    return new Promise((resolve, reject) => {
      // Cloudinary has no separate "audio" resource type -- audio files
      // (voice notes) must be uploaded as resource_type 'video' too, or
      // Cloudinary rejects/mishandles them. See voice-note playback fix.
      const isVideo = file.mimetype.startsWith('video') || file.mimetype.startsWith('audio');
      // Documents (PDF/Word/Excel/PowerPoint/text) aren't valid Cloudinary
      // "image" resources -- uploading a .docx with resource_type: 'image'
      // gets rejected outright. 'raw' is Cloudinary's catch-all for
      // arbitrary non-image/video files.
      const isDocument = config.ALLOWED_DOCUMENT_TYPES.includes(file.mimetype);
      const resourceType = isVideo ? 'video' : isDocument ? 'raw' : 'image';
      const options = {
        folder: `sniffr/${subdir}`,
        resource_type: resourceType,
      };
      // Images only, for now: an *incoming* transformation re-encodes the
      // file at upload time (not just at delivery), so the bytes Cloudinary
      // actually stores -- and what gets counted against the user's quota
      // below -- shrink too, typically 30-70% with no visible quality
      // loss. Deliberately NOT doing this for video: Cloudinary meters
      // video transformations separately from plain storage, and this
      // account's plan doesn't confirm that's covered -- revisit once it
      // is. Not applicable to 'raw' (documents) either.
      if (resourceType === 'image') {
        options.transformation = [{ quality: 'auto:good', fetch_format: 'auto' }];
      }
      // Owner tag (see ownerTag above) so an account deletion can find every
      // file of a user, including ones no row points at any more.
      if (tag) options.tags = [tag];
      const stream = cloudinary.uploader.upload_stream(
        options,
        (error, result) => {
          if (error) return reject(error);
          resolve({ filePath: result.secure_url, bytes: result.bytes });
        }
      );
      stream.end(file.buffer);
    });
  }

  // Deletes one file by public_id. "not found" counts as done (it's already
  // gone). Returns { ok, result }; throws on API/network errors so callers
  // can retry -- nothing is swallowed.
  async destroy(publicId, resourceType = 'image') {
    const response = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true });
    const result = response?.result;
    return { ok: result === 'ok' || result === 'not found', result };
  }

  // Deletes a file given its delivery URL (or a bare public_id + type).
  async delete(urlOrPublicId, { resourceType } = {}) {
    const m = String(urlOrPublicId).match(/\/(image|video|raw)\/upload\/(?:v\d+\/)?([^?#]+)$/);
    if (!m) return this.destroy(urlOrPublicId, resourceType || 'image');
    const type = m[1];
    const path = decodeURIComponent(m[2]);
    const publicId = type === 'raw' ? path : path.replace(/\.[^./]+$/, '');
    return this.destroy(publicId, type);
  }

  getUrl(filePath) {
    return filePath;
  }
}

export default new CloudStorage();
