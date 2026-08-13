/**
 * helpers.js - small shared utility functions
 */

/** Format a number as Bangladeshi Taka currency string, e.g. 125 -> "৳125" */
function taka(amount) {
  const n = Number(amount) || 0;
  return `৳${n.toLocaleString('en-BD')}`;
}

/** Generate a short, url-safe referral code from a Telegram user id */
function generateReferralCode(userId) {
  // Base36 keeps it short; prefixed so we can recognize/parse it later if needed.
  return `ref_${Number(userId).toString(36)}`;
}

/** Parse a referral code (e.g. "ref_2p3z1") back into the numeric Telegram id */
function parseReferralCode(code) {
  if (!code || !code.startsWith('ref_')) return null;
  const raw = code.slice(4);
  const id = parseInt(raw, 36);
  return Number.isFinite(id) ? id : null;
}

/** Escape special MarkdownV2 characters so free-text can be sent safely */
function escapeMarkdown(text = '') {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/** Escape the handful of characters HTML parse_mode treats specially, so
 *  arbitrary user/admin-typed free text can be safely wrapped in tags
 *  like <b>...</b> without risking a "can't parse entities" API error. */
function escapeHtml(text = '') {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Split an array into chunks (used to lay out inline keyboards in rows) */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Simple guard: is this ctx.from.id the configured admin? */
function isAdmin(userId) {
  return String(userId) === String(process.env.ADMIN_ID);
}

module.exports = {
  taka,
  generateReferralCode,
  parseReferralCode,
  escapeMarkdown,
  escapeHtml,
  chunk,
  isAdmin,
};
