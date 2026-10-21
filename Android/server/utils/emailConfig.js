// The one rule for "can this server actually send email?", shared by the
// mailer (utils/mailer.js) and the dev-only secret logging (utils/devSecrets.js).
//
//   'resend'  RESEND_API_KEY is set -> Resend's HTTP API (works on hosts that
//             block outbound SMTP, e.g. Render's free plan)
//   'smtp'    otherwise, SMTP_USER and SMTP_PASS are set -> nodemailer
//   null      neither: nothing is sent (dev prints codes/links instead)
export function emailProvider() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_USER && process.env.SMTP_PASS) return 'smtp';
  return null;
}

export const isEmailConfigured = () => emailProvider() !== null;
