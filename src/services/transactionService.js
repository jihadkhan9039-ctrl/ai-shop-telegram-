/**
 * transactionService.js
 * ------------------------------------------------------------
 * transactions/{trxId}
 *   trxId       string   (bKash/Nagad transaction id, used as doc id -> natural uniqueness)
 *   amount      number
 *   method      string   "bKash" | "Nagad" | "unknown"
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
async function saveIncomingTransaction({ trxId, amount, method, rawSms }) {
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

module.exports = { saveIncomingTransaction, getTransaction, claimTransaction };
