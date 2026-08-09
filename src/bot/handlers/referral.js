/**
 * referral.js - "👥 Refer & Earn" reply-keyboard button
 */

const { Markup } = require('telegraf');
const { getUser } = require('../../services/userService');
const { getReferralsByReferrer } = require('../../services/referralService');
const { taka } = require('../../utils/helpers');

const HOLD_HOURS = Number(process.env.REFERRAL_HOLD_HOURS || 24);
const BONUS = process.env.REFERRAL_BONUS || '5';

const myReferralsKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('📋 My Referral List', 'my_referrals')],
]);

function registerReferralHandler(bot) {
  bot.hears('👥 Refer & Earn', async (ctx) => {
    const user = await getUser(ctx.from.id);
    if (!user) return ctx.reply('Please send /start first.');

    const botUsername = process.env.BOT_USERNAME;
    const link = `https://t.me/${botUsername}?start=${user.referralCode}`;

    await ctx.reply(
      `👥 *Refer & Earn*\n\n` +
        `Share your referral link with friends. When they join, verify all channels, ` +
        `and stay active for ${HOLD_HOURS} hours, you'll automatically earn ${taka(BONUS)}!\n\n` +
        `🔗 Your referral link:\n\`${link}\`\n\n` +
        `💰 Total referral earnings so far: *${taka(user.referralEarnings || 0)}*`,
      { parse_mode: 'Markdown', ...myReferralsKeyboard }
    );
  });

  bot.action('my_referrals', async (ctx) => {
    await ctx.answerCbQuery();
    const referrals = await getReferralsByReferrer(ctx.from.id);

    if (referrals.length === 0) {
      return ctx.reply('👥 আপনি এখনো কাউকে রেফার করেননি। আপনার লিংক শেয়ার করে শুরু করুন!');
    }

    // Sort newest-first.
    referrals.sort((a, b) => {
      const at = a.joinedAt && a.joinedAt.toMillis ? a.joinedAt.toMillis() : 0;
      const bt = b.joinedAt && b.joinedAt.toMillis ? b.joinedAt.toMillis() : 0;
      return bt - at;
    });

    const lines = await Promise.all(
      referrals.map(async (ref, i) => {
        const referredUser = await getUser(ref.referredId).catch(() => null);
        const name = referredUser ? referredUser.name || `User ${ref.referredId}` : `User ${ref.referredId} (deleted)`;

        let status;
        if (ref.rewarded) {
          status = `✅ বোনাস পাওয়া হয়েছে (${taka(BONUS)})`;
        } else if (!referredUser || !referredUser.channelsVerifiedAt) {
          status = '⏳ এখনো ৪টা চ্যানেলে জয়েন যাচাই হয়নি';
        } else {
          const verifiedAtMs = referredUser.channelsVerifiedAt.toMillis
            ? referredUser.channelsVerifiedAt.toMillis()
            : new Date(referredUser.channelsVerifiedAt).getTime();
          const elapsedHours = (Date.now() - verifiedAtMs) / (1000 * 60 * 60);
          const remainingHours = HOLD_HOURS - elapsedHours;
          if (remainingHours <= 0) {
            status = '⏳ যাচাই সম্পন্ন, শীঘ্রই বোনাস আসবে (পরবর্তী ঘণ্টার চেক-এ)';
          } else if (remainingHours < 1) {
            status = `⏳ বাকি প্রায় ${Math.ceil(remainingHours * 60)} মিনিট`;
          } else {
            status = `⏳ বাকি প্রায় ${Math.ceil(remainingHours)} ঘণ্টা`;
          }
        }

        return `${i + 1}. ${name}\n   ${status}`;
      })
    );

    const rewardedCount = referrals.filter((r) => r.rewarded).length;

    await ctx.reply(
      `📋 আপনার রেফারেল লিস্ট (মোট ${referrals.length} জন, বোনাস পাওয়া গেছে ${rewardedCount} জন থেকে)\n\n` +
        lines.join('\n\n')
    );
  });
}

module.exports = { registerReferralHandler };
