/**
 * shop.js
 * ------------------------------------------------------------
 * Handles:
 *  - "🛒 Shop" reply button -> list active services
 *  - Selecting a service -> list its active plans (with live stock counts)
 *  - Selecting a plan -> confirm/cancel screen
 *  - Confirm -> checks balance, deducts, pops 1 credential from stock,
 *    delivers it, records the order.
 * ------------------------------------------------------------
 */

const shopService = require('../../services/shopService');
const { getUser, adjustBalance } = require('../../services/userService');
const { taka } = require('../../utils/helpers');
const {
  servicesKeyboard,
  plansKeyboard,
  confirmOrderKeyboard,
} = require('../keyboards/keyboards');

function registerShopHandler(bot) {
  bot.hears('🛒 Shop', async (ctx) => {
    const services = await shopService.getActiveServices();
    if (services.length === 0) {
      return ctx.reply('🛒 The shop is currently empty. Please check back later!');
    }
    await ctx.reply('🛒 *Shop*\n\nSelect a service:', {
      parse_mode: 'Markdown',
      ...servicesKeyboard(services),
    });
  });

  bot.action('shop_close', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
  });

  bot.action('shop_back', async (ctx) => {
    await ctx.answerCbQuery();
    const services = await shopService.getActiveServices();
    await ctx.editMessageText('🛒 *Shop*\n\nSelect a service:', {
      parse_mode: 'Markdown',
      ...servicesKeyboard(services),
    });
  });

  // Service selected -> show its plans
  bot.action(/^svc_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const serviceId = ctx.match[1];
    const [service, plans] = await Promise.all([
      shopService.getService(serviceId),
      shopService.getActivePlans(serviceId),
    ]);
    if (!service) return ctx.editMessageText('❌ This service no longer exists.');
    const descBlock = service.description ? `${service.description}\n\n` : '';
    if (plans.length === 0) {
      return ctx.editMessageText(`${service.emoji || '📦'} *${service.name}*\n\n${descBlock}No plans available right now.`, {
        parse_mode: 'Markdown',
        ...plansKeyboard(serviceId, []),
      });
    }
    await ctx.editMessageText(`${service.emoji || '📦'} *${service.name}*\n\n${descBlock}Select a plan:`, {
      parse_mode: 'Markdown',
      ...plansKeyboard(serviceId, plans),
    });
  });

  // Plan selected -> confirmation screen
  bot.action(/^plan_(.+)_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const [, serviceId, planId] = ctx.match;
    const [service, plan] = await Promise.all([
      shopService.getService(serviceId),
      shopService.getPlan(serviceId, planId),
    ]);
    if (!service || !plan) return ctx.editMessageText('❌ This item no longer exists.');

    const descBlock = plan.description ? `\n📝 ${plan.description}\n` : '';
    await ctx.editMessageText(
      `🧾 *Order Summary*\n\n` +
        `Service: ${service.emoji || '📦'} ${service.name}\n` +
        `Plan: ${plan.title}\n` +
        `Price: *${taka(plan.price)}*\n` +
        `In stock: ${plan.stockCount ?? 0}\n${descBlock}\n` +
        `Confirm your purchase?`,
      { parse_mode: 'Markdown', ...confirmOrderKeyboard(serviceId, planId) }
    );
  });

  // Confirmed purchase -> deduct balance & deliver credential
  bot.action(/^buy_(.+)_(.+)$/, async (ctx) => {
    const [, serviceId, planId] = ctx.match;

    const [user, service, plan] = await Promise.all([
      getUser(ctx.from.id),
      shopService.getService(serviceId),
      shopService.getPlan(serviceId, planId),
    ]);

    if (!service || !plan) {
      await ctx.answerCbQuery('This item no longer exists.', { show_alert: true });
      return;
    }
    if (!user || user.balance < plan.price) {
      await ctx.answerCbQuery('❌ Insufficient Balance', { show_alert: true });
      return;
    }

    await ctx.answerCbQuery('Processing your order...');

    // Pop stock FIRST (transaction-safe). If out of stock, nothing is charged.
    const credential = await shopService.popStock(serviceId, planId);
    if (!credential) {
      return ctx.editMessageText('❌ Sorry, this plan just went out of stock. You have not been charged.');
    }

    // Deduct balance only after we successfully reserved a credential.
    await adjustBalance(ctx.from.id, -plan.price);

    await shopService.recordOrder({
      userId: ctx.from.id,
      serviceId,
      planId,
      serviceName: service.name,
      planTitle: plan.title,
      price: plan.price,
      credential,
    });

    await ctx.editMessageText(
      `✅ *Purchase Successful!*\n\n` +
        `${service.emoji || '📦'} ${service.name} - ${plan.title}\n` +
        `Price: ${taka(plan.price)}\n\n` +
        `🔑 *Your Credential:*\n\`${credential}\`\n\n` +
        `Thank you for your purchase! Contact support if you have any issues.`,
      { parse_mode: 'Markdown' }
    );
  });
}

module.exports = { registerShopHandler };
