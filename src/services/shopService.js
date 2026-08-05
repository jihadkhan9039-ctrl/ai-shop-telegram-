/**
 * shopService.js
 * ------------------------------------------------------------
 * Firestore structure:
 *
 * services/{serviceId}
 *   name        string   e.g. "Netflix"
 *   emoji       string   e.g. "🎬"
 *   active      boolean
 *   createdAt   Timestamp
 *
 * services/{serviceId}/plans/{planId}
 *   title       string   e.g. "30 Days"
 *   price       number   e.g. 65
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
    active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
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
    stockCount: 0,
    active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

async function deletePlan(serviceId, planId) {
  const stockSnap = await servicesCol.doc(serviceId).collection('plans').doc(planId).collection('stock').get();
  const batch = db.batch();
  stockSnap.docs.forEach((s) => batch.delete(s.ref));
  batch.delete(servicesCol.doc(serviceId).collection('plans').doc(planId));
  await batch.commit();
}

/** Add one or many credential strings to a plan's stock (bulk = newline separated). */
async function addStock(serviceId, planId, credentialsText) {
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
  deleteService,
  setServiceActive,
  getActivePlans,
  getAllPlans,
  getPlan,
  createPlan,
  deletePlan,
  addStock,
  popStock,
  recordOrder,
};
