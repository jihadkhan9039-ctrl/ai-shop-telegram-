/**
 * userService.js
 * ------------------------------------------------------------
 * All Firestore reads/writes related to the `users` collection.
 *
 * users/{telegramId}
 *   name              string
 *   username           string|null
 *   telegramId          number
 *   balance             number   (in Taka)
 *   referralEarnings    number   (in Taka, subset of balance)
 *   referredBy          number|null   (telegramId of referrer)
 *   referralCode        string
 *   banned              boolean
 *   joinedAt            Timestamp
 *   channelsVerifiedAt  Timestamp|null  (first time all 4 channels confirmed)
 * ------------------------------------------------------------
 */

const { db, admin } = require('../config/firebase');
const { generateReferralCode } = require('../utils/helpers');

const usersCol = db.collection('users');

/** Fetch a user document by Telegram id. Returns null if not found. */
async function getUser(telegramId) {
  const snap = await usersCol.doc(String(telegramId)).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

/**
 * Create the user document if it doesn't already exist.
 * Returns { user, isNew }.
 */
async function ensureUser(ctx, referredBy = null) {
  const telegramId = ctx.from.id;
  const ref = usersCol.doc(String(telegramId));
  const snap = await ref.get();

  if (snap.exists) {
    if (referredBy) {
      console.log(`[ensureUser] User ${telegramId} already exists - referral payload (referrer ${referredBy}) ignored (not their first /start).`);
    }
    return { user: { id: snap.id, ...snap.data() }, isNew: false };
  }

  const newUser = {
    telegramId,
    name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '),
    username: ctx.from.username || null,
    balance: 0,
    referralEarnings: 0,
    referredBy: referredBy && referredBy !== telegramId ? referredBy : null,
    referralCode: generateReferralCode(telegramId),
    banned: false,
    joinedAt: admin.firestore.FieldValue.serverTimestamp(),
    channelsVerifiedAt: null,
    lastForceJoinCheckAt: null,
  };

  if (referredBy && referredBy === telegramId) {
    console.log(`[ensureUser] User ${telegramId} tried to refer themselves - blocked.`);
  }

  await ref.set(newUser);
  console.log(`[ensureUser] Created new user ${telegramId}${newUser.referredBy ? ` (referred by ${newUser.referredBy})` : ''}.`);

  // If this user came from a referral, log a referrals/ doc so we can pay
  // the referrer out instantly once this user finishes force-join
  // verification (see forceJoin.js / referralService.tryPayoutReferral).
  if (newUser.referredBy) {
    await db.collection('referrals').doc(String(telegramId)).set({
      referrerId: newUser.referredBy,
      referredId: telegramId,
      joinedAt: admin.firestore.FieldValue.serverTimestamp(),
      rewarded: false,
      rewardedAt: null,
    });
    console.log(`[ensureUser] Saved referrals/${telegramId} -> referrerId ${newUser.referredBy}.`);
  }

  return { user: newUser, isNew: true };
}

/** One-time timestamp: the FIRST time this user passed the 4-channel check.
 *  Triggers the instant referral payout (see forceJoin.js) - never overwritten after that. */
async function markChannelsVerified(telegramId) {
  const ref = usersCol.doc(String(telegramId));
  const snap = await ref.get();
  if (snap.exists && !snap.data().channelsVerifiedAt) {
    await ref.update({ channelsVerifiedAt: admin.firestore.FieldValue.serverTimestamp() });
  }
}

/** Rolling timestamp: the most recent time we live-checked force-join membership.
 *  Used only by the forceJoin middleware's TTL cache - safe to overwrite every time.
 *  Uses set+merge (not update) because on a brand-new user's very first message,
 *  forceJoin's middleware runs before /start has created the user doc yet. */
async function markForceJoinRecheck(telegramId) {
  await usersCol.doc(String(telegramId)).set(
    { lastForceJoinCheckAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

/** Atomically add (or subtract, using a negative number) to a user's balance. */
async function adjustBalance(telegramId, amount, { referralEarning = false } = {}) {
  const ref = usersCol.doc(String(telegramId));
  const updates = { balance: admin.firestore.FieldValue.increment(amount) };
  if (referralEarning) {
    updates.referralEarnings = admin.firestore.FieldValue.increment(amount);
  }
  await ref.update(updates);
}

async function setBanned(telegramId, banned) {
  await usersCol.doc(String(telegramId)).update({ banned });
}

/** Rolling timestamp: the last time this user (as a REFERRER) was paid a
 *  referral bonus. Used by referralService's cooldown anti-abuse check. */
async function setLastReferralPayoutAt(telegramId) {
  await usersCol.doc(String(telegramId)).set(
    { lastReferralPayoutAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

/** Records today's date on the user doc so we only alert the admin ONCE per
 *  referrer per day when they hit the daily referral cap (avoids spam). */
async function markCapAlertSent(telegramId, dateStr) {
  await usersCol.doc(String(telegramId)).set({ lastCapAlertDate: dateStr }, { merge: true });
}

/** Return all user documents (used for broadcast). Streams in batches to avoid huge memory spikes. */
async function* iterateAllUsers(batchSize = 300) {
  let lastDoc = null;
  while (true) {
    let query = usersCol.orderBy('telegramId').limit(batchSize);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snap = await query.get();
    if (snap.empty) return;
    for (const doc of snap.docs) yield { id: doc.id, ...doc.data() };
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < batchSize) return;
  }
}

module.exports = {
  getUser,
  ensureUser,
  markChannelsVerified,
  markForceJoinRecheck,
  adjustBalance,
  setBanned,
  setLastReferralPayoutAt,
  markCapAlertSent,
  iterateAllUsers,
};
