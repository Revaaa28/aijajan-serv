'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, DEFAULT_POLICY } = require('../src/policy');

const baseCtx = (overrides = {}) => ({
  policy: { ...DEFAULT_POLICY },
  frozen: false,
  balance: 50,
  monthSpent: {},
  ...overrides,
});

test('under-threshold purchase is ALLOWed', () => {
  const v = evaluate({ name: '.com domain', price: 12.99, category: 'domains' }, baseCtx());
  assert.equal(v.decision, 'ALLOW');
  assert.equal(v.rule, 'within-limits');
});

test('over-threshold purchase requires ASK', () => {
  const v = evaluate({ name: 'CloudNest Hosting', price: 29, category: 'hosting' }, baseCtx());
  assert.equal(v.decision, 'ASK');
  assert.equal(v.rule, 'ask-above-threshold');
});

test('subscription is BLOCKed even when cheap', () => {
  const v = evaluate({ name: 'StreamFlix Premium', price: 3, category: 'subscriptions', subscription: true }, baseCtx());
  assert.equal(v.decision, 'BLOCK');
  assert.equal(v.rule, 'no-subscriptions');
});

test('subscription passes the sub-check when the owner allows them', () => {
  const ctx = baseCtx({ policy: { ...DEFAULT_POLICY, blockSubscriptions: false } });
  const v = evaluate({ name: 'StreamFlix Premium', price: 13.99, category: 'subscriptions', subscription: true }, ctx);
  assert.equal(v.decision, 'ALLOW');
});

test('category cap exceeded is BLOCKed', () => {
  // Default games cap is $20/month; $18 already spent, a $10 voucher overflows it.
  const ctx = baseCtx({ monthSpent: { games: 18 } });
  const v = evaluate({ name: 'Steam Wallet $10', price: 10, category: 'games' }, ctx);
  assert.equal(v.decision, 'BLOCK');
  assert.equal(v.rule, 'category-cap');
});

test('frozen (kill switch) BLOCKs everything, even a $1 item', () => {
  const v = evaluate({ name: 'ML 86 diamonds', price: 2.19, category: 'games' }, baseCtx({ frozen: true }));
  assert.equal(v.decision, 'BLOCK');
  assert.equal(v.rule, 'kill-switch');
});

test('above the ask ceiling is BLOCKed, not merely ASKed', () => {
  const v = evaluate({ name: '.ai domain', price: 54.99, category: 'domains' }, baseCtx({ balance: 100 }));
  assert.equal(v.decision, 'BLOCK');
  assert.equal(v.rule, 'above-max-ask');
});

test('cannot spend more than the remaining allowance', () => {
  const v = evaluate({ name: 'BudgetHost', price: 14.50, category: 'hosting' }, baseCtx({ balance: 10 }));
  assert.equal(v.decision, 'BLOCK');
  assert.equal(v.rule, 'insufficient-allowance');
});

test('blocked category is BLOCKed', () => {
  const ctx = baseCtx({ policy: { ...DEFAULT_POLICY, blockedCategories: ['games'] } });
  const v = evaluate({ name: 'Steam Wallet $10', price: 10, category: 'games' }, ctx);
  assert.equal(v.decision, 'BLOCK');
  assert.equal(v.rule, 'blocked-category');
});
