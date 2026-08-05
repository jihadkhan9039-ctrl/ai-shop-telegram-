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

function createBot() {
  const bot = new Telegraf(process.env.BOT_TOKEN);

  // 1. Session must come first so every later middleware can use ctx.session.
  bot.use(session({ defaultSession: () => ({}) }));

  // 2. Gate every update behind the 4-channel force-join check.
  bot.use(forceJoinMiddleware);

  // 3. Feature handlers, in an order that lets "hears" exact-matches win
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
