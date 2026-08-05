/**
 * admin.js
 * ------------------------------------------------------------
 * /adminpanel - restricted to ADMIN_ID (see isAdmin() in helpers.js).
 *
 * Implements a lightweight state machine via ctx.session.adminState
 * (in-memory session, registered in bot.js) so the admin can complete
 * multi-step flows (e.g. "send service name" -> "send emoji") by simply
 * replying with plain text, without needing a database-backed FSM.
 *
 * Menu:
 *   ➕ Add Service            🗂 Manage Services (edit/delete/add plan/add stock)
 *   💰 Manage User Balance    🚫 Ban / Unban User
 *   📢 Broadcast
 * ------------------------------------------------------------
 */

const { Markup } = require('telegraf');
const shopService = require('../../services/shopService');
const userService = require('../../services/userService');
const { taka, isAdmin } = require('../../utils/helpers');

// ---------- keyboards ----------

const adminMenu = Markup.inlineKeyboard([
  [Markup.button.callback('➕ Add Service', 'adm_add_service')],
  [Markup.button.callback('🗂 Manage Services & Plans', 'adm_services')],
  [Markup.button.callback('💰 Manage User Balance', 'adm_balance')],
  [Markup.button.callback('🚫 Ban / Unban User', 'adm_ban')],
  [Markup.button.callback('📢 Broadcast Message', 'adm_broadcast')],
]);

function backToMenuRow() {
  return [Markup.button.callback('⬅️ Admin Menu', 'adm_menu')];
}

// ---------- guard ----------

function adminOnly(handler) {
  return async (ctx, next) => {
    if (!isAdmin(ctx.from.id)) return; // silently ignore non-admins
    return handler(ctx, next);
  };
}

// ---------- registration ----------

