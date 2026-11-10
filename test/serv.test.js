'use strict';

/**
 * serv.test.js — the SERV Reasoning layer, and the contract that makes the
 * Kite track honest: SERV proposes and explains, the deterministic policy
 * engine (policy.js) still disposes. These tests run the exact sequence
 * server.js runs — serv.planMission() first, policyEngine.evaluate() on
 * every proposed item — and prove SERV cannot talk its way past the rules.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServClient, mockPlanMission } = require('../src/serv');
const { evaluate, DEFAULT_POLICY } = require('../src/policy');

const baseCtx = (overrides = {}) => ({
  policy: { ...DEFAULT_POLICY },
  frozen: false,
  balance: 50,
  monthSpent: {},
  ...overrides,
});

/** Run a plan's options through the policy engine exactly like server.js does. */
function gateAll(plan, ctx) {
  return plan.options.map((item) => ({ item, verdict: evaluate(item, ctx) }));
}

test('client defaults to mock mode without a key (mirrors PAYPAL_MOCK)', () => {
  assert.equal(createServClient({}).mode, 'mock');
  assert.equal(createServClient({ SERV_MOCK: '1', SERV_API_KEY: 'x' }).mode, 'mock');
  assert.equal(createServClient({ SERV_API_KEY: 'x' }).mode, 'live');
});

test('mock plan returns a full reasoning trace and an explained proposal', async () => {
  const serv = createServClient({});
  const plan = await serv.planMission('Buy me lunch and something to drink', baseCtx());
  assert.match(plan.traceId, /^serv-[0-9a-f]{12}$/);
  assert.equal(plan.mode, 'mock');
  assert.deepEqual(plan.steps.map((s) => s.phase), ['understand', 'scan', 'weigh', 'rules-preview', 'propose']);
  assert.ok(plan.steps.every((s) => s.text.length > 20));
  assert.equal(plan.noMatch, false);
  assert.equal(plan.pick.category, 'food');
  assert.equal(plan.proposal[0].itemId, plan.pick.id);
  assert.ok(plan.proposal.every((p) => p.reason && p.reason.length > 20));
  // Proposal and options describe the same ranked shortlist.
  assert.deepEqual(plan.proposal.map((p) => p.itemId), plan.options.map((o) => o.id));
});

test('mock traces are deterministic — same mission and context, same trace', async () => {
  const a = await mockPlanMission('Buy me a nasi goreng voucher', baseCtx());
  const b = await mockPlanMission('Buy me a nasi goreng voucher', baseCtx());
  assert.deepEqual(a, b);
});

test('unservable mission: SERV proposes nothing and says why', async () => {
  const plan = await mockPlanMission('Buy me a house', baseCtx());
  assert.equal(plan.noMatch, true);
  assert.deepEqual(plan.proposal, []);
  assert.deepEqual(plan.options, []);
  assert.match(plan.steps.at(-1).text, /buy nothing/);
});

test('a SERV-proposed item in an owner-blocked category is BLOCKed by policy', async () => {
  const ctx = baseCtx({ policy: { ...DEFAULT_POLICY, blockedCategories: ['games'] } });
  const plan = await mockPlanMission('Get me a game voucher, I had a long week', ctx);
  assert.equal(plan.pick.category, 'games'); // SERV happily proposes it…
  const gated = gateAll(plan, ctx);          // …and the engine vetoes every option
  assert.ok(gated.length > 0);
  for (const { item, verdict } of gated) {
    assert.equal(verdict.decision, 'BLOCK');
    // The engine checks the subscription ban before the category list, so a
    // subscription games item cites no-subscriptions; the rest cite the
    // blocked category. Either way: proposed by SERV, killed by policy.
    assert.equal(verdict.rule, item.subscription ? 'no-subscriptions' : 'blocked-category');
  }
  assert.equal(evaluate(plan.pick, ctx).rule, 'blocked-category');
});

test('a SERV-proposed subscription is BLOCKed, and SERV flags the risk itself', async () => {
  const ctx = baseCtx();
  const plan = await mockPlanMission('Subscribe me to a music streaming premium plan', ctx);
  assert.equal(plan.pick.subscription, true);
  // The explanation layer names the auto-renew risk in its own reason text…
  assert.match(plan.proposal[0].reason, /auto-renews/);
  // …but flagging is all it can do: the engine still blocks it.
  const verdict = evaluate(plan.pick, ctx);
  assert.equal(verdict.decision, 'BLOCK');
  assert.equal(verdict.rule, 'no-subscriptions');
});

test('kill switch wins over every SERV proposal', async () => {
  const ctx = baseCtx({ frozen: true });
  const plan = await mockPlanMission('Buy me lunch and something to drink', ctx);
  assert.ok(plan.options.length > 0); // planning still happens, for the audit trail
  for (const { verdict } of gateAll(plan, ctx)) {
    assert.equal(verdict.decision, 'BLOCK');
    assert.equal(verdict.rule, 'kill-switch');
  }
});

test('SERV proposals still flow through the ASK path untouched', async () => {
  const ctx = baseCtx();
  const plan = await mockPlanMission('Find me hosting for my portfolio website', ctx);
  const verdict = evaluate(plan.pick, ctx);
  assert.equal(verdict.decision, 'ASK');
  assert.equal(verdict.rule, 'ask-above-threshold');
});

test('balance is law: SERV cannot propose its way past an empty wallet', async () => {
  const ctx = baseCtx({ balance: 3 });
  const plan = await mockPlanMission('Buy me lunch and something to drink', ctx);
  for (const { item, verdict } of gateAll(plan, ctx)) {
    if (item.price > 3) {
      assert.equal(verdict.decision, 'BLOCK');
      assert.equal(verdict.rule, 'insufficient-allowance');
    }
  }
});
