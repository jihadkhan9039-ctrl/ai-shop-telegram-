/**
 * keyboards.js - all reply/inline keyboard builders in one place
 */

const { Markup } = require('telegraf');
const { taka, chunk } = require('../../utils/helpers');

/** Persistent bottom reply keyboard (main menu). */
const mainMenuKeyboard = Markup.keyboard([
  ['🛒 Shop', '👥 Refer & Earn'],
  ['💰 Balance', '🆘 Support'],
]).resize();

/** Shop: list of active services as inline buttons, one per row. */
function servicesKeyboard(services) {
  const rows = services.map((s) => [
    Markup.button.callback(`${s.emoji || '📦'} ${s.name}`, `svc_${s.id}`),
  ]);
  rows.push([Markup.button.callback('⬅️ Close', 'shop_close')]);
  return Markup.inlineKeyboard(rows);
}

/** Plans for one service. */
function plansKeyboard(serviceId, plans) {
  const rows = plans.map((p) => [
    Markup.button.callback(
      `${p.title} - ${taka(p.price)} (${p.stockCount ?? 0} in stock)`,
      `plan_${serviceId}_${p.id}`
    ),
  ]);
  rows.push([Markup.button.callback('⬅️ Back to Shop', 'shop_back')]);
  return Markup.inlineKeyboard(rows);
}

/** Confirm / cancel a specific order. */
function confirmOrderKeyboard(serviceId, planId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Confirm Purchase', `buy_${serviceId}_${planId}`)],
    [Markup.button.callback('⬅️ Back', `svc_${serviceId}`)],
  ]);
}

/** Balance card actions. */
const balanceKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('➕ Add Fund', 'add_fund')],
]);

/** bKash / Nagad choice shown after "Add Fund". */
const paymentMethodKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('📱 bKash', 'pay_bkash')],
  [Markup.button.callback('📱 Nagad', 'pay_nagad')],
  [Markup.button.callback('⬅️ Back', 'balance_back')],
]);

/** After choosing a method, prompt to submit TrxID. */
const submitTrxKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('🧾 I Have Sent Money - Submit TrxID', 'submit_trx')],
  [Markup.button.callback('⬅️ Back', 'add_fund')],
]);

module.exports = {
  mainMenuKeyboard,
  servicesKeyboard,
  plansKeyboard,
  confirmOrderKeyboard,
  balanceKeyboard,
  paymentMethodKeyboard,
  submitTrxKeyboard,
  chunk,
};
