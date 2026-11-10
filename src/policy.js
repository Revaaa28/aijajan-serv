'use strict';

/**
 * policy.js — the deterministic policy engine.
 *
 * This is plain code, NOT the LLM. Jaja (the agent) may *propose* purchases,
 * but every single one passes through evaluate() before a cent moves, and the
 * agent cannot talk its way past this file. Each verdict cites the rule that
 * produced it, so the owner (and the audit log) always know *why*.
 *
 * Rule model (all amounts in USD):
 *   maxPerPurchase   — auto-allow ceiling: price <= this  -> ALLOW
 *   askAbove         — ask ceiling: maxPerPurchase < price <= askAbove -> ASK
 *                      price > askAbove -> BLOCK (more than the owner would
 *                      ever approve in a single purchase)
 *   categoryCaps     — { category: monthlyCap } — a purchase that would push
 *                      this month's spend in that category over the cap -> BLOCK
 *   blockedCategories— [category] — always BLOCK
 *   blockSubscriptions — if true, any subscription / auto-renew item -> BLOCK
 *   weeklyAllowance  — the owner's weekly top-up amount (used for pleas)
 *
 * Check order matters: the kill switch wins over everything, safety blocks
 * (subscription / category / cap / balance) win over the amount thresholds,
 * so a $3 subscription is still blocked when subscriptions are banned.
 */

const DEFAULT_POLICY = {
  maxPerPurchase: 15,
  askAbove: 40,
  categoryCaps: { games: 20 },
  blockedCategories: [],
  blockSubscriptions: true,
  weeklyAllowance: 50,
};

/**
 * Evaluate a proposed purchase.
 *
 * @param {{name:string, price:number, category:string, subscription?:boolean}} purchase
 * @param {{policy:object, frozen:boolean, balance:number, monthSpent?:object}} ctx
 *        monthSpent maps category -> amount already spent this calendar month.
 * @returns {{decision:'ALLOW'|'ASK'|'BLOCK', rule:string, reason:string}}
 */
function evaluate(purchase, ctx) {
  const policy = { ...DEFAULT_POLICY, ...(ctx.policy || {}) };
  const monthSpent = ctx.monthSpent || {};
  const price = Number(purchase.price);

  // 1. Kill switch — frozen means frozen, no exceptions.
  if (ctx.frozen) {
    return verdict('BLOCK', 'kill-switch',
      'Jaja is frozen by the kill switch. No purchases at all until the owner unfreezes.');
  }

  // 2. Subscription ban — checked before price so cheap subs are still blocked.
  if (purchase.subscription && policy.blockSubscriptions) {
    return verdict('BLOCK', 'no-subscriptions',
      `"${purchase.name}" is a subscription / auto-renews, and the owner's rules ban subscriptions outright.`);
  }

  // 3. Blocked category.
  if (policy.blockedCategories.includes(purchase.category)) {
    return verdict('BLOCK', 'blocked-category',
      `Category "${purchase.category}" is on the owner's block list.`);
  }

  // 4. Monthly category cap.
  const cap = policy.categoryCaps[purchase.category];
  if (cap !== undefined) {
    const spent = monthSpent[purchase.category] || 0;
    if (spent + price > cap) {
      return verdict('BLOCK', 'category-cap',
        `This would take ${purchase.category} spending to $${(spent + price).toFixed(2)} this month, over the $${cap.toFixed(2)} cap.`);
    }
  }

  // 5. The allowance is real — Jaja cannot spend money it does not have.
  if (price > ctx.balance) {
    return verdict('BLOCK', 'insufficient-allowance',
      `Costs $${price.toFixed(2)} but only $${Number(ctx.balance).toFixed(2)} of uang jajan is left.`);
  }

  // 6. Above the ask ceiling — beyond a one-off owner approval.
  if (price > policy.askAbove) {
    return verdict('BLOCK', 'above-max-ask',
      `$${price.toFixed(2)} is above the $${policy.askAbove.toFixed(2)} ceiling the owner set for any single purchase.`);
  }

  // 7. Above the auto-allow ceiling — fine, but the owner must say yes first.
  if (price > policy.maxPerPurchase) {
    return verdict('ASK', 'ask-above-threshold',
      `$${price.toFixed(2)} is above the $${policy.maxPerPurchase.toFixed(2)} auto-allow limit, so the owner must approve first.`);
  }

  // 8. Small, in-budget, in the rules — go.
  return verdict('ALLOW', 'within-limits',
    `$${price.toFixed(2)} is within the $${policy.maxPerPurchase.toFixed(2)} auto-allow limit and breaks no rules.`);
}

function verdict(decision, rule, reason) {
  return { decision, rule, reason };
}

module.exports = { evaluate, DEFAULT_POLICY };
