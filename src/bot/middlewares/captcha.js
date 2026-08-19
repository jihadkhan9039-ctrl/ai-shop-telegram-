/**
 * captcha.js
 * ------------------------------------------------------------
 * Global middleware, runs before captureReferralOnStart/forceJoin - a
 * brand-new user must tap the correct button on a simple number-picking
 * challenge before ANYTHING else happens, including their referral link
 * being recorded. This is aimed squarely at fake-account referral
 * farming: a simple auto-reply script can spam /start over and over, but
 * can't (cheaply) also parse the challenge and tap the right button, so
 * it meaningfully raises the cost of mass-creating throwaway accounts.
 *
 * Passing is remembered PERMANENTLY on the user doc (captchaVerified,
 * written via a merge-only set - see userService.markCaptchaPassed) so a
 * real person only ever solves it once, even across bot restarts (the
 * in-memory session wouldn't survive a restart, so relying on session
 * alone would force everyone to redo it after every deploy).
 * ------------------------------------------------------------
 */

const { Markup } = require('telegraf');
const { hasPassedCaptcha, markCaptchaPassed, getUser } = require('../../services/userService');
const { isAdmin } = require('../../utils/helpers');
const { recordReferralIfAny } = require('../../utils/referralCapture');

const CAPTCHA_PREFIX = 'captcha_';
const OPTION_COUNT = 4;

function generateChallenge() {
  const correct = Math.floor(10 + Math.random() * 89); // 10-98
  const options = new Set([correct]);
  while (options.size < OPTION_COUNT) {
    options.add(Math.floor(10 + Math.random() * 89));
  }
  const shuffled = [...options].sort(() => Math.random() - 0.5);
  return { correct, options: shuffled };
}

function buildKeyboard(options) {
  return Markup.inlineKeyboard(
    options.map((n) => Markup.button.callback(String(n), `${CAPTCHA_PREFIX}${n}`)),
    { columns: 2 }
  );
}

async function sendChallenge(ctx) {
  const { correct, options } = generateChallenge();
  ctx.session.pendingCaptcha = { answer: correct };
  await ctx.reply(
    `🤖 আপনি মানুষ কিনা যাচাই করার জন্য একটা ছোট quiz:\n\n` + `নিচের বাটনগুলো থেকে *${correct}* সংখ্যাটায় চাপ দিন।`,
    { parse_mode: 'Markdown', ...buildKeyboard(options) }
  );
}

async function captchaMiddleware(ctx, next) {
  const userId = ctx.from && ctx.from.id;
  if (!userId || isAdmin(userId)) return next();

  // Cache a pass in session too, so an already-verified user doesn't need
  // a Firestore read on every single message - only re-checked once per
  // bot process lifetime (session is in-memory, wiped on restart).
  if (ctx.session.captchaVerified) return next();

  const alreadyPassed = await hasPassedCaptcha(userId).catch(() => false);
  if (alreadyPassed) {
    ctx.session.captchaVerified = true;
    return next();
  }

  // Grandfather in anyone who already has a fully-created profile from
  // BEFORE this feature existed - they were never asked to pass a
  // CAPTCHA when they first joined, so surprising a real existing user
  // with one now (on some unrelated button tap) would just be confusing.
  // Only genuinely brand-new users (no profile at all yet) hit the
  // challenge below.
  const existingUser = await getUser(userId).catch(() => null);
  if (existingUser && existingUser.balance !== undefined) {
    ctx.session.captchaVerified = true;
    markCaptchaPassed(userId).catch((e) => console.error('[captcha] grandfather markCaptchaPassed failed:', e.message));
    return next();
  }

  // --- Handle a tap on one of the challenge buttons ---
  const callbackData = ctx.callbackQuery && ctx.callbackQuery.data;
  if (callbackData && callbackData.startsWith(CAPTCHA_PREFIX)) {
    const tapped = Number(callbackData.slice(CAPTCHA_PREFIX.length));
    const pending = ctx.session.pendingCaptcha;

    if (pending && tapped === pending.answer) {
      ctx.session.captchaVerified = true;
      ctx.session.pendingCaptcha = null;
      await markCaptchaPassed(userId).catch((e) => console.error('[captcha] markCaptchaPassed failed:', e.message));
      // Record the referral now, using whatever payload their ORIGINAL
      // /start carried (saved below before showing the challenge) - this
      // button-tap update isn't itself a /start text message, so
      // captureReferralOnStart re-parsing ctx.message.text at this point
      // wouldn't find it. Recording it here means the referral survives
      // even if the person just types a bare /start afterwards.
      const savedPayload = ctx.session.savedStartPayload || null;
      ctx.session.savedStartPayload = null;
      await recordReferralIfAny(ctx, savedPayload);
      await ctx.answerCbQuery('✅ Verified!');
      await ctx.editMessageText('✅ যাচাই সম্পন্ন! এখন /start লিখে চালিয়ে যান।').catch(() => {});
      return; // don't call next() - let them send a fresh /start
    }

    await ctx.answerCbQuery('❌ ভুল উত্তর, আবার চেষ্টা করুন।', { show_alert: true });
    await sendChallenge(ctx);
    return;
  }

  // --- Any other update from an unverified user: (re)send the challenge ---
  if (!ctx.session.pendingCaptcha) {
    // If this is a /start with a referral payload, save it now so it can
    // still be recorded once they pass the CAPTCHA below (see above).
    const text = ctx.message && typeof ctx.message.text === 'string' ? ctx.message.text : null;
    if (text && /^\/start(\s|$)/.test(text)) {
      const payload = text.replace(/^\/start\s*/, '').trim();
      if (payload) ctx.session.savedStartPayload = payload;
    }
    await sendChallenge(ctx);
  } else {
    await ctx.reply('⬆️ চালিয়ে যাওয়ার আগে উপরের quiz-টা সম্পন্ন করুন।').catch(() => {});
  }
}

module.exports = { captchaMiddleware };
