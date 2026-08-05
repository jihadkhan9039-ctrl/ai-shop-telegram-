/**
 * balance.js
 * ------------------------------------------------------------
 * Handles:
 *  - "💰 Balance" reply button -> shows Name/ID/Balance/Referral earnings + "Add Fund"
 *  - "Add Fund" inline button -> deletes previous msg, shows bKash/Nagad choice
 *  - bKash/Nagad choice -> shows payment instructions + "Submit TrxID"
 *  - "Submit TrxID" -> puts user into an "awaiting text" state (ctx.session)
 *  - Plain text message while awaiting -> verified against transactions
 *    collection in Firestore; if valid & unused, credits the user's balance.
 * ------------------------------------------------------------
 * NOTE: uses ctx.session (in-memory by default via telegraf's session()
 * middleware, registered in bot.js) to remember "what is this user typing
 * right now". Good enough for a single-process VPS deployment.
 * ------------------------------------------------------------
 */

const { getUser, adjustBalance } = require('../../services/userService');
const { getTransaction, claimTransaction } = require('../../services/transactionService');
const { taka } = require('../../utils/helpers');
const {
  balanceKeyboard,
  paymentMethodKeyboard,
  submitTrxKeyboard,
} = require('../keyboards/keyboards');

// TODO: replace with your real merchant numbers.
const BKASH_NUMBER = process.env.BKASH_NUMBER || '01XXXXXXXXX (Personal)';
const NAGAD_NUMBER = process.env.NAGAD_NUMBER || '01XXXXXXXXX (Personal)';

function balanceText(user) {
  return (
    `💰 *Your Balance*\n\n` +
    `👤 Name: ${user.name}\n` +
    `🆔 Telegram ID: \`${user.telegramId}\`\n` +
    `💵 Total Balance: *${taka(user.balance)}*\n` +
    `🎁 Referral Earnings: *${taka(user.referralEarnings || 0)}*`
  );
}

function registerBalanceHandler(bot) {
  bot.hears('💰 Balance', async (ctx) => {
    const user = await getUser(ctx.from.id);
    if (!user) return ctx.reply('Please send /start first.');
    await ctx.reply(balanceText(user), { parse_mode: 'Markdown', ...balanceKeyboard });
  });

  bot.action('add_fund', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    await ctx.reply(
      '➕ *Add Fund*\n\nChoose your payment method:',
      { parse_mode: 'Markdown', ...paymentMethodKeyboard }
    );
  });

  bot.action('balance_back', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from.id);
    await ctx.editMessageText(balanceText(user), { parse_mode: 'Markdown', ...balanceKeyboard });
  });

  async function showPaymentInstructions(ctx, method) {
    await ctx.answerCbQuery();
    const number = method === 'bKash' ? BKASH_NUMBER : NAGAD_NUMBER;
    ctx.session.awaitingTrxMethod = method; // remember which method they picked
    await ctx.editMessageText(
      `📱 *Pay with ${method}*\n\n` +
        `Send the desired amount to:\n\`${number}\`\n\n` +
        `Once sent, you'll receive an SMS with a Transaction ID (TrxID). ` +
        `Tap the button below and send that TrxID here to auto-verify and credit your balance.`,
      { parse_mode: 'Markdown', ...submitTrxKeyboard }
    );
  }

  bot.action('pay_bkash', (ctx) => showPaymentInstructions(ctx, 'bKash'));
  bot.action('pay_nagad', (ctx) => showPaymentInstructions(ctx, 'Nagad'));

  bot.action('submit_trx', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.awaitingTrxId = true;
    await ctx.reply('🧾 Please type/send your *TrxID* now (e.g. `9AK3XXXXXX`).', {
      parse_mode: 'Markdown',
    });
  });

  // Plain-text listener: only acts when the user is in "awaiting TrxID" state.
  // Registered with low priority (checked in bot.js AFTER the reply-keyboard
  // `hears` handlers) so it never swallows menu button presses.
  bot.on('text', async (ctx, next) => {
    if (!ctx.session || !ctx.session.awaitingTrxId) return next();

    const trxId = ctx.message.text.trim();
    ctx.session.awaitingTrxId = false;

    const tx = await getTransaction(trxId);
    if (!tx) {
      return ctx.reply(
        '❌ TrxID not found. Please double-check the ID from your SMS and try again, ' +
          'or contact support if the payment already went through.'
      );
    }
    if (tx.used) {
      return ctx.reply('⚠️ This TrxID has already been used to credit a balance.');
    }

    try {
      await claimTransaction(trxId, ctx.from.id);
    } catch (err) {
      if (err.message === 'ALREADY_USED') {
        return ctx.reply('⚠️ This TrxID has already been used to credit a balance.');
      }
      console.error('claimTransaction error:', err);
      return ctx.reply('❌ Something went wrong verifying your payment. Please contact support.');
    }

    await adjustBalance(ctx.from.id, tx.amount);
    const user = await getUser(ctx.from.id);

    await ctx.reply(
      `✅ *Payment Verified!*\n\n` +
        `${taka(tx.amount)} has been added to your balance.\n` +
        `💵 New Balance: *${taka(user.balance)}*`,
      { parse_mode: 'Markdown' }
    );
  });
}

module.exports = { registerBalanceHandler };
