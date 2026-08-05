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
  };

  await ref.set(newUser);

  // If this user came from a referral, log a referrals/ doc for the cron job to process later.
  if (newUser.referredBy) {
    await db.collection('referrals').doc(String(telegramId)).set({
      referrerId: newUser.referredBy,
      referredId: telegramId,
      joinedAt: admin.firestore.FieldValue.serverTimestamp(),
      rewarded: false,
    });
  }

  return { user: newUser, isNew: true };
}

/** Mark the timestamp when a user first passes the 4-channel force-join check. */
async function markChannelsVerified(telegramId) {
  const ref = usersCol.doc(String(telegramId));
  const snap = await ref.get();
  if (snap.exists && !snap.data().channelsVerifiedAt) {
    await ref.update({ channelsVerifiedAt: admin.firestore.FieldValue.serverTimestamp() });
  }
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
  adjustBalance,
  setBanned,
  iterateAllUsers,
};
