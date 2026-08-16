/**
 * transactionService.js
 * ------------------------------------------------------------
 * transactions/{trxId}
 *   trxId       string   (bKash/Nagad transaction id, used as doc id -> natural uniqueness)
 *   amount      number
 *   method      string   "bKash" | "Nagad" | "unknown"
 *   sender      string   the SMS's alphanumeric sender ID (e.g. "bKash") -
 *                         only ever "bKash"/"Nagad" now that smsWebhook.js
 *                         rejects anything else before this is ever called
 *   rawSms      string   original SMS text (for audits)
 *   used        boolean
 *   usedBy      number|null   telegramId that redeemed it
 *   createdAt   Timestamp
 *   usedAt      Timestamp|null
 * ------------------------------------------------------------
 */

const { db, admin } = require('../config/firebase');

const txCol = db.collection('transactions');

/** Save an incoming SMS-parsed transaction. Uses trxId as the doc id so duplicates simply overwrite/no-op. */
async function saveIncomingTransaction({ trxId, amount, method, sender, rawSms }) {
  const ref = txCol.doc(trxId);
  const existing = await ref.get();
  if (existing.exists) {
    // Already recorded (e.g. SMS forwarded twice) - don't clobber a used flag.
    return { id: ref.id, ...existing.data(), duplicate: true };
  }
  const data = {
    trxId,
    amount: Number(amount),
    method,
    sender: sender || null,
    rawSms,
    used: false,
    usedBy: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    usedAt: null,
  };
  await ref.set(data);
  return { id: ref.id, ...data, duplicate: false };
}

/** Look up a transaction by TrxID (user-submitted, so normalize casing/whitespace). */
async function getTransaction(trxId) {
  const normalized = String(trxId).trim().toUpperCase();
  const snap = await txCol.doc(normalized).get();
  if (snap.exists) return { id: snap.id, ...snap.data() };

  // Fall back to a case-insensitive scan in case the SMS parser stored different casing.
  const scan = await txCol.where('trxId', '==', trxId.trim()).limit(1).get();
  if (!scan.empty) return { id: scan.docs[0].id, ...scan.docs[0].data() };
  return null;
}

/**
 * Atomically mark a transaction as used by a given user (prevents double-spending
 * the same TrxID if two people submit it at the same moment).
 * Returns the transaction data if successfully claimed, or throws a descriptive error.
 */
async function claimTransaction(trxId, telegramId) {
  const ref = txCol.doc(String(trxId).trim().toUpperCase());
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('NOT_FOUND');
    const data = snap.data();
    if (data.used) throw new Error('ALREADY_USED');
    tx.update(ref, {
      used: true,
      usedBy: telegramId,
      usedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return data;
  });
}

module.exports = {
  saveIncomingTransaction,
  getTransaction,
  claimTransaction,
  createManualDepositRequest,
  getManualDepositRequest,
  resolveManualDepositRequest,
};

/**
 * manualDeposits/{trxId}
 * ------------------------------------------------------------
 * Fallback path for when the SMS webhook never received the payment SMS
 * (e.g. the admin's phone had no internet at that moment) - so
 * getTransaction(trxId) comes back empty even though the user genuinely
 * paid. Instead of just telling the user "not found", the bot creates one
 * of these and asks the admin directly via a Yes/No message (see
 * admin.js's mdep_yes/mdep_no handlers). trxId is the doc id so a user
 * can't spam multiple manual requests for the same TrxID.
 *
 *   trxId          string
 *   telegramId     number
 *   claimedAmount  number    what the USER typed as the amount - never
 *                             independently confirmed by SMS, so the
 *                             admin is trusting their own judgement
 *                             (e.g. checking their own bKash app) when
 *                             approving, not the bot verifying anything
 *   method         string
 *   status         string    'pending' | 'approved' | 'rejected'
 *   createdAt      Timestamp
 *   resolvedAt     Timestamp|null
 */
const manualDepositsCol = db.collection('manualDeposits');

/** Creates a pending manual request, or returns the existing one if this TrxID was already submitted (no duplicates). */
async function createManualDepositRequest({ trxId, telegramId, claimedAmount, method }) {
  const id = String(trxId).trim().toUpperCase();
  const ref = manualDepositsCol.doc(id);
  const existing = await ref.get();
  if (existing.exists) return { id: ref.id, ...existing.data(), duplicate: true };

  const data = {
    trxId: id,
    telegramId,
    claimedAmount: Number(claimedAmount),
    method,
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    resolvedAt: null,
  };
  await ref.set(data);
  return { id: ref.id, ...data, duplicate: false };
}

async function getManualDepositRequest(trxId) {
  const snap = await manualDepositsCol.doc(String(trxId).trim().toUpperCase()).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

/**
 * Atomically resolves a pending manual request (approve or reject) -
 * throws if it's already been resolved, so a double-tap on the admin's
 * Yes/No buttons can't credit the balance twice. On approval, also writes
 * a matching `transactions/{trxId}` doc marked used=true so that if the
 * real SMS shows up later (admin's connection recovers), the normal
 * auto-verify path sees it's already claimed and won't double-credit.
 */
async function resolveManualDepositRequest(trxId, approve, resolvedByAdminId) {
  const id = String(trxId).trim().toUpperCase();
  const ref = manualDepositsCol.doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('NOT_FOUND');
    const data = snap.data();
    if (data.status !== 'pending') throw new Error('ALREADY_RESOLVED');

    tx.update(ref, {
      status: approve ? 'approved' : 'rejected',
      resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
      resolvedBy: resolvedByAdminId,
    });

    if (approve) {
      const txRef = txCol.doc(id);
      const txSnap = await tx.get(txRef);
      if (!txSnap.exists) {
        tx.set(txRef, {
          trxId: id,
          amount: data.claimedAmount,
          method: data.method,
          sender: null,
          rawSms: null,
          used: true,
          usedBy: data.telegramId,
          manual: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          usedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    return data;
  });
}
