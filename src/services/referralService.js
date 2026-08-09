/**
 * referralService.js
 * ------------------------------------------------------------
 * referrals/{referredTelegramId}
 *   referrerId    number
 *   referredId    number
 *   joinedAt      Timestamp   (when the referred user first pressed /start)
 *   rewarded      boolean     (true once the bonus has been paid out)
 *   rewardedAt    Timestamp|null
 * ------------------------------------------------------------
 * PAYOUT POLICY: the bonus is paid INSTANTLY the moment the referred user
 * completes force-join verification for the very first time (see
 * forceJoin.js, which calls tryPayoutReferral() below). There is no
 * holding period.
 *
 * Anti-fraud: instead of a time delay, we cap how many referral bonuses a
 * single referrer can earn per day (REFERRAL_DAILY_CAP). This blunts mass
 * fake-account abuse while still paying legitimate referrers instantly.
 * A referral that hits the cap simply stays unrewarded and is retried by
 * the hourly cron sweep (see jobs/referralCron.js) once the referrer is
 * back under the cap the next day.
 * ------------------------------------------------------------
 */

const { db, admin } = require('../config/firebase');
const { adjustBalance, getUser, setLastReferralPayoutAt, markCapAlertSent } = require('./userService');
const { taka } = require('../utils/helpers');

const referralsCol = db.collection('referrals');

const BONUS = Number(process.env.REFERRAL_BONUS || 5);
const DAILY_CAP = Number(process.env.REFERRAL_DAILY_CAP || 10);
// Minimum gap between two referral payouts to the SAME referrer. Throttles
// bot-driven mass-fake-account bursts (a script spinning up many accounts
// within seconds/minutes gets slowed down) without affecting a normal
// person referring friends over time.
const COOLDOWN_MS = Number(process.env.REFERRAL_COOLDOWN_SECONDS || 60) * 1000;
const ADMIN_ID = process.env.ADMIN_ID;

/** All referral records that have not yet been rewarded (used by the cron safety-sweep). */
async function getPendingReferrals() {
  const snap = await referralsCol.where('rewarded', '==', false).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function markRewarded(referredId) {
  await referralsCol.doc(String(referredId)).update({
    rewarded: true,
    rewardedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/** All referrals (rewarded or not) made by one specific referrer - for the "My Referrals" view. */
async function getReferralsByReferrer(referrerId) {
  const snap = await referralsCol.where('referrerId', '==', Number(referrerId)).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * How many referral bonuses this referrer has already been paid TODAY
 * (server local time). Single-field query (no composite index needed) -
 * filtering by date happens in memory, which is fine since one referrer's
 * total referral count is expected to stay small (tens, not thousands).
 */
async function countRewardedToday(referrerId) {
  const snap = await referralsCol.where('referrerId', '==', Number(referrerId)).get();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startMs = startOfDay.getTime();

  return snap.docs.filter((d) => {
    const data = d.data();
    if (!data.rewarded || !data.rewardedAt) return false;
    const t = data.rewardedAt.toMillis ? data.rewardedAt.toMillis() : new Date(data.rewardedAt).getTime();
    return t >= startMs;
  }).length;
}

/**
 * Attempt to instantly pay out the referral bonus for `referredId`'s
 * referrer, if eligible. Safe to call multiple times (no-ops once
 * rewarded=true). Call this exactly once, right when a user completes
 * force-join verification for the first time.
 *
 * @param {number} referredId - the user who just got verified
 * @param {import('telegraf').Telegram} [telegram] - used to notify the referrer; optional
 */
async function tryPayoutReferral(referredId, telegram) {
  const refDoc = await referralsCol.doc(String(referredId)).get();
  if (!refDoc.exists) {
    console.log(`[referral] No referral record for user ${referredId} (they weren't referred, or the record failed to save).`);
    return;
  }

  const ref = refDoc.data();
  if (ref.rewarded) {
    console.log(`[referral] User ${referredId}'s referral was already rewarded, skipping.`);
    return;
  }

  const referrer = await getUser(ref.referrerId).catch(() => null);

  // Banned referrers never get paid, no matter what.
  if (referrer && referrer.banned) {
    console.log(`[referral] Referrer ${ref.referrerId} is banned - not paying out.`);
    return;
  }

  // Cooldown: throttle rapid-fire payouts to the same referrer.
  const lastPayoutMs =
    referrer && referrer.lastReferralPayoutAt && referrer.lastReferralPayoutAt.toMillis
      ? referrer.lastReferralPayoutAt.toMillis()
      : null;
  if (lastPayoutMs && Date.now() - lastPayoutMs < COOLDOWN_MS) {
    console.log(`[referral] Referrer ${ref.referrerId} is in cooldown (< ${COOLDOWN_MS / 1000}s since last payout) - will retry later.`);
    return;
  }

  const rewardedToday = await countRewardedToday(ref.referrerId);
  if (rewardedToday >= DAILY_CAP) {
    console.log(
      `[referral] Referrer ${ref.referrerId} hit the daily cap (${DAILY_CAP}). ` +
        `Referral for ${referredId} stays pending - the hourly sweep will retry it.`
    );

    // Alert the admin ONCE per referrer per day so suspicious high-volume
    // referring can be manually reviewed (and the user banned if it's abuse).
    const todayStr = new Date().toISOString().slice(0, 10);
    if (ADMIN_ID && telegram && (!referrer || referrer.lastCapAlertDate !== todayStr)) {
      markCapAlertSent(ref.referrerId, todayStr).catch((e) => console.error('[referral] markCapAlertSent failed:', e.message));
      telegram
        .sendMessage(
          ADMIN_ID,
          `⚠️ Referral daily cap reached\n\n` +
            `Referrer ${ref.referrerId} has hit the daily cap of ${DAILY_CAP} referral bonuses. ` +
            `This could be legitimate (a popular referrer) or fake-account abuse - worth reviewing.\n\n` +
            `Use /adminpanel → Ban/Unban User if this looks like abuse.`
        )
        .catch((e) => console.error('[referral] admin cap-alert failed:', e.message));
    }
    return;
  }

  await adjustBalance(ref.referrerId, BONUS, { referralEarning: true });
  await markRewarded(referredId);
  setLastReferralPayoutAt(ref.referrerId).catch((e) => console.error('[referral] setLastReferralPayoutAt failed:', e.message));
  console.log(`[referral] Paid ${BONUS} taka to referrer ${ref.referrerId} for referred user ${referredId}.`);

  if (telegram) {
    telegram
      .sendMessage(
        ref.referrerId,
        `🎉 রেফারেল বোনাস পেয়েছেন!\n\n` +
          `আপনার রেফার করা একজন ইউজার সব চ্যানেল জয়েন করে ভেরিফাই সম্পন্ন করেছেন।\n` +
          `💰 ${taka(BONUS)} আপনার ব্যালেন্সে যোগ হয়েছে।`
      )
      .catch((e) => console.error('[referral] failed to notify referrer of payout:', e.message));
  }
}

module.exports = {
  getPendingReferrals,
  markRewarded,
  getReferralsByReferrer,
  countRewardedToday,
  tryPayoutReferral,
  BONUS,
  DAILY_CAP,
};
