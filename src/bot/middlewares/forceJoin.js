/**
 * forceJoin.js
 * ------------------------------------------------------------
 * Global middleware. Runs before every update. Blocks all
 * features until the user has joined all 4 required channels.
 * ------------------------------------------------------------
 */

const { markChannelsVerified } = require('../../services/userService');
const { isAdmin } = require('../../utils/helpers');

// Read the 4 channels (chat id or @username) + their public invite links from env.
const CHANNELS = [1, 2, 3, 4].map((n) => ({
  chatId: process.env[`CHANNEL_${n}`],
  link: process.env[`CHANNEL_${n}_LINK`],
}));

const JOINED_STATUSES = new Set(['member', 'administrator', 'creator']);

/** Returns the list of channels the user has NOT joined. */
async function getNotJoinedChannels(ctx, userId) {
  const results = await Promise.all(
    CHANNELS.map(async (ch) => {
      try {
        const member = await ctx.telegram.getChatMember(ch.chatId, userId);
        return JOINED_STATUSES.has(member.status) ? null : ch;
      } catch (err) {
        // If the bot can't check (e.g. not admin in the channel, or user never
        // started a chat with the bot's context for that channel), treat as
        // "not joined" so we fail safe rather than silently letting them through.
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

  const notJoined = await getNotJoinedChannels(ctx, userId);

  if (notJoined.length === 0) {
    // Fully verified - remember it once, then let the update flow through.
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
