/**
 * firebase.js
 * ------------------------------------------------------------
 * Initializes the Firebase Admin SDK and exports a ready-to-use
 * Firestore database instance (`db`) that every other module
 * imports. Also exports `admin` (for FieldValue, Timestamp, etc.)
 * ------------------------------------------------------------
 */

const admin = require('firebase-admin');

// The private key comes from .env with literal "\n" sequences
// (because .env files can't hold real newlines). We convert them
// back into real newlines before passing to the SDK.
const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
  });
}

const db = admin.firestore();

// Firestore settings: ignore undefined properties instead of throwing,
// which is handy when we conditionally build update objects.
db.settings({ ignoreUndefinedProperties: true });

module.exports = { admin, db };
