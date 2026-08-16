/**
 * balance.js
 * ------------------------------------------------------------
 * Handles:
 *  - "💰 Balance" reply button -> shows Name/ID/Balance/Referral earnings + "Add Fund"
 *  - "Add Fund" -> ASKS THE USER HOW MUCH THEY WANT TO DEPOSIT (min MIN_DEPOSIT,
 *    default ৳100) before anything else.
 *  - After a valid amount -> shows bKash/Nagad choice with that exact amount
 *  - Choosing a method -> shows payment instructions (send THAT amount) + "Submit TrxID"
 *  - "Submit TrxID" -> puts user into an "awaiting text" state (ctx.session)
 *  - Plain text message while awaiting -> verified against transactions
 *    collection in Firestore (populated by the SMS webhook - see
 *    src/webhook/smsWebhook.js); if valid & unused, credits the user's
 *    balance with the REAL amount from the SMS (not just what they typed -
 *    that's only used to show them the right instructions and to flag a
 *    mismatch if the SMS amount doesn't match what they said they'd send).
 * ------------------------------------------------------------
 * NOTE: uses ctx.session (in-memory via telegraf's session() middleware,
 * registered in bot.js) to remember "what is this user typing right now
 * and for how much". Fine for a single-process deployment; resets on
 * restart, which just means the user has to tap Add Fund again.
 * ------------------------------------------------------------
 */

const { getUser, adjustBalance } = require('../../services/userService');
const { getTransaction, claimTransaction, createManualDepositRequest } = require('../../services/transactionService');
const { taka, escapeHtml } = require('../../utils/helpers');
const { Markup } = require('telegraf');
const {
  balanceKeyboard,
  paymentMethodKeyboard,
  submitTrxKeyboard,
} = require('../keyboards/keyboards');

