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
 * holding period, no cooldown, and no daily cap - every valid referral
 * gets paid out immediately, every time.
 * ------------------------------------------------------------
 */

const { db, admin } = require('../config/firebase');
const { adjustBalance, getUser, setLastReferralPayoutAt } = require('./userService');
const { taka } = require('../utils/helpers');

const referralsCol = db.collection('referrals');

const BONUS = Number(process.env.REFERRAL_BONUS || 5);

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
  tryPayoutReferral,
  BONUS,
};
