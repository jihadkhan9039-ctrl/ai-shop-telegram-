/**
 * support.js - "🆘 Support" reply-keyboard button
 */

const { Markup } = require('telegraf');

function registerSupportHandler(bot) {
  bot.hears('🆘 Support', async (ctx) => {
    const username = (process.env.ADMIN_USERNAME || '').replace(/^@/, '');
    if (!username) {
      // Fail gracefully instead of crashing if ADMIN_USERNAME wasn't set.
      return ctx.reply('🆘 Support is temporarily unavailable. Please try again later.');
    }

    await ctx.reply(
      `🆘 *24/7 Support*\n\n` +
        `Need help with an order, payment, or anything else?\n` +
        `Tap the button below to message our admin directly.\n\n` +
        `We usually reply within a few minutes!`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.url('💬 Message Admin', `https://t.me/${username}`)],
        ]),
      }
    );
  });
}

module.exports = { registerSupportHandler };
