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
const { ensureUser } = require('../services/userService');
const { parseReferralCode } = require('../utils/helpers');

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

/**
 * IMPORTANT: forceJoinMiddleware blocks a brand-new user's very first
 * /start (they haven't joined the 4 channels yet), so the normal
 * bot.start() handler in start.js never runs for them at that moment.
 * If the referral link + referrer binding were only saved inside that
 * blocked handler, referrals would silently never be recorded.
 *
 * This middleware runs BEFORE the force-join gate and immediately creates
 * the user doc (and the referral record, if a ?start=ref_xxx payload is
 * present) regardless of join status. start.js's own ensureUser() call
 * later is then just a harmless no-op (the doc already exists).
 */
async function captureReferralOnStart(ctx, next) {
  const text = ctx.message && typeof ctx.message.text === 'string' ? ctx.message.text : null;
  if (text && /^\/start(\s|$)/.test(text)) {
    const payload = text.replace(/^\/start\s*/, '').trim();
    const referrerId = payload ? parseReferralCode(payload) : null;
    try {
      await ensureUser(ctx, referrerId);
    } catch (err) {
      console.error('[captureReferralOnStart] failed to create user/referral record:', err);
    }
  }
  return next();
}

function createBot() {
  const bot = new Telegraf(process.env.BOT_TOKEN);

  // 1. Session must come first so every later middleware can use ctx.session.
  bot.use(session({ defaultSession: () => ({}) }));

  // 2. Never process/respond to anything outside a private 1-on-1 chat.
  bot.use(privateChatOnly);

  // 3. Record the user + referral relationship on /start BEFORE force-join
  //    can block the update (see big comment above).
  bot.use(captureReferralOnStart);

  // 4. Gate every update behind the 4-channel force-join check.
  bot.use(forceJoinMiddleware);

  // 5. Feature handlers, in an order that lets "hears" exact-matches win
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
