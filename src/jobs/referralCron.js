/**
 * referralCron.js
 * ------------------------------------------------------------
 * Referral bonuses are now paid INSTANTLY the moment a referred user
 * completes force-join verification (see forceJoin.js -> tryPayoutReferral).
 *
 * This hourly cron is now just a SAFETY-NET SWEEP: it retries any referral
 * that's still unrewarded, which should now only happen in the rare case
 * where the instant payout attempt failed due to a transient error.
 *
 * A separate DAILY sweep (see checkMembershipAfter24h below) re-verifies
 * that rewarded referrals are still actually in the required channels 24h
 * later - a lightweight guard against referral farming (e.g. someone
 * spinning up throwaway accounts, joining just long enough to trigger the
 * instant payout, then leaving). It never claws back the bonus
 * automatically - a leaving user might be entirely legitimate - it just
 * flags the referral doc and pings the admin so a human can decide whether
 * it looks like abuse worth following up on (e.g. many flags from the same
 * referrer in a short window).
 * ------------------------------------------------------------
 */

const cron = require('node-cron');
const { getPendingReferrals, tryPayoutReferral, getReferralsPendingMembershipCheck, markMembershipChecked } = require('../services/referralService');
const { getUser } = require('../services/userService');
const { getNotJoinedChannels } = require('../bot/middlewares/forceJoin');

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

const MEMBERSHIP_RECHECK_DELAY_MS = 24 * 60 * 60 * 1000; // 24 hours
const ADMIN_ID = process.env.ADMIN_ID;

async function checkMembershipAfter24h(bot) {
  const candidates = await getReferralsPendingMembershipCheck();
  if (candidates.length === 0) return;

  const now = Date.now();
  const due = candidates.filter((ref) => {
    const rewardedMs = ref.rewardedAt && ref.rewardedAt.toMillis ? ref.rewardedAt.toMillis() : null;
    return rewardedMs !== null && now - rewardedMs >= MEMBERSHIP_RECHECK_DELAY_MS;
  });
  if (due.length === 0) return;

  console.log(`[referralCron] Running 24h membership recheck on ${due.length} referral(s)...`);

  for (const ref of due) {
    try {
      // getNotJoinedChannels only reads ctx.telegram - a plain object with
      // that one property stands in fine for the real ctx it normally gets
      // called with from inside a Telegraf update handler.
      const notJoined = await getNotJoinedChannels({ telegram: bot.telegram }, ref.referredId);
      const leftChannels = notJoined.length > 0;
      await markMembershipChecked(ref.referredId, leftChannels);

      if (leftChannels && ADMIN_ID) {
        const referredUser = await getUser(ref.referredId).catch(() => null);
        const referrerUser = await getUser(ref.referrerId).catch(() => null);
        await bot.telegram
          .sendMessage(
            ADMIN_ID,
            `🚩 Referral flagged - referred user left channel(s) within 24h of reward\n\n` +
              `Referrer: ${referrerUser ? referrerUser.name : 'Unknown'} (ID: ${ref.referrerId})\n` +
              `Referred: ${referredUser ? referredUser.name : 'Unknown'} (ID: ${ref.referredId})\n` +
              `Missing from: ${notJoined.length} of 4 required channel(s)\n\n` +
              `This doesn't automatically remove the bonus - just worth a manual look, ` +
              `especially if this referrer has several flags.`
          )
          .catch((e) => console.error('[referralCron] Failed to notify admin of membership flag:', e.message));
      }
    } catch (err) {
      console.error(`[referralCron] Error checking membership for referral ${ref.id}:`, err);
    }
  }
}

/** Registers the hourly safety-net + 24h membership-recheck cron jobs. Call once at startup with the live bot instance. */
function startReferralCron(bot) {
  // Runs at minute 0 of every hour. Change to '*/5 * * * *' for testing (every 5 min).
  cron.schedule('0 * * * *', () => {
    processReferrals(bot).catch((err) => console.error('[referralCron] fatal error:', err));
    checkMembershipAfter24h(bot).catch((err) => console.error('[referralCron] fatal error (membership check):', err));
  });
  console.log('[referralCron] Scheduled hourly safety-net sweep + 24h membership recheck.');
}

module.exports = { startReferralCron, processReferrals, checkMembershipAfter24h };
