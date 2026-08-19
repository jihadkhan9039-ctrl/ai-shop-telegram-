/**
 * bot.js
 * ------------------------------------------------------------
 * Creates and configures the Telegraf bot instance:
 *   1. session()            - in-memory per-user session (ctx.session)
 *   2. privateChatOnly      - ignores anything outside 1-on-1 chats
 *   3. captchaMiddleware    - blocks new users until a CAPTCHA is solved
 *   4. captureReferralOnStart - records the user + referral before force-join can block it
 *   5. bannedGuard          - blocks banned users everywhere
 *   6. forceJoinMiddleware  - blocks everything until 4 channels joined
 *   7. all feature handlers - start, support, referral, balance, shop, admin
 * ------------------------------------------------------------
 */

const { Telegraf, session } = require('telegraf');

const { forceJoinMiddleware } = require('./middlewares/forceJoin');
const { captchaMiddleware } = require('./middlewares/captcha');
const { registerStartHandler } = require('./handlers/start');
const { registerSupportHandler } = require('./handlers/support');
const { registerReferralHandler } = require('./handlers/referral');
const { registerBalanceHandler } = require('./handlers/balance');
const { registerShopHandler } = require('./handlers/shop');
const { registerAdminHandler } = require('./handlers/admin');
const { getUser } = require('../services/userService');
const { isAdmin } = require('../utils/helpers');
const { recordReferralIfAny } = require('../utils/referralCapture');

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
    console.log(`[captureReferralOnStart] /start from ${ctx.from.id}, payload="${payload}"`);
    await recordReferralIfAny(ctx, payload);
  }
  return next();
}

/**
 * banned=true was previously only checked at /start, meaning a banned user
 * could keep using Shop/Balance/everything else as long as they didn't
 * re-send /start. This closes that gap - EVERY update from a banned user
 * (except the bot admin, who can never be banned) is blocked here.
 */
async function bannedGuard(ctx, next) {
  const userId = ctx.from && ctx.from.id;
  if (!userId || isAdmin(userId)) return next();
  const user = await getUser(userId).catch(() => null);
  if (user && user.banned) {
    return ctx.reply('🚫 আপনার অ্যাকাউন্ট ব্যান করা হয়েছে। এটা ভুল মনে হলে সাপোর্টে যোগাযোগ করুন।').catch(() => {});
  }
  return next();
}

function createBot() {
  const bot = new Telegraf(process.env.BOT_TOKEN);

  // 1. Session must come first so every later middleware can use ctx.session.
  bot.use(session({ defaultSession: () => ({}) }));

  // 2. Never process/respond to anything outside a private 1-on-1 chat.
  bot.use(privateChatOnly);

  // 3. New users must pass a simple button-tap CAPTCHA before ANYTHING
  //    else happens - including their referral link being recorded. Raises
  //    the cost of scripted fake-account referral farming.
  bot.use(captchaMiddleware);

  // 4. Record the user + referral relationship on /start BEFORE force-join
  //    can block the update (see big comment above).
  bot.use(captureReferralOnStart);

  // 5. Block banned users everywhere, not just at /start.
  bot.use(bannedGuard);

  // 6. Gate every update behind the 4-channel force-join check.
  bot.use(forceJoinMiddleware);

  // 7. Feature handlers, in an order that lets "hears" exact-matches win
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