// TODO: replace with your real merchant numbers via Render env vars.
const BKASH_NUMBER = process.env.BKASH_NUMBER || '01XXXXXXXXX (Personal)';
const NAGAD_NUMBER = process.env.NAGAD_NUMBER || '01XXXXXXXXX (Personal)';
const MIN_DEPOSIT = Number(process.env.MIN_DEPOSIT || 100);
const ADMIN_ID = process.env.ADMIN_ID;

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

  // Step 1: "Add Fund" tapped -> ask how much they want to deposit.
  bot.action('add_fund', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.awaitingDepositAmount = true;
    ctx.session.depositAmount = null;
    ctx.session.awaitingTrxMethod = null;
    await ctx.deleteMessage().catch(() => {});
    await ctx.reply(
      `➕ *Add Fund*\n\nকত টাকা যোগ করতে চান? নিচে শুধু সংখ্যাটা লিখে পাঠান।\n` +
        `সর্বনিম্ন: *${taka(MIN_DEPOSIT)}*`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.action('balance_back', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from.id);
    await ctx.editMessageText(balanceText(user), { parse_mode: 'Markdown', ...balanceKeyboard });
  });

  // Step 2: user picked bKash/Nagad -> show that exact amount + number + Submit TrxID.
  async function showPaymentInstructions(ctx, method) {
    await ctx.answerCbQuery();
    const amount = ctx.session.depositAmount;
    if (!amount) {
      // Session was lost (e.g. server restarted) - restart the flow cleanly.
      ctx.session.awaitingDepositAmount = true;
      return ctx.editMessageText(
        `⚠️ Session expired. কত টাকা যোগ করতে চান? সর্বনিম্ন *${taka(MIN_DEPOSIT)}*`,
        { parse_mode: 'Markdown' }
      );
    }
    const number = method === 'bKash' ? BKASH_NUMBER : NAGAD_NUMBER;
    ctx.session.awaitingTrxMethod = method;
    await ctx.editMessageText(
      `📱 *${method}-এ পেমেন্ট করুন*\n\n` +
        `${method} অ্যাপ খুলে **"Send Money"** অপশন থেকে ঠিক *${taka(amount)}* পাঠান এই নাম্বারে:\n` +
        `\`${number}\`\n\n` +
        `✅ পাঠানোর পর ${method} থেকে একটি নিশ্চিতকরণ SMS আসবে, যেখানে একটি *Transaction ID (TrxID)* উল্লেখ থাকবে।\n\n` +
        `নিচের বাটনে ট্যাপ করে সেই TrxID পাঠিয়ে দিন — আপনার ব্যালেন্স স্বয়ংক্রিয়ভাবে যোগ হয়ে যাবে।`,
      { parse_mode: 'Markdown', ...submitTrxKeyboard }
    );
  }

  bot.action('pay_bkash', (ctx) => showPaymentInstructions(ctx, 'bKash'));
  bot.action('pay_nagad', (ctx) => showPaymentInstructions(ctx, 'Nagad'));

  // Step 3: "Submit TrxID" tapped -> wait for the TrxID text.
  bot.action('submit_trx', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.awaitingTrxId = true;
    await ctx.reply(
      '🧾 দয়া করে আপনার *Transaction ID (TrxID)* পাঠান।\n\nউদাহরণ: `9AK3XXXXXX`',
      { parse_mode: 'Markdown' }
    );
  });

  // Plain-text listener: routes based on which step the user is currently on.
  // Registered with low priority (checked AFTER the reply-keyboard `hears`
  // handlers, per registration order in bot.js) so it never swallows menu
  // button presses. Falls through via next() when neither state applies.
  bot.on('text', async (ctx, next) => {
    if (!ctx.session) return next();

    // --- Step 2a: waiting for the deposit AMOUNT ---
    if (ctx.session.awaitingDepositAmount) {
      const raw = ctx.message.text.trim().replace(/,/g, '');
      const amount = Number(raw);

      if (!Number.isFinite(amount) || amount <= 0) {
        return ctx.reply('❌ শুধু একটা সংখ্যা পাঠান, যেমন `500`।', { parse_mode: 'Markdown' });
      }
      if (amount < MIN_DEPOSIT) {
        return ctx.reply(`❌ সর্বনিম্ন ডিপোজিট *${taka(MIN_DEPOSIT)}*। আরেকটা amount দিন।`, {
          parse_mode: 'Markdown',
        });
      }

      ctx.session.awaitingDepositAmount = false;
      ctx.session.depositAmount = amount;

      return ctx.reply(
        `✅ Amount: *${taka(amount)}*\n\nএখন পেমেন্ট মেথড বেছে নিন:`,
        { parse_mode: 'Markdown', ...paymentMethodKeyboard }
      );
    }

    // --- Step 3a: waiting for the TrxID ---
    if (ctx.session.awaitingTrxId) {
      const trxId = ctx.message.text.trim();
      ctx.session.awaitingTrxId = false;
      const claimedAmount = ctx.session.depositAmount; // what the user said they'd send

      const tx = await getTransaction(trxId);
      if (!tx) {
        // Not found automatically - most commonly because the SMS webhook
        // never received the payment SMS (e.g. the admin's phone had no
        // internet at that moment), not because the user is lying. Fall
        // back to asking the admin directly instead of just rejecting.
        const method = ctx.session.awaitingTrxMethod || 'bKash';
        const request = await createManualDepositRequest({
          trxId,
          telegramId: ctx.from.id,
          claimedAmount: claimedAmount || 0,
          method,
        });

        if (request.duplicate && request.status !== 'pending') {
          return ctx.reply(
            request.status === 'approved'
              ? '✅ এই TrxID আগেই manually approve হয়ে গেছে। আপনার ব্যালেন্স ইতিমধ্যে যোগ হয়ে থাকার কথা।'
              : '❌ এই TrxID আগে manually reject করা হয়েছে। ভুল হলে সাপোর্টে যোগাযোগ করুন।'
          );
        }
        if (request.duplicate) {
          return ctx.reply('⏳ এই TrxID ইতিমধ্যে admin এর কাছে পাঠানো হয়েছে, review এর অপেক্ষায় আছে।');
        }

        if (ADMIN_ID) {
          const user = await getUser(ctx.from.id).catch(() => null);
          const userLabel = `<a href="tg://user?id=${ctx.from.id}">${escapeHtml(user ? user.name || 'Unknown' : 'Unknown')}</a> (ID: ${ctx.from.id})`;
          ctx.telegram
            .sendMessage(
              ADMIN_ID,
              `🧾 <b>Manual Deposit Verification Needed</b>\n\n` +
                `👤 ${userLabel}\n` +
                `💳 Method: ${escapeHtml(method)}\n` +
                `💰 Claimed amount: ${taka(claimedAmount || 0)}\n` +
                `🔢 TrxID: <code>${escapeHtml(trxId)}</code>\n\n` +
                `স্বয়ংক্রিয়ভাবে এই TrxID খুঁজে পাওয়া যায়নি (SMS webhook এ পৌঁছায়নি হয়তো)। ` +
                `নিজে bKash/Nagad অ্যাপ চেক করে নিশ্চিত হয়ে তারপর নিচে থেকে বেছে নিন।`,
              {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                  [
                    Markup.button.callback('✅ Yes, verify', `mdep_yes_${trxId}`),
                    Markup.button.callback('❌ No, reject', `mdep_no_${trxId}`),
                  ],
                ]),
              }
            )
            .catch((e) => console.error('[balance] Failed to notify admin of manual deposit request:', e.message));
        }

        return ctx.reply(
          '⏳ TrxID স্বয়ংক্রিয়ভাবে যাচাই করা যায়নি, তাই এটি admin এর কাছে পাঠানো হয়েছে ম্যানুয়াল ভেরিফিকেশনের জন্য। ' +
            'অনুমোদন হলে আপনার ব্যালেন্স যোগ হয়ে যাবে এবং জানানো হবে।'
        );
      }
      if (tx.used) {
        return ctx.reply('⚠️ এই TrxID আগেই একবার ব্যবহার হয়ে গেছে।');
      }

      try {
        await claimTransaction(trxId, ctx.from.id);
      } catch (err) {
        if (err.message === 'ALREADY_USED') {
          return ctx.reply('⚠️ এই TrxID আগেই একবার ব্যবহার হয়ে গেছে।');
        }
        console.error('claimTransaction error:', err);
        return ctx.reply('❌ পেমেন্ট ভেরিফাই করতে সমস্যা হয়েছে। সাপোর্টে যোগাযোগ করুন।');
      }

      // Credit the REAL amount confirmed by the SMS webhook - never trust
      // the user-typed amount for the actual credit, only for comparison.
      await adjustBalance(ctx.from.id, tx.amount);
      const user = await getUser(ctx.from.id);
      ctx.session.depositAmount = null;
      ctx.session.awaitingTrxMethod = null;

      const mismatchNote =
        claimedAmount && Math.abs(claimedAmount - tx.amount) > 0.5
          ? `\n\n⚠️ আপনি বলেছিলেন ${taka(claimedAmount)}, কিন্তু SMS-এ পাওয়া গেছে ${taka(tx.amount)} - সেই অনুযায়ী যোগ করা হয়েছে।`
          : '';

      return ctx.reply(
        `✅ *Payment Verified!*\n\n` +
          `${taka(tx.amount)} আপনার ব্যালেন্সে যোগ হয়েছে।${mismatchNote}\n` +
          `💵 New Balance: *${taka(user.balance)}*`,
        { parse_mode: 'Markdown' }
      );
    }

    return next();
  });
}

module.exports = { registerBalanceHandler };
