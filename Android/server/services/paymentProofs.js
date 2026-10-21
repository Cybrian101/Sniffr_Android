import crypto from 'crypto';
import { getAdminClient } from '../lib/supabase.js';

// UPI payment-proof screenshots live in the PRIVATE Supabase Storage bucket
// "payment-proofs", reached only server-side with the service-role key.
// Nothing about them is public: payment_sessions.proof_storage_path holds the
// object path, and an admin sees the image through a signed URL that expires
// after a few minutes (GET /api/admin/payments/:id/proof-url).
//
// This is the ONLY module that touches the bucket, and it exports no way to
// delete a proof: proofs are kept for finance, also when the account is
// deleted. The account-deletion and media-purge code never import it (they
// only handle Cloudinary). The single removal below undoes an upload made a
// moment earlier in the same call, when recording its path failed.
//
// Older proofs were Cloudinary uploads; their public URL stays in
// payment_sessions.proof_url and is shown to admins as before.

export const PAYMENT_PROOFS_BUCKET = 'payment-proofs';
export const SIGNED_URL_TTL_SECONDS = 5 * 60;
// The bucket's own limits (set on the bucket in Supabase): 5 MB, JPEG/PNG/WebP.
// The upload route checks them first so users get a clear error instead of a
// failed upload. Change both together.
export const PROOF_MAX_BYTES = 5 * 1024 * 1024;
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const PROOF_MIME_TYPES = Object.keys(EXTENSIONS);

const bucket = () => getAdminClient().storage.from(PAYMENT_PROOFS_BUCKET);

// Uploads a proof (already past the route's type/size checks and the
// file-signature check) to "<userId>/<sessionId>-<random>.<ext>", then calls
// save(path) to record it. If save throws, the new object is removed again
// so no unreferenced proof is left, and the error is rethrown. Returns
// whatever save returns.
export async function storePaymentProof({ userId, sessionId, file }, save) {
  const ext = EXTENSIONS[file.mimetype];
  if (!ext) throw new Error(`unsupported payment proof type ${file.mimetype}`);
  const path = `${Number(userId)}/${Number(sessionId)}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  const { error } = await bucket().upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
  if (error) throw new Error(`payment proof upload failed: ${error.message}`);
  try {
    return await save(path);
  } catch (err) {
    const { error: removeError } = await bucket().remove([path]);
    if (removeError) console.error(`[paymentProofs] could not remove unsaved proof ${path}: ${removeError.message}`);
    throw err;
  }
}

// Short-lived URL an admin's browser can load the image from.
export async function signedPaymentProofUrl(path) {
  const { data, error } = await bucket().createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) throw new Error(`could not sign payment proof URL: ${error?.message || 'no URL returned'}`);
  return data.signedUrl;
}
