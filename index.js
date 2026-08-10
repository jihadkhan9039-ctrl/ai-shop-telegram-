/**
 * index.js - Application entry point
 * ------------------------------------------------------------
 * 1. Loads environment variables
 * 2. Starts the Express server (hosts the SMS webhook route)
 * 3. Launches the Telegraf bot (long polling)
 * 4. Schedules the hourly referral-bonus cron job
 * ------------------------------------------------------------
 */

require('dotenv').config();

const express = require('express');
const { createBot } = require('./src/bot/bot');
const smsWebhookRouter = require('./src/webhook/smsWebhook');
const { startReferralCron } = require('./src/jobs/referralCron');

// ---- sanity-check required env vars early, with a clear error message ----
const REQUIRED_ENV = [
  'BOT_TOKEN', 'ADMIN_ID', 'ADMIN_USERNAME', 'BOT_USERNAME',
  'CHANNEL_1', 'CHANNEL_2', 'CHANNEL_3', 'CHANNEL_4',
  'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY',
  'SMS_WEBHOOK_SECRET',
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
  console.error('   Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

/**
 * Telegram only allows ONE active long-polling connection per bot token.
 * During a Render deploy, the OLD instance can briefly overlap with the
 * NEW one starting up, causing a transient "409 Conflict: terminated by
 * other getUpdates request" error. Instead of crashing the whole process
 * (which can cascade into a crash-loop), retry with backoff so the new
 * instance calmly waits its turn once the old one fully shuts down.
 */
async function launchBotWithRetry(bot, attempt = 1) {
  const MAX_ATTEMPTS = 8;
  const DELAY_MS = 5000;
  try {
    await bot.launch();
    console.log('🤖 Telegram bot launched (long polling).');
  } catch (err) {
    const isConflict = err && err.response && err.response.error_code === 409;
    if (isConflict && attempt < MAX_ATTEMPTS) {
      console.warn(
        `⚠️ Telegram 409 Conflict (another instance still shutting down?). ` +
          `Retry ${attempt}/${MAX_ATTEMPTS} in ${DELAY_MS / 1000}s...`
      );
      await new Promise((r) => setTimeout(r, DELAY_MS));
      return launchBotWithRetry(bot, attempt + 1);
    }
    throw err; // not a conflict, or we've retried enough - surface the real error
  }
}

async function main() {
  // ---- Express server (SMS webhook + health check) ----
  const app = express();
  app.get('/', (_req, res) => res.send('Telegram Shop Bot is running.'));
  app.use('/api', smsWebhookRouter);

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`🌐 Express server listening on port ${port}`));

  // ---- Keep-alive self-ping (Render free tier spins the service down
  // after ~15 min with no incoming HTTP requests, causing a 30-60s cold
  // start on the next request. Telegram long-polling is OUTBOUND traffic
  // and does NOT count, so without this the bot itself won't keep the
  // Express server awake - the very next SMS webhook hit after a quiet
  // spell would then time out on the SMS-forwarder app's side and show
  // as "Failed", even though the SMS was actually valid and would have
  // been saved fine once the cold start finished. Pinging our own health
  // check route every 10 minutes prevents the spin-down entirely. Only
  // useful once the service already has a public URL, i.e. on Render -
  // harmless no-op locally since RENDER_EXTERNAL_URL won't be set. ----
  const selfUrl = process.env.RENDER_EXTERNAL_URL;
  if (selfUrl) {
    setInterval(() => {
      require('https')
        .get(selfUrl, (res) => res.resume())
        .on('error', (err) => console.warn('[keep-alive] self-ping failed:', err.message));
    }, 10 * 60 * 1000);
    console.log(`💓 Keep-alive self-ping enabled for ${selfUrl} (every 10 min).`);
  }

  // ---- Telegram bot ----
  const bot = createBot();
  await launchBotWithRetry(bot);

  // ---- Referral bonus cron job ----
  startReferralCron(bot);

  // ---- Graceful shutdown ----
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch((err) => {
  console.error('❌ Fatal startup error:', err);
  process.exit(1);
});
