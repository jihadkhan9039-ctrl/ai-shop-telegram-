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
 * Captcha status is checked/set independently of the full profile
 * (ensureUser/hasFullProfile below), using a plain merge-set that only
 * ever touches the `captchaVerified` field. This deliberately mirrors the
 * earlier fix for the "partial stub doc" bug: ensureUser's own
 * hasFullProfile check looks specifically at the `balance` field, so a
 * captcha-only write here can never be mistaken for a fully-created
 * profile, and never blocks one from being created properly later.
 */
async function hasPassedCaptcha(telegramId) {
  const snap = await usersCol.doc(String(telegramId)).get();
  return snap.exists && snap.data().captchaVerified === true;
}

async function markCaptchaPassed(telegramId) {
  await usersCol.doc(String(telegramId)).set(
    { captchaVerified: true, captchaVerifiedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

/**
 * Create the user document if it doesn't already have a full profile.
 * Returns { user, isNew }.
 *
 * IMPORTANT: we do NOT just check snap.exists here. forceJoin.js's
 * markForceJoinRecheck() can create a PARTIAL stub doc (containing only
 * lastForceJoinCheckAt, via set+merge) for a user whose very first update
 * wasn't a /start command. If we only checked snap.exists, that stub would
 * make us think the user was already fully registered and we'd skip
 * setting name/telegramId/balance/referralCode/referredBy forever - which
 * silently broke referral tracking (referredBy never saved) and showed
 * "undefined" everywhere in the UI. Checking for the `balance` field
 * specifically (only ever set by the full-creation branch below) tells us
 * whether a REAL profile exists yet.
 */
async function ensureUser(ctx, referredBy = null) {
  const telegramId = ctx.from.id;
  const ref = usersCol.doc(String(telegramId));
  const snap = await ref.get();
  const existingData = snap.exists ? snap.data() : null;
  const hasFullProfile = existingData && existingData.balance !== undefined;

  if (hasFullProfile) {
    if (referredBy) {
      console.log(`[ensureUser] User ${telegramId} already exists - referral payload (referrer ${referredBy}) ignored (not their first /start).`);
    }
    return { user: { id: snap.id, ...existingData }, isNew: false };
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

  // merge:true so we don't clobber a pre-existing partial stub doc's fields
  // (e.g. lastForceJoinCheckAt) - we just fill in the rest on top of it.
  await ref.set(newUser, { merge: true });
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

/**
 * Cheap counts for the /status admin command. Uses Firestore's server-side
 * count() aggregation (a single small billed read regardless of collection
 * size) instead of downloading every user doc just to count them.
 */
async function getUserStats() {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfWeek.getDate() - 6); // last 7 days incl. today

  const [totalSnap, bannedSnap, todaySnap, weekSnap, verifiedSnap] = await Promise.all([
    usersCol.count().get(),
    usersCol.where('banned', '==', true).count().get(),
    usersCol.where('joinedAt', '>=', startOfDay).count().get(),
    usersCol.where('joinedAt', '>=', startOfWeek).count().get(),
    usersCol.where('channelsVerifiedAt', '!=', null).count().get(),
  ]);

  return {
    totalUsers: totalSnap.data().count,
    bannedUsers: bannedSnap.data().count,
    newToday: todaySnap.data().count,
    newThisWeek: weekSnap.data().count,
    verifiedUsers: verifiedSnap.data().count,
  };
}

/**
 * Paginated "highest balance first" user list for the admin "💰 Top
 * Balances" view. Single-field orderBy (no secondary tiebreaker field) so
 * this needs no composite index - Firestore auto-creates single-field
 * indexes. Cursor is just the last-seen balance value; if several users
 * share the exact same balance right at a page boundary, one or two could
 * theoretically be skipped/repeated - an acceptable tradeoff here since
 * this is an admin convenience view, not something that needs to be
 * perfectly gapless.
 */
async function getUsersByBalance(limit = 10, afterBalance = null) {
  let query = usersCol.orderBy('balance', 'desc').limit(limit);
  if (afterBalance !== null && afterBalance !== undefined) {
    query = query.startAfter(afterBalance);
  }
  const snap = await query.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

module.exports = {
  getUser,
  hasPassedCaptcha,
  markCaptchaPassed,
  ensureUser,
  markChannelsVerified,
  markForceJoinRecheck,
  adjustBalance,
  setBanned,
  setLastReferralPayoutAt,
  iterateAllUsers,
  getUserStats,
  getUsersByBalance,
};
