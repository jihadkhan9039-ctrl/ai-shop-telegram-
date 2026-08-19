const { ensureUser } = require('../services/userService');
const { taka, parseReferralCode } = require('./helpers');

/**
 * Shared by bot.js's captureReferralOnStart middleware AND captcha.js
 * (which needs to record the referral right when a user PASSES the
 * CAPTCHA, using whatever payload their original /start carried - see
 * captcha.js for why: the button-tap update that completes verification
 * isn't itself a /start text message, so re-parsing ctx.message.text at
 * that point wouldn't find the payload).
 */
async function recordReferralIfAny(ctx, payload) {
  const referrerId = payload ? parseReferralCode(payload) : null;
  try {
    const { user, isNew } = await ensureUser(ctx, referrerId);
    // Only notify once, right when the referral relationship is first created
    // (isNew guards against re-notifying on every subsequent /start).
    if (isNew && user.referredBy) {
      const referredName = ctx.from.first_name || 'Someone';
      const bonus = process.env.REFERRAL_BONUS || '5';
      ctx.telegram
        .sendMessage(
          user.referredBy,
          `🎉 নতুন রেফারেল!\n\n` +
            `${referredName} আপনার লিংক দিয়ে বটে join করেছেন।\n\n` +
            `সে ৪টা চ্যানেল জয়েন করে ভেরিফাই সম্পন্ন করলেই আপনি সাথে সাথে ${taka(bonus)} বোনাস পাবেন।\n\n` +
            `"👥 Refer & Earn" → "📋 My Referral List" থেকে স্ট্যাটাস দেখতে পারবেন।`
        )
        .catch((e) => console.error('[recordReferralIfAny] failed to notify referrer:', e.message));
    }
    return { user, isNew };
  } catch (err) {
    console.error('[recordReferralIfAny] failed to create user/referral record:', err);
    return null;
  }
}

module.exports = { recordReferralIfAny };
