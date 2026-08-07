/**
 * forceJoin.js
 * ------------------------------------------------------------
 * Global middleware. Runs before every update. Blocks all
 * features until the user has joined all 4 required channels.
 * ------------------------------------------------------------
 */

const { markChannelsVerified, markForceJoinRecheck, getUser } = require('../../services/userService');
const { isAdmin } = require('../../utils/helpers');

// Read the 4 channels (chat id or @username) + their public invite links from env.
const CHANNELS = [1, 2, 3, 4].map((n) => ({
  chatId: process.env[`CHANNEL_${n}`],
  link: process.env[`CHANNEL_${n}_LINK`],
}));

const JOINED_STATUSES = new Set(['member', 'administrator', 'creator']);

// How long we trust a previous "all channels joined" verification before
// re-checking live with Telegram. Balances speed (avoid 4 API calls per
// message) against catching users who joined, verified, then left.
const RECHECK_INTERVAL_MS = Number(process.env.FORCE_JOIN_RECHECK_HOURS || 12) * 60 * 60 * 1000;

/** Rejects if the given promise doesn't settle within `ms` milliseconds. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms)),
  ]);
}

/** Returns the list of channels the user has NOT joined. */
async function getNotJoinedChannels(ctx, userId) {
  const results = await Promise.all(
    CHANNELS.map(async (ch) => {
      try {
        const member = await withTimeout(ctx.telegram.getChatMember(ch.chatId, userId), 8000);
        return JOINED_STATUSES.has(member.status) ? null : ch;
      } catch (err) {
        // If the bot can't check (e.g. not admin in the channel, a slow/
        // timed-out API call, or the user never interacted with that chat),
        // treat as "not joined" so we fail safe rather than silently
        // letting them through - and so the middleware never hangs.
        console.error(`[forceJoin] getChatMember failed for ${ch.chatId}:`, err.description || err.message);
        return ch;
      }
    })
  );
  return results.filter(Boolean);
}

function buildJoinKeyboard(notJoined) {
  const rows = notJoined.map((ch, i) => [{ text: `📢 Join Channel ${i + 1}`, url: ch.link }]);
  rows.push([{ text: '✅ I Have Joined - Check Again', callback_data: 'check_join' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

async function forceJoinMiddleware(ctx, next) {
  const userId = ctx.from && ctx.from.id;
  if (!userId) return next(); // e.g. channel posts, edited messages without a from user

  // The bot admin should never be locked out of /adminpanel by force-join.
  if (isAdmin(userId)) return next();

  // /start should ALWAYS live-check join status - both for brand-new users
  // and for returning users who press /start again to re-verify. Every
  // OTHER message/click still uses the fast TTL cache below for speed.
  const isStartCommand = ctx.message && typeof ctx.message.text === 'string' && /^\/start(\s|$)/.test(ctx.message.text);

  // --- FAST PATH (skipped for /start, see above) ---
  // Re-checking 4 channels via the Telegram API on EVERY single update is
  // slow (especially on low-CPU free hosting). We cache a verified result
  // for RECHECK_INTERVAL_MS so most messages skip the live check entirely,
  // but we DON'T trust it forever - after the window expires we quietly
  // re-verify, so someone who joined then left gets caught again.
  if (!isStartCommand) {
    const cachedAt = ctx.session && ctx.session.forceJoinVerifiedAt;
    if (cachedAt && Date.now() - cachedAt < RECHECK_INTERVAL_MS) {
      return next();
    }

    const existingUser = await getUser(userId).catch(() => null);
    const lastCheckMs =
      existingUser && existingUser.lastForceJoinCheckAt && existingUser.lastForceJoinCheckAt.toMillis
        ? existingUser.lastForceJoinCheckAt.toMillis()
        : null;
    if (lastCheckMs && Date.now() - lastCheckMs < RECHECK_INTERVAL_MS) {
      if (ctx.session) ctx.session.forceJoinVerifiedAt = lastCheckMs;
      return next();
    }
  }
  // --- END FAST PATH --- (cache miss, expired, or /start -> live check below)

  const notJoined = await getNotJoinedChannels(ctx, userId);

  if (notJoined.length === 0) {
    // Fully verified - refresh the rolling re-check timestamp (session +
    // Firestore) so future updates take the fast path until it expires
    // again, AND set the one-time channelsVerifiedAt used by referralCron
    // (only actually written the very first time, see userService.js).
    if (ctx.session) ctx.session.forceJoinVerifiedAt = Date.now();
    markForceJoinRecheck(userId).catch((e) => console.error('markForceJoinRecheck error:', e));
    markChannelsVerified(userId).catch((e) => console.error('markChannelsVerified error:', e));
    return next();
  }

  // Special-case: user tapped the "Check Again" button but still isn't fully joined.
  if (ctx.callbackQuery && ctx.callbackQuery.data === 'check_join') {
    return ctx.answerCbQuery('❌ You still need to join all channels first!', { show_alert: true });
  }

  const text =
    '🔒 *Access Restricted*\n\n' +
    'To use this bot you must join all the channels below first.\n' +
    'After joining, tap *"I Have Joined - Check Again"*.';

  const keyboard = buildJoinKeyboard(notJoined);

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery();
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    } catch {
      await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
    }
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }
  // Do NOT call next() - block every other handler until verified.
}

module.exports = { forceJoinMiddleware, getNotJoinedChannels };
