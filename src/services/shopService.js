/**
 * shopService.js
 * ------------------------------------------------------------
 * Firestore structure:
 *
 * services/{serviceId}
 *   name        string   e.g. "Netflix"
 *   emoji       string   e.g. "🎬"
 *   description string|null   shown to buyers before they pick a plan
 *   active      boolean
 *   createdAt   Timestamp
 *
 * services/{serviceId}/plans/{planId}
 *   title       string   e.g. "30 Days"
 *   price       number   e.g. 65
 *   description string|null   shown to buyers on the order-confirm screen
 *   stockCount  number   (cached count, kept in sync with stock array length)
 *   active      boolean
 *
 * services/{serviceId}/plans/{planId}/stock/{stockId}
 *   credential  string   e.g. "email:password"
 *   addedAt     Timestamp
 *
 * orders/{orderId}
 *   userId, serviceId, planId, serviceName, planTitle, price, credential, createdAt
 * ------------------------------------------------------------
 */

const { db, admin } = require('../config/firebase');

const servicesCol = db.collection('services');

/** All active services (for the Shop menu). */
async function getActiveServices() {
  const snap = await servicesCol.where('active', '==', true).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** All services, active or not (for admin panel). */
async function getAllServices() {
  const snap = await servicesCol.orderBy('name').get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function getService(serviceId) {
  const snap = await servicesCol.doc(serviceId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function createService(name, emoji = '📦') {
  const ref = await servicesCol.add({
    name,
    emoji,
    description: null,
    active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

/** Set/replace the buyer-facing description shown before picking a plan. */
async function setServiceDescription(serviceId, description) {
  await servicesCol.doc(serviceId).update({ description: description || null });
}

async function deleteService(serviceId) {
  // Delete plans + their stock first (Firestore doesn't cascade-delete subcollections).
  const plansSnap = await servicesCol.doc(serviceId).collection('plans').get();
  for (const planDoc of plansSnap.docs) {
    const stockSnap = await planDoc.ref.collection('stock').get();
    const batch = db.batch();
    stockSnap.docs.forEach((s) => batch.delete(s.ref));
    batch.delete(planDoc.ref);
    await batch.commit();
  }
  await servicesCol.doc(serviceId).delete();
}

async function setServiceActive(serviceId, active) {
  await servicesCol.doc(serviceId).update({ active });
}

/** Active plans for a service, with live stock counts. */
async function getActivePlans(serviceId) {
  const snap = await servicesCol.doc(serviceId).collection('plans').where('active', '==', true).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function getAllPlans(serviceId) {
  const snap = await servicesCol.doc(serviceId).collection('plans').get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function getPlan(serviceId, planId) {
  const snap = await servicesCol.doc(serviceId).collection('plans').doc(planId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function createPlan(serviceId, title, price) {
  const ref = await servicesCol.doc(serviceId).collection('plans').add({
    title,
    price: Number(price),
    description: null,
    stockCount: 0,
    active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

/** Set/replace the buyer-facing description shown on the order-confirm screen. */
async function setPlanDescription(serviceId, planId, description) {
  await servicesCol.doc(serviceId).collection('plans').doc(planId).update({ description: description || null });
}

async function deletePlan(serviceId, planId) {
  const stockSnap = await servicesCol.doc(serviceId).collection('plans').doc(planId).collection('stock').get();
  const batch = db.batch();
  stockSnap.docs.forEach((s) => batch.delete(s.ref));
  batch.delete(servicesCol.doc(serviceId).collection('plans').doc(planId));
  await batch.commit();
}

/**
 * Add MANY credentials to a plan's stock - one line = one separate item
 * that will be delivered (and removed from stock) individually to each
 * buyer. Good for simple "email:pass" style stock.
 */
async function addStockBulk(serviceId, planId, credentialsText) {
  const lines = credentialsText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return 0;

  const stockCol = servicesCol.doc(serviceId).collection('plans').doc(planId).collection('stock');
  const batch = db.batch();
  lines.forEach((credential) => {
    const ref = stockCol.doc();
    batch.set(ref, { credential, addedAt: admin.firestore.FieldValue.serverTimestamp() });
  });
  batch.update(servicesCol.doc(serviceId).collection('plans').doc(planId), {
    stockCount: admin.firestore.FieldValue.increment(lines.length),
  });
  await batch.commit();
  return lines.length;
}

/**
 * Add exactly ONE credential/item to a plan's stock, preserving the full
 * text as-is (including any line breaks). Use this for items that aren't
 * a simple "email:pass" line - e.g. a profile name + PIN on separate
 * lines, or a Gemini activation link with extra instructions. The whole
 * block is delivered and removed from stock together as a single unit.
 */
async function addStockSingle(serviceId, planId, credentialText) {
  const text = credentialText.trim();
  if (!text) return 0;

  const planRef = servicesCol.doc(serviceId).collection('plans').doc(planId);
  const stockCol = planRef.collection('stock');
  const ref = stockCol.doc();
  await db.runTransaction(async (tx) => {
    tx.set(ref, { credential: text, addedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(planRef, { stockCount: admin.firestore.FieldValue.increment(1) });
  });
  return 1;
}

/**
 * Atomically pop ONE credential off a plan's stock (transaction-safe so two
 * simultaneous buyers can never receive the same credential).
 * Returns the credential string, or null if out of stock.
 */
async function popStock(serviceId, planId) {
  const planRef = servicesCol.doc(serviceId).collection('plans').doc(planId);
  const stockCol = planRef.collection('stock');

  return db.runTransaction(async (tx) => {
    const oneSnap = await tx.get(stockCol.limit(1));
    if (oneSnap.empty) return null;
    const stockDoc = oneSnap.docs[0];
    const credential = stockDoc.data().credential;
    tx.delete(stockDoc.ref);
    tx.update(planRef, { stockCount: admin.firestore.FieldValue.increment(-1) });
    return credential;
  });
}

/** Record a completed order for history / admin auditing. */
async function recordOrder({ userId, serviceId, planId, serviceName, planTitle, price, credential }) {
  await db.collection('orders').add({
    userId,
    serviceId,
    planId,
    serviceName,
    planTitle,
    price,
    credential,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

module.exports = {
  getActiveServices,
  getAllServices,
  getService,
  createService,
  setServiceDescription,
  deleteService,
  setServiceActive,
  getActivePlans,
  getAllPlans,
  getPlan,
  createPlan,
  setPlanDescription,
  deletePlan,
  addStockBulk,
  addStockSingle,
  popStock,
  recordOrder,
  getSalesStats,
  getRecentOrders,
};

/**
 * Paginated order history for the admin "📦 Recent Orders" view (who
 * bought what, when, for how much). Cursor-based (not offset-based) so
 * paging deep into history stays cheap - Firestore's startAfter() jumps
 * straight to the right spot instead of re-scanning every prior page.
 * Pass the `createdAt` millis of the last order on the current page as
 * `beforeMillis` to fetch the next page.
 */
async function getRecentOrders(limit = 10, beforeMillis = null) {
  let query = db.collection('orders').orderBy('createdAt', 'desc').limit(limit);
  if (beforeMillis) {
    query = query.startAfter(admin.firestore.Timestamp.fromMillis(beforeMillis));
  }
  const snap = await query.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Cheap sales overview for the /status admin command.
 * Order count comes from Firestore's server-side count() aggregation (one
 * small billed read regardless of collection size). Revenue is summed
 * in-memory since it's just the `price` field on each order doc - fine for
 * a single shop's order history (no pagination needed at this scale; if
 * orders ever grow into the tens of thousands this should switch to a
 * running total maintained on write instead).
 */
async function getSalesStats() {
  const ordersCol = db.collection('orders');
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const [totalCountSnap, todaySnap, allOrdersSnap] = await Promise.all([
    ordersCol.count().get(),
    ordersCol.where('createdAt', '>=', startOfDay).count().get(),
    ordersCol.select('price').get(),
  ]);

  const totalRevenue = allOrdersSnap.docs.reduce((sum, d) => sum + (Number(d.data().price) || 0), 0);

  return {
    totalOrders: totalCountSnap.data().count,
    ordersToday: todaySnap.data().count,
    totalRevenue,
  };
}
