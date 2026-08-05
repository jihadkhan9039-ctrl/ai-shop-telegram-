/**
 * support.js - "🆘 Support" reply-keyboard button
 */

function registerSupportHandler(bot) {
  bot.hears('🆘 Support', async (ctx) => {
    const username = process.env.ADMIN_USERNAME.replace(/^@/, '');
    await ctx.reply(
      `🆘 *24/7 Support*\n\n` +
        `Need help with an order, payment, or anything else?\n` +
        `Message our admin directly: @${username}\n\n` +
        `We usually reply within a few minutes!`,
      { parse_mode: 'Markdown' }
    );
  });
}

module.exports = { registerSupportHandler };
