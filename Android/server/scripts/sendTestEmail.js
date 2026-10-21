// Sends ONE plain test email through the real mailer (utils/mailer.js), with
// whatever is configured in server/.env: Resend (RESEND_API_KEY), else SMTP.
// For checking delivery, sender, Reply-To and spam placement. Contains no
// codes, links or account data. No database or server needed.
//
//   node scripts/sendTestEmail.js --to you@gmail.com
import '../config.js';
import { sendEmail, DEFAULT_FROM } from '../utils/mailer.js';
import { emailProvider } from '../utils/emailConfig.js';

function argValue(name) {
  const i = process.argv.findIndex(a => a === name || a.startsWith(`${name}=`));
  if (i === -1) return null;
  const arg = process.argv[i];
  return arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : process.argv[i + 1] ?? null;
}

async function main() {
  const to = (argValue('--to') || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    console.error('Usage: node scripts/sendTestEmail.js --to you@gmail.com');
    process.exitCode = 1;
    return;
  }

  const provider = emailProvider();
  if (!provider) {
    console.error('Email is not configured: set RESEND_API_KEY (or SMTP_HOST, SMTP_USER and SMTP_PASS) in server/.env.');
    process.exitCode = 1;
    return;
  }
  console.log(`Provider: ${provider}`);
  if (provider === 'resend') console.log(`From: ${process.env.EMAIL_FROM || `${DEFAULT_FROM} (default)`}`);

  const sentAt = new Date().toISOString();
  const result = await sendEmail({
    to,
    subject: '🐾 Sniffr test email',
    text: `This is a test email from the Sniffr server, sent at ${sentAt}.\n\nIf you can read this, email delivery works. Replies go to the Sniffr support inbox.`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #8E2E43;">🐾 Sniffr test email</h2>
        <p>This is a test email from the Sniffr server, sent at ${sentAt}.</p>
        <p style="color: #666; font-size: 14px;">If you can read this, email delivery works. Replies go to the Sniffr support inbox.</p>
      </div>
    `,
  });

  if (result.success) {
    console.log(`Sent (message id ${result.messageId}). Check the inbox and the spam folder.`);
  } else if (result.skipped) {
    console.error(`Not sent: ${result.reason === 'reserved_domain' ? 'that is a reserved test domain, which the mailer never sends to' : 'email is not configured'}.`);
    process.exitCode = 1;
  } else {
    console.error(`Failed: ${result.error}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
