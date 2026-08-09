/**
 * referralCron.js
 * ------------------------------------------------------------
 * Referral bonuses are now paid INSTANTLY the moment a referred user
 * completes force-join verification (see forceJoin.js -> tryPayoutReferral).
 *
 * This hourly cron is now just a SAFETY-NET SWEEP: it retries any referral
 * that's still unrewarded (most commonly because the referrer had already
 * hit their REFERRAL_DAILY_CAP for the day at the moment their friend
 * verified). Once the referrer is back under the cap, this sweep pays them.
 * It also catches the rare case where the instant payout attempt failed
 * due to a transient error.
 * ------------------------------------------------------------
 */

const cron = require('node-cron');
const { getPendingReferrals, tryPayoutReferral } = require('../services/referralService');
const { getUser } = require('../services/userService');

async function processReferrals(bot) {
  const pending = await getPendingReferrals();
  if (pending.length === 0) return;

  console.log(`[referralCron] Sweeping ${pending.length} unrewarded referral(s)...`);

  for (const ref of pending) {
    try {
      const referredUser = await getUser(ref.referredId);
      // Only retry ones where the referred user has actually completed
      // verification at some point - tryPayoutReferral re-checks the daily
      // cap itself and is a safe no-op if still not eligible.
      if (referredUser && referredUser.channelsVerifiedAt) {
        await tryPayoutReferral(ref.referredId, bot.telegram);
      }
    } catch (err) {
      console.error(`[referralCron] Error sweeping referral ${ref.id}:`, err);
    }
  }
}

/** Registers the hourly safety-net cron job. Call once at startup with the live bot instance. */
function startReferralCron(bot) {
  // Runs at minute 0 of every hour. Change to '*/5 * * * *' for testing (every 5 min).
  cron.schedule('0 * * * *', () => {
    processReferrals(bot).catch((err) => console.error('[referralCron] fatal error:', err));
  });
  console.log('[referralCron] Scheduled hourly safety-net sweep.');
}

module.exports = { startReferralCron, processReferrals };
