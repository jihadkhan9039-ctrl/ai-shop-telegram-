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
 * holding period, no cooldown, and no daily cap.
 *
 * ABUSE DETECTION: instead of a cap that slows down every referrer, this
 * watches for an unusual BURST of rewarded referrals from the same
 * referrer in a short window (REFERRAL_ABUSE_THRESHOLD referrals within
 * REFERRAL_ABUSE_WINDOW_MINUTES minutes - default 5 within 10) - the
 * pattern you'd expect from someone farming fake accounts, not a real
 * person organically sharing their link. When that's detected, the
 * referrer is auto-banned (see setBanned in userService) and the admin is
 * notified. The referral that tipped the threshold still gets paid (the
 * pattern is only visible after the fact), but every referral after that
 * won't be, since banned referrers are never paid out.
 * ------------------------------------------------------------
 */

const { db, admin } = require('../config/firebase');
const { adjustBalance, getUser, setBanned, setLastReferralPayoutAt } = require('./userService');
const { taka } = require('../utils/helpers');

const referralsCol = db.collection('referrals');

const BONUS = Number(process.env.REFERRAL_BONUS || 5);
const ABUSE_WINDOW_MS = Number(process.env.REFERRAL_ABUSE_WINDOW_MINUTES || 10) * 60 * 1000;
const ABUSE_THRESHOLD = Number(process.env.REFERRAL_ABUSE_THRESHOLD || 5);
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
    // Set here (not at referral-doc creation) so it's only ever present on
    // referrals that actually got paid out - that's the only set the 24h
    // membership recheck cron cares about (see jobs/referralCron.js).
    membershipChecked: false,
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

  await checkForAbuseAndBan(ref.referrerId, telegram);
}

/**
 * Runs right after every successful payout. Counts how many referrals
 * this same referrer has had REWARDED within the last ABUSE_WINDOW_MS -
 * a burst well beyond what a real person sharing their link organically
 * would produce is the signature of fake-account farming. If the count
 * crosses ABUSE_THRESHOLD, auto-bans the referrer (so nothing further
 * gets paid to them) and DMs the admin with the details for a manual
 * look. This never un-bans automatically - that's an admin decision.
 */
async function checkForAbuseAndBan(referrerId, telegram) {
  const referrer = await getUser(referrerId).catch(() => null);
  if (!referrer || referrer.banned) return; // already banned, or lookup failed - nothing to do

  const snap = await referralsCol.where('referrerId', '==', Number(referrerId)).where('rewarded', '==', true).get();
  const windowStart = Date.now() - ABUSE_WINDOW_MS;
  const recentCount = snap.docs.filter((d) => {
    const rewardedAt = d.data().rewardedAt;
    const ms = rewardedAt && rewardedAt.toMillis ? rewardedAt.toMillis() : null;
    return ms !== null && ms >= windowStart;
  }).length;

  if (recentCount < ABUSE_THRESHOLD) return;

  await setBanned(referrerId, true);
  console.warn(`[referral] ⚠️ AUTO-BANNED referrer ${referrerId}: ${recentCount} referrals rewarded within ${ABUSE_WINDOW_MS / 60000} minutes (threshold: ${ABUSE_THRESHOLD}).`);

  if (telegram && ADMIN_ID) {
    telegram
      .sendMessage(
        ADMIN_ID,
        `🚨 Referrer auto-banned - unusual referral activity\n\n` +
          `Referrer: ${referrer.name || 'Unknown'} (ID: ${referrerId})\n` +
          `${recentCount} referrals rewarded within ${ABUSE_WINDOW_MS / 60000} minutes (threshold: ${ABUSE_THRESHOLD}).\n\n` +
          `They've been automatically banned - use /adminpanel → Ban/Unban User to review and unban if this was a false positive (e.g. a genuinely popular referrer).`
      )
      .catch((e) => console.error('[referral] failed to notify admin of auto-ban:', e.message));
    telegram
      .sendMessage(referrerId, `🚫 আপনার একাউন্টে অস্বাভাবিক রেফারেল কার্যকলাপ শনাক্ত হয়েছে, তাই এটি সাময়িকভাবে ব্লক করা হয়েছে। এটি ভুল মনে হলে সাপোর্টে যোগাযোগ করুন।`)
      .catch((e) => console.error('[referral] failed to notify banned referrer:', e.message));
  }
}

module.exports = {
  getPendingReferrals,
  markRewarded,
  getReferralsByReferrer,
  tryPayoutReferral,
  getReferralStats,
  getTopReferrers,
  getReferralsPendingMembershipCheck,
  markMembershipChecked,
  BONUS,
};

/**
 * Cheap referral overview for the /status admin command. Total payout is
 * derived as (rewarded count * BONUS) rather than summed field-by-field,
 * since BONUS is fixed per referral - avoids downloading every doc.
 */
async function getReferralStats() {
  const [totalSnap, rewardedSnap] = await Promise.all([
    referralsCol.count().get(),
    referralsCol.where('rewarded', '==', true).count().get(),
  ]);
  const rewardedCount = rewardedSnap.data().count;
  return {
    totalReferrals: totalSnap.data().count,
    rewardedReferrals: rewardedCount,
    totalPayout: rewardedCount * BONUS,
  };
}

/**
 * Leaderboard for the "🏆 Top Referrals" button. Reads every REWARDED
 * referral doc and counts them per referrer in memory, then returns the
 * top N. There's no per-user running counter to query instead (yet), so
 * this is O(rewarded referrals) - perfectly fine at this bot's scale, and
 * it correctly reflects full history with no backfill/migration needed.
 * If the referrals collection ever grows very large, switch to a
 * `referralCount` field maintained on each user doc via increment() at
 * payout time and query that with orderBy+limit instead.
 */
async function getTopReferrers(limit = 5) {
  const snap = await referralsCol.where('rewarded', '==', true).get();
  const counts = {};
  snap.docs.forEach((d) => {
    const referrerId = d.data().referrerId;
    counts[referrerId] = (counts[referrerId] || 0) + 1;
  });
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([referrerId, count]) => ({ referrerId: Number(referrerId), count }));
}

/**
 * Referrals that were rewarded but haven't had their 24h "did they leave
 * the channels?" recheck yet (see jobs/referralCron.js). Two equality
 * filters only (no range/orderBy), so no composite Firestore index is
 * needed - the actual 24h-age check happens in the caller, comparing each
 * doc's own rewardedAt individually.
 */
async function getReferralsPendingMembershipCheck() {
  const snap = await referralsCol.where('rewarded', '==', true).where('membershipChecked', '==', false).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Records the outcome of the 24h membership recheck for one referral. */
async function markMembershipChecked(referredId, leftChannels) {
  await referralsCol.doc(String(referredId)).update({
    membershipChecked: true,
    membershipCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
    leftChannelsAfterReward: leftChannels,
  });
}
