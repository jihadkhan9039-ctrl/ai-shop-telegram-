/**
 * smsWebhook.js
 * ------------------------------------------------------------
 * Express router exposing POST /api/sms-webhook
 *
 * Configure your Android "SMS Forwarder" app to POST each incoming
 * SMS (as JSON) to: https://yourdomain-or-ip:PORT/api/sms-webhook
 * with header:  x-webhook-secret: <SMS_WEBHOOK_SECRET>
 *
 * Expected JSON body (adjust field names to match your forwarder app):
 *   { "from": "bKash", "message": "You have received Tk 500.00 from...
 *              TrxID ABC1DEFG23 ...", "sentStamp": "..." }
 *
 * The route is intentionally tolerant of different forwarder payload
 * shapes - it just needs SOME field containing the raw SMS text.
 * ------------------------------------------------------------
 */

const express = require('express');
const { saveIncomingTransaction } = require('../services/transactionService');

const router = express.Router();

/**
 * bKash "Cash In"/received-money SMS typically looks like:
 *   "You have received Tk 500.00 from 01XXXXXXXXX. Fee Tk 0.00.
 *    Balance Tk 1,234.00. TrxID 9AK3XXXXXX at 24/07/2026 21:14"
 *
 * Nagad SMS typically looks like:
 *   "Money Received. Amount: Tk 500.00. TxnID: 9AK3XXXXXX...
 *    Available Balance: Tk 1,234.00"
 *
 * These regexes are deliberately flexible; tune them if your bank/
 * operator's exact wording differs.
 */
/**
 * bKash "Cash In"/received-money SMS typically looks like:
 *   "You have received Tk 500.00 from 01XXXXXXXXX. Fee Tk 0.00.
 *    Balance Tk 1,234.00. TrxID 9AK3XXXXXX at 24/07/2026 21:14"
 *
 * Nagad SMS typically looks like:
 *   "Money Received. Amount: Tk 500.00. TxnID: 9AK3XXXXXX...
 *    Available Balance: Tk 1,234.00"
 *
 * Bank SMS wording varies a LOT by bank (DBBL, BRAC, City, EBL, Islami
 * Bank, etc.) but almost always has an amount + some kind of reference
 * number, e.g.:
 *   "BDT 500.00 credited to A/C 123456789 on 24-JUL-26. Ref: FT26205XXXXX"
 *   "Your A/C XXXX1234 has been credited with Tk. 500.00. Ref No: 000123456789"
 *
 * The regexes below intentionally recognize many label variants
 * (TrxID/TxnID/Ref/Ref No/Reference/RRN/STAN) so bKash, Nagad, and most
 * bank alert SMS all parse correctly. If your specific bank's wording
 * still doesn't match, send a real (masked) sample SMS and the regex
 * can be tuned further.
 */
function parseSms(text) {
  if (!text) return null;

  let method = 'Bank';
  if (/bkash/i.test(text)) method = 'bKash';
  else if (/nagad/i.test(text)) method = 'Nagad';
  else if (/rocket/i.test(text)) method = 'Rocket';
  else if (/upay/i.test(text)) method = 'Upay';

  // Amount: "Tk 500.00", "BDT 500.00", "৳500", "Taka 500.00", "Amount: Tk. 500"
  const amountMatch = text.match(/(?:Tk|BDT|৳|Taka)\.?\s*:?\s*([\d,]+(?:\.\d{1,2})?)/i);

  // Reference / transaction id: covers bKash/Nagad's TrxID/TxnID AND
  // bank wording like "Ref:", "Ref No:", "Reference No.", "RRN", "STAN".
  const trxMatch = text.match(
    /\b(?:TrxID|TxnID|Transaction\s*ID|Ref(?:erence)?(?:\s*No\.?)?|RRN|STAN)\s*[:\-]?\s*([A-Za-z0-9]{5,})/i
  );

  if (!amountMatch || !trxMatch) return null;

  return {
    amount: parseFloat(amountMatch[1].replace(/,/g, '')),
    trxId: trxMatch[1].toUpperCase(),
    method,
  };
}

router.post('/sms-webhook', express.json(), async (req, res) => {
  // Log EVERY incoming hit unconditionally, before any auth/parsing logic,
  // so we can always tell from the Render logs whether a request from the
  // phone actually reached the server at all (vs failing at the network/
  // TLS layer before ever arriving here) - and if it did arrive, exactly
  // why it was rejected (bad secret vs unparseable SMS vs something else).
  console.log(
    `[sms-webhook] Incoming request - secret present: ${!!req.headers['x-webhook-secret']}, ` +
      `content-type: ${req.headers['content-type']}, body: ${JSON.stringify(req.body).slice(0, 300)}`
  );

  // Force a fresh TCP connection for every request instead of letting the
  // client reuse a pooled keep-alive one. Android's OkHttp/Volley (used by
  // most SMS-forwarder apps) pools connections client-side, but this
  // endpoint only gets hit sporadically (whenever an SMS arrives - could be
  // minutes or hours apart). If Render's proxy closes an idle backend
  // connection before the app's pool expires it, the app tries to reuse a
  // now-dead socket and gets NO response at all - which shows up on the
  // phone as "java.io.IOException: unexpected end of stream" / NoConnectionError,
  // even though the SMS itself was perfectly valid and nothing on our side
  // ever went wrong. Telling the client to close the connection after this
  // response guarantees the NEXT SMS always opens a brand-new connection.
  res.set('Connection', 'close');

  // --- Auth: shared-secret header ---
  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.SMS_WEBHOOK_SECRET) {
    console.warn(`[sms-webhook] Rejected - bad/missing secret. Got: "${secret || '(none)'}"`);
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  // Try a handful of common field names used by Android SMS-forwarder apps.
  const body = req.body || {};
  const rawSms = body.message || body.text || body.sms || body.body || '';

  const parsed = parseSms(rawSms);
  if (!parsed) {
    console.warn('[sms-webhook] Could not parse SMS:', rawSms);
    return res.status(400).json({ ok: false, error: 'Could not parse amount/TrxID from SMS' });
  }

  try {
    const result = await saveIncomingTransaction({
      trxId: parsed.trxId,
      amount: parsed.amount,
      method: parsed.method,
      rawSms,
    });
    console.log(`[sms-webhook] Saved transaction ${parsed.trxId} (${parsed.method}, ${parsed.amount})`);
    return res.json({ ok: true, duplicate: !!result.duplicate, trxId: parsed.trxId });
  } catch (err) {
    console.error('[sms-webhook] Failed to save transaction:', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

module.exports = router;
