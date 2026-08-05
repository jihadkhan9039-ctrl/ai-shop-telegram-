/**
 * referralCron.js
 * ------------------------------------------------------------
 * Runs every hour (node-cron). For every un-rewarded referral:
 *   1. Referred user must have verified all 4 channels (channelsVerifiedAt set)
 *   2. At least REFERRAL_HOLD_HOURS must have passed since they joined
 *   3. Referred user must still be joined to all 4 channels right now
 *      (re-checked live, so someone who joins-then-leaves doesn't pay out)
 * If all pass -> credit REFERRAL_BONUS to the referrer + notify them.
 * ------------------------------------------------------------
 */

const cron = require('node-cron');
const { getPendingReferrals, markRewarded } = require('../services/referralService');
const { getUser, adjustBalance } = require('../services/userService');
const { getNotJoinedChannels } = require('../bot/middlewares/forceJoin');
const { taka } = require('../utils/helpers');

const HOLD_HOURS = Number(process.env.REFERRAL_HOLD_HOURS || 24);
const BONUS = Number(process.env.REFERRAL_BONUS || 5);

async function processReferrals(bot) {
  const pending = await getPendingReferrals();
  if (pending.length === 0) return;

  console.log(`[referralCron] Checking ${pending.length} pending referral(s)...`);

  for (const ref of pending) {
    try {
      const referredUser = await getUser(ref.referredId);
      if (!referredUser) continue;

      // Must have completed the force-join check at least once.
      if (!referredUser.channelsVerifiedAt) continue;

      const verifiedAtMs = referredUser.channelsVerifiedAt.toMillis
        ? referredUser.channelsVerifiedAt.toMillis()
        : new Date(referredUser.channelsVerifiedAt).getTime();
      const hoursSinceVerified = (Date.now() - verifiedAtMs) / (1000 * 60 * 60);
      if (hoursSinceVerified < HOLD_HOURS) continue; // still inside the holding window

      // Re-check live membership so a "join then leave" can't be rewarded.
      const fakeCtx = { telegram: bot.telegram };
      const stillMissing = await getNotJoinedChannels(fakeCtx, ref.referredId);
      if (stillMissing.length > 0) continue;

      // All conditions met -> pay out.
      await adjustBalance(ref.referrerId, BONUS, { referralEarning: true });
      await markRewarded(ref.referredId);

      try {
        await bot.telegram.sendMessage(
          ref.referrerId,
          `🎉 Referral Bonus!\n\nYour friend stayed active for ${HOLD_HOURS}h and you've earned ${taka(BONUS)}!`
        );
      } catch {
        /* referrer may have blocked the bot - ignore notification failure */
      }

      console.log(`[referralCron] Rewarded referrer ${ref.referrerId} for referred user ${ref.referredId}`);
    } catch (err) {
      console.error(`[referralCron] Error processing referral ${ref.id}:`, err);
    }
  }
}

/** Registers the hourly cron job. Call once at startup with the live bot instance. */
function startReferralCron(bot) {
  // Runs at minute 0 of every hour. Change to '*/5 * * * *' for testing (every 5 min).
  cron.schedule('0 * * * *', () => {
    processReferrals(bot).catch((err) => console.error('[referralCron] fatal error:', err));
  });
  console.log('[referralCron] Scheduled to run every hour.');
}

module.exports = { startReferralCron, processReferrals };