function registerAdminHandler(bot) {
  bot.command('adminpanel', adminOnly(async (ctx) => {
    ctx.session.adminState = null; // reset any half-finished flow
    await ctx.reply('🛠 *Admin Panel*', { parse_mode: 'Markdown', ...adminMenu });
  }));

  bot.action('adm_menu', adminOnly(async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.adminState = null;
    await ctx.editMessageText('🛠 *Admin Panel*', { parse_mode: 'Markdown', ...adminMenu });
  }));

  // ---------------- Add Service ----------------
  bot.action('adm_add_service', adminOnly(async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.adminState = { step: 'add_service' };
    await ctx.editMessageText(
      '➕ *Add Service*\n\nSend the service name. Optionally add an emoji separated by `|`.\n' +
        'Example: `Netflix | 🎬`',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([backToMenuRow()]) }
    );
  }));

  // ---------------- Manage Services & Plans ----------------
  bot.action('adm_services', adminOnly(async (ctx) => {
    await ctx.answerCbQuery();
    await showServiceList(ctx);
  }));

  async function showServiceList(ctx) {
    const services = await shopService.getAllServices();
    if (services.length === 0) {
      return ctx.editMessageText('No services yet.', {
        ...Markup.inlineKeyboard([backToMenuRow()]),
      });
    }
    const rows = services.map((s) => [
      Markup.button.callback(
        `${s.active ? '🟢' : '🔴'} ${s.emoji || '📦'} ${s.name}`,
        `adm_svc_${s.id}`
      ),
    ]);
    rows.push(backToMenuRow());
    await ctx.editMessageText('🗂 *Services*\n\nSelect one to manage:', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(rows),
    });
  }

  bot.action(/^adm_svc_(.+)$/, adminOnly(async (ctx) => {
    await ctx.answerCbQuery();
    await showServiceDetail(ctx, ctx.match[1]);
  }));

  async function showServiceDetail(ctx, serviceId) {
    const [service, plans] = await Promise.all([
      shopService.getService(serviceId),
      shopService.getAllPlans(serviceId),
    ]);
    if (!service) return showServiceList(ctx);

    const planRows = plans.map((p) => [
      Markup.button.callback(
        `${p.active ? '🟢' : '🔴'} ${p.title} - ${taka(p.price)} (${p.stockCount ?? 0} left)`,
        `adm_plan_${serviceId}_${p.id}`
      ),
    ]);

    const rows = [
      ...planRows,
      [Markup.button.callback('➕ Add Plan', `adm_addplan_${serviceId}`)],
      [Markup.button.callback(service.active ? '🔴 Deactivate Service' : '🟢 Activate Service', `adm_toggle_${serviceId}`)],
      [Markup.button.callback('🗑 Delete Service', `adm_delsvc_${serviceId}`)],
      [Markup.button.callback('⬅️ Back to Services', 'adm_services')],
      backToMenuRow(),
    ];

    await ctx.editMessageText(`${service.emoji || '📦'} *${service.name}*\n\nPlans:`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(rows),
    });
  }

  bot.action(/^adm_toggle_(.+)$/, adminOnly(async (ctx) => {
    const serviceId = ctx.match[1];
    const service = await shopService.getService(serviceId);
    if (service) await shopService.setServiceActive(serviceId, !service.active);
    await ctx.answerCbQuery('Updated.');
    await showServiceDetail(ctx, serviceId);
  }));

  bot.action(/^adm_delsvc_(.+)$/, adminOnly(async (ctx) => {
    await ctx.answerCbQuery();
    const serviceId = ctx.match[1];
    await ctx.editMessageText('⚠️ Delete this service and ALL its plans/stock? This cannot be undone.', {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, Delete', `adm_delsvcok_${serviceId}`)],
        [Markup.button.callback('❌ Cancel', `adm_svc_${serviceId}`)],
      ]),
    });
  }));

  bot.action(/^adm_delsvcok_(.+)$/, adminOnly(async (ctx) => {
    await shopService.deleteService(ctx.match[1]);
    await ctx.answerCbQuery('Service deleted.');
    await showServiceList(ctx);
  }));

  bot.action(/^adm_addplan_(.+)$/, adminOnly(async (ctx) => {
    await ctx.answerCbQuery();
    const serviceId = ctx.match[1];
    ctx.session.adminState = { step: 'add_plan', serviceId };
    await ctx.editMessageText(
      '➕ *Add Plan*\n\nSend in the format: `Title | Price`\nExample: `30 Days | 65`',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Cancel', `adm_svc_${serviceId}`)]]) }
    );
  }));

  bot.action(/^adm_plan_(.+)_(.+)$/, adminOnly(async (ctx) => {
    await ctx.answerCbQuery();
    const [, serviceId, planId] = ctx.match;
    const plan = await shopService.getPlan(serviceId, planId);
    if (!plan) return showServiceDetail(ctx, serviceId);
    await ctx.editMessageText(
      `📦 *${plan.title}* - ${taka(plan.price)}\nStock: ${plan.stockCount ?? 0}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('➕ Add Stock', `adm_addstock_${serviceId}_${planId}`)],
          [Markup.button.callback('🗑 Delete Plan', `adm_delplan_${serviceId}_${planId}`)],
          [Markup.button.callback('⬅️ Back', `adm_svc_${serviceId}`)],
        ]),
      }
    );
  }));

  bot.action(/^adm_delplan_(.+)_(.+)$/, adminOnly(async (ctx) => {
    const [, serviceId, planId] = ctx.match;
    await shopService.deletePlan(serviceId, planId);
    await ctx.answerCbQuery('Plan deleted.');
    await showServiceDetail(ctx, serviceId);
  }));

  bot.action(/^adm_addstock_(.+)_(.+)$/, adminOnly(async (ctx) => {
    await ctx.answerCbQuery();
    const [, serviceId, planId] = ctx.match;
    ctx.session.adminState = { step: 'add_stock', serviceId, planId };
    await ctx.editMessageText(
      '➕ *Add Stock*\n\nSend one credential per line (bulk supported).\nExample:\n`user1@mail.com:pass1`\n`user2@mail.com:pass2`',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Cancel', `adm_plan_${serviceId}_${planId}`)]]) }
    );
  }));

  // ---------------- Manage Balance ----------------
  bot.action('adm_balance', adminOnly(async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.adminState = { step: 'balance' };
    await ctx.editMessageText(
      '💰 *Manage Balance*\n\nSend: `<UserID> <add|deduct> <amount>`\nExample: `123456789 add 50`',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([backToMenuRow()]) }
    );
  }));

  // ---------------- Ban / Unban ----------------
  bot.action('adm_ban', adminOnly(async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.adminState = { step: 'ban' };
    await ctx.editMessageText(
      '🚫 *Ban / Unban User*\n\nSend: `<UserID> <ban|unban>`\nExample: `123456789 ban`',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([backToMenuRow()]) }
    );
  }));

  // ---------------- Broadcast ----------------
  bot.action('adm_broadcast', adminOnly(async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.adminState = { step: 'broadcast' };
    await ctx.editMessageText(
      '📢 *Broadcast*\n\nSend the message (text, photo, etc.) you want to broadcast to ALL users.',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([backToMenuRow()]) }
    );
  }));

  // ---------------- Text input router for multi-step flows ----------------
  // Registered as a generic "message" listener so it also catches non-text
  // broadcasts (photos, videos, documents...). Falls through via next() for
  // anyone who isn't admin or has no pending admin step.
  bot.on('message', async (ctx, next) => {
    if (!isAdmin(ctx.from.id) || !ctx.session.adminState) return next();

    const state = ctx.session.adminState;

    switch (state.step) {
      case 'add_service': {
        const text = ctx.message.text || '';
        const [name, emoji] = text.split('|').map((s) => s && s.trim());
        if (!name) return ctx.reply('❌ Please send a valid service name.');
        await shopService.createService(name, emoji || '📦');
        ctx.session.adminState = null;
        await ctx.reply(`✅ Service "${name}" created.`, adminMenu);
        break;
      }

      case 'add_plan': {
        const text = ctx.message.text || '';
        const [title, priceStr] = text.split('|').map((s) => s && s.trim());
        const price = Number(priceStr);
        if (!title || !Number.isFinite(price) || price <= 0) {
          return ctx.reply('❌ Invalid format. Send: `Title | Price`', { parse_mode: 'Markdown' });
        }
        await shopService.createPlan(state.serviceId, title, price);
        ctx.session.adminState = null;
        await ctx.reply(`✅ Plan "${title}" added at ${taka(price)}.`, adminMenu);
        break;
      }

      case 'add_stock': {
        const text = ctx.message.text || '';
        const count = await shopService.addStock(state.serviceId, state.planId, text);
        ctx.session.adminState = null;
        await ctx.reply(`✅ Added ${count} credential(s) to stock.`, adminMenu);
        break;
      }

      case 'balance': {
        const text = (ctx.message.text || '').trim();
        const [userId, action, amountStr] = text.split(/\s+/);
        const amount = Number(amountStr);
        if (!userId || !['add', 'deduct'].includes(action) || !Number.isFinite(amount) || amount <= 0) {
          return ctx.reply('❌ Invalid format. Send: `<UserID> <add|deduct> <amount>`', { parse_mode: 'Markdown' });
        }
        const user = await userService.getUser(userId);
        if (!user) return ctx.reply('❌ No such user found.');
        const delta = action === 'add' ? amount : -amount;
        await userService.adjustBalance(userId, delta);
        ctx.session.adminState = null;
        await ctx.reply(`✅ ${action === 'add' ? 'Added' : 'Deducted'} ${taka(amount)} ${action === 'add' ? 'to' : 'from'} user ${userId}.`, adminMenu);
        try {
          await ctx.telegram.sendMessage(
            userId,
            action === 'add'
              ? `💰 Your balance was credited with ${taka(amount)} by the admin.`
              : `⚠️ ${taka(amount)} was deducted from your balance by the admin.`
          );
        } catch { /* user may have blocked the bot */ }
        break;
      }

      case 'ban': {
        const text = (ctx.message.text || '').trim();
        const [userId, action] = text.split(/\s+/);
        if (!userId || !['ban', 'unban'].includes(action)) {
          return ctx.reply('❌ Invalid format. Send: `<UserID> <ban|unban>`', { parse_mode: 'Markdown' });
        }
        const user = await userService.getUser(userId);
        if (!user) return ctx.reply('❌ No such user found.');
        await userService.setBanned(userId, action === 'ban');
        ctx.session.adminState = null;
        await ctx.reply(`✅ User ${userId} ${action === 'ban' ? 'banned' : 'unbanned'}.`, adminMenu);
        break;
      }

      case 'broadcast': {
        ctx.session.adminState = null;
        await ctx.reply('📢 Broadcasting... this may take a while for large user bases.');
        let sent = 0;
        let failed = 0;
        for await (const user of userService.iterateAllUsers()) {
          try {
            await ctx.telegram.copyMessage(user.telegramId, ctx.chat.id, ctx.message.message_id);
            sent += 1;
          } catch {
            failed += 1;
          }
          // Gentle throttle to respect Telegram's ~30 msg/sec limit.
          await new Promise((r) => setTimeout(r, 40));
        }
        await ctx.reply(`✅ Broadcast complete. Sent: ${sent}, Failed: ${failed}.`, adminMenu);
        break;
      }

      default:
        return next();
    }
  });
}

module.exports = { registerAdminHandler };
