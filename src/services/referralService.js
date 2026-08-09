/**
 * referralService.js
 * ------------------------------------------------------------
 * referrals/{referredTelegramId}
 *   referrerId    number
 *   referredId    number
 *   joinedAt      Timestamp   (when the referred user first pressed /start)
 *   rewarded      boolean     (true once the ৳10 bonus has been paid out)
 * ------------------------------------------------------------
 * The actual "did they stay 24h + verify all channels" check happens in
 * src/jobs/referralCron.js, which reads pending docs from here.
 * ------------------------------------------------------------
 */

const { db } = require('../config/firebase');

const referralsCol = db.collection('referrals');

/** All referral records that have not yet been rewarded. */
async function getPendingReferrals() {
  const snap = await referralsCol.where('rewarded', '==', false).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function markRewarded(referredId) {
  await referralsCol.doc(String(referredId)).update({ rewarded: true });
}

/** All referrals (rewarded or not) made by one specific referrer - for the "My Referrals" view. */
async function getReferralsByReferrer(referrerId) {
  const snap = await referralsCol.where('referrerId', '==', Number(referrerId)).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

module.exports = { getPendingReferrals, markRewarded, getReferralsByReferrer };
