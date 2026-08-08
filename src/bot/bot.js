/**
 * bot.js
 * ------------------------------------------------------------
 * Creates and configures the Telegraf bot instance:
 *   1. session()            - in-memory per-user session (ctx.session)
 *   2. forceJoinMiddleware  - blocks everything until 4 channels joined
 *   3. all feature handlers - start, support, referral, balance, shop, admin
 * ------------------------------------------------------------
 */

const { Telegraf, session } = require('telegraf');

const { forceJoinMiddleware } = require('./middlewares/forceJoin');
const { registerStartHandler } = require('./handlers/start');
const { registerSupportHandler } = require('./handlers/support');
const { registerReferralHandler } = require('./handlers/referral');
const { registerBalanceHandler } = require('./handlers/balance');
const { registerShopHandler } = require('./handlers/shop');
const { registerAdminHandler } = require('./handlers/admin');

/**
 * This bot is designed for 1-on-1 private chats only (shop, balance, admin
 * panel - none of it makes sense in a group). If someone adds the bot to a
 * group/supergroup/channel, this middleware silently drops every update
 * from that chat so the bot NEVER posts menus/replies into a group.
 */
function privateChatOnly(ctx, next) {
  if (ctx.chat && ctx.chat.type !== 'private') {
    return; // silently ignore - do not call next(), do not reply
  }
  return next();
}

function createBot() {
  const bot = new Telegraf(process.env.BOT_TOKEN);

  // 1. Session must come first so every later middleware can use ctx.session.
  bot.use(session({ defaultSession: () => ({}) }));

  // 2. Never process/respond to anything outside a private 1-on-1 chat.
  bot.use(privateChatOnly);

  // 3. Gate every update behind the 4-channel force-join check.
  bot.use(forceJoinMiddleware);

  // 4. Feature handlers, in an order that lets "hears" exact-matches win
  //    before the generic catch-all listeners inside balance.js / admin.js.
  registerStartHandler(bot);
  registerSupportHandler(bot);
  registerReferralHandler(bot);
  registerShopHandler(bot);
  registerBalanceHandler(bot);
  registerAdminHandler(bot);

  // Global error handler so one bad update never crashes the whole process.
  bot.catch((err, ctx) => {
    console.error(`[bot] Unhandled error for update ${ctx.updateType}:`, err);
  });

  return bot;
}

module.exports = { createBot };
