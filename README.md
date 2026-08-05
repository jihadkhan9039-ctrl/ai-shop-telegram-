# Telegram Paid Subscription & Digital Asset Selling Bot

Node.js + Telegraf + Firebase Firestore. Force-join gate, referral system with
24h holding rule, bKash/Nagad SMS-webhook auto-payments, dynamic shop with
stock delivery, and a full admin panel.

## 1. Project structure
```
index.js                       # entry point (Express + bot + cron)
src/config/firebase.js         # Firestore init
src/utils/helpers.js           # shared helpers
src/services/                  # Firestore data layer (users/shop/tx/referrals)
src/bot/bot.js                 # Telegraf bootstrap
src/bot/middlewares/forceJoin.js
src/bot/keyboards/keyboards.js
src/bot/handlers/{start,support,referral,balance,shop,admin}.js
src/jobs/referralCron.js       # hourly bonus payout job
src/webhook/smsWebhook.js      # POST /api/sms-webhook
```

## 2. Firebase Firestore setup
1. Go to https://console.firebase.google.com → Create a project.
2. Build → Firestore Database → Create database (Production mode, pick a region close to your VPS).
3. Project Settings (gear icon) → Service Accounts → **Generate new private key**. This downloads a JSON file.
4. From that JSON, copy into your `.env`:
   - `project_id` → `FIREBASE_PROJECT_ID`
   - `client_email` → `FIREBASE_CLIENT_EMAIL`
   - `private_key` → `FIREBASE_PRIVATE_KEY` (keep it wrapped in quotes, keep the `\n` sequences as-is)
5. No manual collection creation needed — all collections (`users`, `services`, `transactions`, `referrals`, `orders`) and subcollections (`plans`, `stock`) are created automatically the first time data is written.
6. Firestore Rules: since all access goes through the Admin SDK (server-side, using the service account, which bypasses security rules), you can leave default rules as **deny all** for client access:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} { allow read, write: if false; }
     }
   }
   ```

## 3. Telegram setup
1. Create the bot with **@BotFather** → `/newbot` → copy the token into `BOT_TOKEN`.
2. Get your numeric Telegram ID from **@userinfobot** → put it in `ADMIN_ID`.
3. Create/choose your 4 force-join channels. Add the bot as an **admin** in each (required for `getChatMember`).
4. Fill `CHANNEL_1..4` (use `-100xxxxxxxxxx` for private channels, `@username` for public) and `CHANNEL_1_LINK..4_LINK` with their invite links.
5. Set `BOT_USERNAME` (no `@`) — used to build referral links.

## 4. Local install
```bash
git clone <your-repo-or-copy-files>
cd telegram-shop-bot
cp .env.example .env
nano .env        # fill in all values
npm install
npm start
```

## 5. SMS Webhook (bKash/Nagad auto-payment)
1. On the Android phone that receives bKash/Nagad SMS, install an "SMS Forwarder" app (e.g. **SMS Forwarder** by Julien Boulay, or **Macrodroid**) capable of forwarding incoming SMS as an HTTP POST/webhook.
2. Configure it to POST to: `http://YOUR_VPS_IP:3000/api/sms-webhook`
3. Add a custom header: `x-webhook-secret: <same value as SMS_WEBHOOK_SECRET in .env>`
4. Body should be JSON containing the SMS text in a field named `message` (or `text`/`sms`/`body` — the webhook checks all of these). Example:
   ```json
   { "message": "You have received Tk 500.00 from 017XXXXXXXX. TrxID 9AK3XXXXXX at 24/07/2026 21:14" }
   ```
5. Put the VPS behind HTTPS (e.g. Nginx + Let's Encrypt / Caddy) in production so the secret header isn't sent in plaintext over the internet.
6. Test manually:
   ```bash
   curl -X POST http://localhost:3000/api/sms-webhook \
     -H "Content-Type: application/json" \
     -H "x-webhook-secret: your-secret" \
     -d '{"message":"You have received Tk 100.00 from 017XXXXXXXX. TrxID TEST12345"}'
   ```

## 6. Deploy on Ubuntu VPS (Oracle Cloud) with PM2
```bash
# 1. Install Node.js 18+ (via nvm, recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 18
node -v

# 2. Upload your project (scp/git clone) then:
cd telegram-shop-bot
cp .env.example .env
nano .env                  # fill in real values
npm install --production

# 3. Install PM2 globally
npm install -g pm2

# 4. Start the app under PM2
pm2 start index.js --name telegram-shop-bot

# 5. Make it survive reboots
pm2 startup            # run the command it prints
pm2 save

# Useful PM2 commands
pm2 logs telegram-shop-bot     # tail logs
pm2 restart telegram-shop-bot  # restart after code changes / .env edits
pm2 stop telegram-shop-bot
pm2 status
```

**Oracle Cloud firewall:** open port `3000` (or whatever `PORT` you set) in the
VM's Security List / Network Security Group AND in the OS firewall
(`sudo ufw allow 3000/tcp`) so the SMS-forwarder app can reach the webhook.
Strongly recommended: put Nginx in front with HTTPS instead of exposing
port 3000 directly.

## 7. Using the bot
- **Users:** `/start` → join the 4 channels → tap "Check Again" → use the
  Shop / Refer & Earn / Balance / Support menu.
- **Admin:** `/adminpanel` (only works for `ADMIN_ID`) →
  Add Service → Add Plan → Add Stock → done, it's purchasable.
  Balance/ban management and broadcast are also in this menu.

## 8. Notes & customization
- `BKASH_NUMBER` / `NAGAD_NUMBER` env vars (optional) control the numbers shown
  to users on the "Add Fund" screen — add them to `.env` if you want to
  override the defaults in `src/bot/handlers/balance.js`.
- The SMS regex in `src/webhook/smsWebhook.js` covers common bKash/Nagad
  wording; check your actual SMS text and tweak the regex if parsing fails.
- Session state (used for admin multi-step flows & "submit TrxID") is
  in-memory — it resets on `pm2 restart`. Fine for this use case since flows
  are short-lived.
