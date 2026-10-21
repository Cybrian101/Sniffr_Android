import nodemailer from 'nodemailer';
import config from '../config.js';
import { emailProvider } from './emailConfig.js';

// Every email the app sends goes through sendEmail() below, which picks the
// transport from utils/emailConfig.js: Resend's HTTP API when RESEND_API_KEY
// is set (Render's free plan blocks outbound SMTP), else SMTP, else nothing.
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 10000;
export const DEFAULT_FROM = 'Sniffr <no-reply@sniffrweb.com>';
const REPLY_TO = 'official.sniffr@gmail.com';

// None of the existing templates interpolate free-text user/admin input
// into HTML (resetLink/verifyLink are system-generated, not user-authored).
// rejection_reason is admin-authored free text, so it needs escaping before
// going into an HTML email body -- this is the one new case that needs it.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const port = parseInt(process.env.SMTP_PORT) || 587;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // SMTP_SECURE lets a domain provider that needs implicit TLS (typically
    // port 465) opt in explicitly; otherwise this defaults sensibly off
    // port number (465 = implicit TLS, everything else incl. 587 = STARTTLS).
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    // Bounded so a bad host/blocked port fails fast (a few seconds) instead
    // of hanging for the platform's default multi-minute socket timeout --
    // callers already treat send failures as non-fatal/background.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    tls: {
      // Some Windows setups (antivirus/network inspection) inject a self-signed
      // certificate into the TLS chain, which Node rejects by default.
      // Only relaxed outside production -- password-reset links and 2FA
      // codes go over this connection, so production must always verify
      // the real certificate. See AUDIT_REPORT.md.
      rejectUnauthorized: config.NODE_ENV === 'production',
    },
  });

  return transporter;
}

// Reserved test/documentation domains (RFC 2606 / 6761) -- used by the test
// scripts' throwaway accounts. Never sent to, so tests can't bounce mail or
// hurt the sender's reputation.
const RESERVED_TLDS = ['.invalid', '.example', '.test', '.localhost'];
const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net'];

export function isReservedTestAddress(address) {
  const domain = String(address || '').split('@').pop().trim().toLowerCase();
  return RESERVED_TLDS.some(tld => domain === tld.slice(1) || domain.endsWith(tld))
    || RESERVED_DOMAINS.some(d => domain === d || domain.endsWith(`.${d}`));
}

