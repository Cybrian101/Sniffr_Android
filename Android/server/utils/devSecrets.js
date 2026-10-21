import config from '../config.js';
import { isEmailConfigured } from './emailConfig.js';

/**
 * For one-time codes and links that normally go out by email (PawPrint
 * codes, password-reset and verification links, account-deletion codes).
 *
 * Without email (Resend or SMTP, see utils/emailConfig.js) in local
 * development the secret is printed to the console so the flow can still be
 * tested. It is NEVER printed in production: there, missing email is logged
 * as an error instead. `label` must not contain the secret or personal data
 * (use a user id, not an email).
 */
export function logUndeliverableSecret(label, secret) {
  if (isEmailConfigured()) return;
  if (config.NODE_ENV === 'production') {
    console.error(`[MAILER] Email is not configured -- could not email the ${label}. Set RESEND_API_KEY (or SMTP_HOST, SMTP_USER and SMTP_PASS) on the server.`);
    return;
  }
  console.log(`[DEV ONLY] ${label}: ${secret}`);
}
