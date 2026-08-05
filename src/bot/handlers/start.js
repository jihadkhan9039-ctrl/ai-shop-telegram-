/**
 * start.js - handles /start (including deep-link referral payloads)
 * and the "✅ I Have Joined" callback once force-join passes.
 */

const { ensureUser, getUser } = require('../../services/userService');
const { parseReferralCode } = require('../../utils/helpers');
const { mainMenuKeyboard } = require('../keyboards/keyboards');

function welcomeText(name) {
  return (
    `👋 Welcome, *${name}*!\n\n` +
    `This bot lets you buy premium digital subscriptions (Netflix, Crunchyroll, Gemini AI Pro & more) ` +
    `at unbeatable prices, and earn money by referring friends.\n\n` +
    `Use the menu below to get started.`
  );
}

function registerStartHandler(bot) {
  bot.start(async (ctx) => {
    const user = await getUser(ctx.from.id);
    if (user && user.banned) {
      return ctx.reply('🚫 Your account has been banned. Contact support if you think this is a mistake.');
    }

    // Deep-link payload looks like "ref_2p3z1" -> extract referrer id.
    const payload = ctx.startPayload; // telegraf parses text after "/start "
    const referrerId = payload ? parseReferralCode(payload) : null;

    const { isNew } = await ensureUser(ctx, referrerId);

    if (isNew && referrerId) {
      console.log(`New user ${ctx.from.id} referred by ${referrerId}`);
    }

    await ctx.reply(welcomeText(ctx.from.first_name || 'there'), {
      parse_mode: 'Markdown',
      ...mainMenuKeyboard,
    });
  });

  // Fired by forceJoin.js once the user is verified and taps "Check Again".
  bot.action('check_join', async (ctx) => {
    await ctx.answerCbQuery('✅ Verified! Welcome aboard.');
    await getUser(ctx.from.id); // ensures doc exists (should already, from /start)
    try {
      await ctx.deleteMessage();
    } catch {
      /* ignore - message may already be gone */
    }
    await ctx.reply(welcomeText(ctx.from.first_name || 'there'), {
      parse_mode: 'Markdown',
      ...mainMenuKeyboard,
    });
  });
}

module.exports = { registerStartHandler };