// Failure messages are logged and returned, so strip anything address-like
// (a provider may echo the recipient back). Codes and links are only ever in
// the request body, which no provider error repeats.
function redactAddresses(message) {
  return String(message || 'unknown error').replace(/[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g, '[address]');
}

async function sendViaResend({ to, subject, html, text }) {
  let res;
  try {
    res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || DEFAULT_FROM,
        to: [to],
        reply_to: REPLY_TO,
        subject,
        text,
        html,
      }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new Error(`Resend request timed out after ${RESEND_TIMEOUT_MS / 1000}s`);
    throw new Error(`Resend request failed: ${err?.cause?.code || err?.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Resend errors look like { statusCode, name, message }.
    throw new Error(`Resend ${res.status}${body.name ? ` ${body.name}` : ''}: ${body.message || res.statusText}`);
  }
  return body.id;
}

async function sendViaSmtp({ to, subject, html, text }) {
  // SMTP_FROM_EMAIL/SMTP_FROM_NAME let the visible sender be a real domain
  // address (e.g. noreply@yourdomain.com) that differs from the SMTP auth
  // user -- required by providers like SendGrid/SES/Mailgun where the auth
  // user is an API key/account id, not the address mail should appear from.
  // Falls back to SMTP_USER so nothing breaks for setups that don't set them.
  const fromName = process.env.SMTP_FROM_NAME || 'Sniffr 🐾';
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
  const info = await getTransporter().sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject,
    text,
    html,
  });
  return info.messageId;
}

export async function sendEmail({ to, subject, html, text }) {
  if (isReservedTestAddress(to)) {
    console.log(`[MAILER] Skipping email to reserved test domain (@${String(to).split('@').pop()}): ${subject}`);
    return { skipped: true, reason: 'reserved_domain' };
  }
  const provider = emailProvider();
  if (!provider) {
    console.warn(`[MAILER] Email not configured (RESEND_API_KEY or SMTP_*) — skipping real email send: ${subject}`);
    return { skipped: true };
  }

  try {
    const messageId = provider === 'resend'
      ? await sendViaResend({ to, subject, html, text })
      : await sendViaSmtp({ to, subject, html, text });
    console.log(`[MAILER] Email sent via ${provider} (${subject}): ${messageId}`);
    return { success: true, provider, messageId };
  } catch (err) {
    const error = redactAddresses(err?.message);
    console.error(`[MAILER] Failed to send email via ${provider} (${subject}): ${error}`);
    return { success: false, provider, error };
  }
}

export async function sendPawCodeEmail(toEmail, code) {
  return sendEmail({
    to: toEmail,
    subject: '🐾 Your Sniffr PawPrint Verification Code',
    text: `Your PawPrint verification code is: ${code}\n\nThis code expires in 10 minutes.`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #8E2E43;">🐾 PawPrint Verification</h2>
        <p>Your verification code is:</p>
        <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #8E2E43;">${code}</p>
        <p style="color: #666; font-size: 14px;">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });
}

export async function sendAccountDeletionCodeEmail(toEmail, code) {
  return sendEmail({
    to: toEmail,
    subject: '🐾 Your Sniffr account deletion code',
    text: `We received a request to delete your Sniffr account.\n\nYour code is: ${code}\n\nIt expires in 10 minutes.\n\nIf you didn't request this, ignore this email and consider changing your password.`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #8E2E43;">🐾 Confirm your account deletion</h2>
        <p>We received a request to delete your Sniffr account. Enter this code in the app to continue:</p>
        <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #8E2E43;">${code}</p>
        <p style="color: #666; font-size: 14px;">This code expires in 10 minutes.</p>
        <p style="color: #666; font-size: 14px;">If you didn't request this, ignore this email and consider changing your password.</p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail(toEmail, resetLink) {
  return sendEmail({
    to: toEmail,
    subject: '🐾 Reset Your Sniffr Password',
    text: `Reset your password using this link: ${resetLink}\n\nThis link expires in 1 hour.`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #8E2E43;">🐾 Password Reset Request</h2>
        <p>Click the button below to reset your Sniffr password:</p>
        <a href="${resetLink}" style="display: inline-block; padding: 12px 24px; background: #8E2E43; color: white; text-decoration: none; border-radius: 24px; font-weight: bold;">Reset Password</a>
        <p style="color: #666; font-size: 14px; margin-top: 16px;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });
}

export async function sendVerificationEmail(toEmail, verifyLink, options = {}) {
  const { isWelcome = false, fullName = '' } = options;
  const firstName = fullName ? fullName.split(' ')[0] : '';

  if (isWelcome) {
    return sendEmail({
      to: toEmail,
      subject: '🐾 Welcome to Sniffr! Let\'s get you verified',
      text: `Welcome to Sniffr${firstName ? `, ${firstName}` : ''}! We're so excited you're here. Before you start sniffing out our new app, please verify your email: ${verifyLink}\n\nThis link expires in 24 hours.`,
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color: #8E2E43;">🐾 Welcome to the pack${firstName ? `, ${firstName}` : ''}!</h2>
          <p>We're so happy you and your pet joined Sniffr — a home for pet parents to connect, share memories, and find new playmates nearby.</p>
          <p>Just one quick step before you dive in: please confirm this is your email address.</p>
          <a href="${verifyLink}" style="display: inline-block; padding: 12px 24px; background: #8E2E43; color: white; text-decoration: none; border-radius: 24px; font-weight: bold; margin: 12px 0;">Verify My Email</a>
          <p style="color: #666; font-size: 14px; margin-top: 16px;">This link expires in 24 hours. If you didn't sign up for Sniffr, you can safely ignore this email.</p>
          <p style="color: #999; font-size: 12px; margin-top: 24px;">🐾 See you on the other side — your pet's new friends are waiting!</p>
        </div>
      `,
    });
  }

  return sendEmail({
    to: toEmail,
    subject: '🐾 Verify your Sniffr email address',
    text: `Please verify your email by visiting this link: ${verifyLink}\n\nThis link expires in 24 hours.`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #8E2E43;">🐾 Verify Your Email</h2>
        <p>Please confirm this is your email address by clicking the button below:</p>
        <a href="${verifyLink}" style="display: inline-block; padding: 12px 24px; background: #8E2E43; color: white; text-decoration: none; border-radius: 24px; font-weight: bold;">Verify Email</a>
        <p style="color: #666; font-size: 14px; margin-top: 16px;">This link expires in 24 hours. If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });
}

export async function sendPaymentApprovedEmail(toEmail, { planLabel, expiryDate }) {
  const expiryText = expiryDate
    ? new Date(expiryDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;
  return sendEmail({
    to: toEmail,
    subject: `✨ ${planLabel} is now active on Sniffr!`,
    text: `Great news! Your manual UPI payment was approved and ${planLabel} is now active on your Sniffr account.${expiryText ? ` Your subscription is active until ${expiryText}.` : ''}\n\nEnjoy your Premium perks! 🐾`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #8E2E43;">✨ ${escapeHtml(planLabel)} is now active!</h2>
        <p>Great news! We've verified your UPI payment and activated <strong>${escapeHtml(planLabel)}</strong> on your Sniffr account.</p>
        ${expiryText ? `<p style="color: #666; font-size: 14px;">Your subscription is active until <strong>${escapeHtml(expiryText)}</strong>.</p>` : ''}
        <p style="color: #999; font-size: 12px; margin-top: 24px;">🐾 Thanks for supporting Sniffr — enjoy your Premium perks!</p>
      </div>
    `,
  });
}

export async function sendAdminPaymentReviewEmail(toEmail, { submitterName, planLabel, reviewLink }) {
  return sendEmail({
    to: toEmail,
    subject: `🐾 New Premium payment awaiting review — ${planLabel}`,
    text: `${submitterName} has requested ${planLabel} and submitted manual UPI payment proof.\n\nReview it here: ${reviewLink}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #8E2E43;">🐾 New payment awaiting review</h2>
        <p><strong>${escapeHtml(submitterName)}</strong> has requested <strong>${escapeHtml(planLabel)}</strong> and submitted manual UPI payment proof.</p>
        <a href="${reviewLink}" style="display: inline-block; padding: 12px 24px; background: #8E2E43; color: white; text-decoration: none; border-radius: 24px; font-weight: bold; margin: 12px 0;">Review Now</a>
      </div>
    `,
  });
}

export async function sendPaymentRejectedEmail(toEmail, { planLabel, rejectionReason }) {
  return sendEmail({
    to: toEmail,
    subject: "We couldn't verify your Sniffr Premium payment",
    text: `We reviewed your manual UPI payment submission for ${planLabel} and were unable to verify it.\n\nReason: ${rejectionReason}\n\nIf you believe this is a mistake, please contact Sniffr support, or feel free to submit your payment again.`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #8E2E43;">🐾 We couldn't verify your payment</h2>
        <p>We reviewed your manual UPI payment submission for <strong>${escapeHtml(planLabel)}</strong> and were unable to verify it.</p>
        <p style="color: #666; font-size: 14px;"><strong>Reason:</strong> ${escapeHtml(rejectionReason)}</p>
        <p style="color: #666; font-size: 14px; margin-top: 16px;">If you believe this is a mistake, please contact Sniffr support, or feel free to submit your payment again.</p>
      </div>
    `,
  });
}