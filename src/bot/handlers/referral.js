/**
 * referral.js - "👥 Refer & Earn" reply-keyboard button
 */

const { getUser } = require('../../services/userService');
const { taka } = require('../../utils/helpers');

function registerReferralHandler(bot) {
  bot.hears('👥 Refer & Earn', async (ctx) => {
    const user = await getUser(ctx.from.id);
    if (!user) return ctx.reply('Please send /start first.');

    const botUsername = process.env.BOT_USERNAME;
    const link = `https://t.me/${botUsername}?start=${user.referralCode}`;
    const bonus = process.env.REFERRAL_BONUS || '5';
    const hours = process.env.REFERRAL_HOLD_HOURS || '24';

    await ctx.reply(
      `👥 *Refer & Earn*\n\n` +
        `Share your referral link with friends. When they join, verify all channels, ` +
        `and stay active for ${hours} hours, you'll automatically earn ${taka(bonus)}!\n\n` +
        `🔗 Your referral link:\n\`${link}\`\n\n` +
        `💰 Total referral earnings so far: *${taka(user.referralEarnings || 0)}*`,
      { parse_mode: 'Markdown' }
    );
  });
}

module.exports = { registerReferralHandler };
