'use strict';

/**
 * AIJajan server — SERV edition (OpenServ SERV Hackathon, Edition 02).
 *
 * Flow: owner sends a mission -> SERV Reasoning (serv.js) plans it and
 * shows its work as an auditable trace -> policy.js (deterministic, not
 * the AI) verdicts ALLOW / ASK / BLOCK on every proposed item ->
 * paypal.js moves sandbox money -> store.js persists everything,
 * including the trace, which the audit log cross-references by id.
 *
 * SERV proposes and explains; it can never move money or bypass the
 * policy engine. If SERV is unavailable, the built-in planner (agent.js)
 * takes over planning — the policy engine still judges every item.
 *
 * Modes: PAYPAL_MOCK=1 (or missing PayPal creds) simulates PayPal;
 * SERV_MOCK=1 (or missing SERV_API_KEY) uses the deterministic local
 * reasoning engine with full traces; GEMINI_API_KEY only voices the
 * diary. With everything unset the app still runs end-to-end — that's
 * the judges' zero-setup path.
 */

// Minimal .env loader (keeps the dependency list at just express).
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const express = require('express');
const policyEngine = require('./src/policy');
const store = require('./src/store');
const agent = require('./src/agent');
const { ITEMS } = require('./src/catalog');
const { createPayPalClient } = require('./src/paypal');
const { createServClient } = require('./src/serv');

const paypal = createPayPalClient();
const serv = createServClient();
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

/** The public view of the world — everything the UI renders from. */
function publicState(state) {
  return {
    balance: state.balance,
    mood: store.moodFor(state.balance),
    frozen: state.frozen,
    policy: state.policy,
    pending: state.pending,
    plea: state.plea,
    diary: state.diary.slice(-20).reverse(),
    audit: state.audit.slice(-50).reverse(),
    spentTotal: state.spentTotal,
    catalog: ITEMS,
    servTrace: state.lastTrace || null,
    modes: { paypal: paypal.mode, serv: serv.mode, ai: process.env.GEMINI_API_KEY ? 'gemini' : 'mock' },
  };
}

function policyCtx(state) {
  return {
    policy: state.policy,
    frozen: state.frozen,
    balance: state.balance,
    monthSpent: Object.fromEntries(ITEMS.map((i) => [i.category, store.monthSpentFor(state, i.category)])),
  };
}

async function executePayment(state, item, verdict) {
  const result = await paypal.payForItem(item);
  state.balance = store.round2(state.balance - item.price);
  store.recordSpend(state, item);
  store.audit(state, 'purchase', `Paid $${item.price.toFixed(2)} for "${item.name}" (${result.orderId})`, {
    amount: -item.price, rule: verdict ? verdict.rule : 'owner-approved',
  });
  return result;
}

app.get('/api/health', (req, res) => {
  const state = store.load();
  res.json({ ok: true, paypalMode: paypal.mode, servMode: serv.mode, aiMode: process.env.GEMINI_API_KEY ? 'gemini' : 'mock', balance: state.balance, frozen: state.frozen });
});

app.get('/api/state', (req, res) => {
  res.json(publicState(store.load()));
});

app.post('/api/policy/text', (req, res) => {
  const { parseRules } = require('./src/rulesParser');
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'Rule text is required.' });
  const { updates, understood } = parseRules(text);
  if (!understood.length) {
    return res.status(422).json({ error: 'Jaja could not find any rules in that text. Try: "ask me first above $15, no subscriptions, games max $20 a month".' });
  }
  const state = store.load();
  for (const key of ['maxPerPurchase', 'askAbove', 'weeklyAllowance']) {
    if (updates[key] !== undefined) state.policy[key] = updates[key];
  }
  if (updates.categoryCaps) state.policy.categoryCaps = { ...state.policy.categoryCaps, ...updates.categoryCaps };
  if (updates.blockedCategories) {
    state.policy.blockedCategories = [...new Set([...state.policy.blockedCategories, ...updates.blockedCategories])];
  }
  if (typeof updates.blockSubscriptions === 'boolean') state.policy.blockSubscriptions = updates.blockSubscriptions;
  store.audit(state, 'policy', `Owner taught rules in plain words: "${text}" → ${understood.join(' ')}`);
  store.save(state);
  res.json({ understood, state: publicState(state) });
});

app.post('/api/policy', (req, res) => {
  const state = store.load();
  const b = req.body || {};
  for (const key of ['maxPerPurchase', 'askAbove', 'weeklyAllowance']) {
    if (b[key] !== undefined && Number.isFinite(Number(b[key])) && Number(b[key]) >= 0) state.policy[key] = Number(b[key]);
  }
  if (b.categoryCaps && typeof b.categoryCaps === 'object') state.policy.categoryCaps = b.categoryCaps;
  if (Array.isArray(b.blockedCategories)) state.policy.blockedCategories = b.blockedCategories;
  if (typeof b.blockSubscriptions === 'boolean') state.policy.blockSubscriptions = b.blockSubscriptions;
  store.audit(state, 'policy', 'Owner updated the rules.');
  store.save(state);
  res.json(publicState(state));
});

app.post('/api/mission', async (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'Mission text is required.' });
  const state = store.load();
  const steps = [];
  try {
    // SERV Reasoning plans the mission and shows its work. If SERV is
    // unavailable, the built-in planner takes over — either way the plan
    // is only a proposal; the policy engine below judges every item.
    let plan = null;
    let trace = null;
    try {
      plan = await serv.planMission(text, policyCtx(state));
    } catch (servErr) {
      console.error('SERV planning failed, falling back to built-in planner:', servErr);
      store.audit(state, 'serv-fallback',
        `SERV Reasoning unavailable for "${text}" (${String(servErr.message || servErr).slice(0, 120)}) — the built-in planner drafted this mission instead; the policy engine still judges every item.`);
      steps.push({ kind: 'reason', phase: 'fallback', text: `SERV Reasoning was unavailable (${String(servErr.message || servErr).slice(0, 100)}) — the built-in planner drafted this mission instead. The policy engine still judges every item.` });
      plan = await agent.planMission(text);
    }
    if (plan.traceId) {
      trace = {
        traceId: plan.traceId,
        mode: plan.mode,
        source: plan.source,
        usage: plan.usage || null,
        mission: text,
        ts: new Date().toISOString(),
        reasoning: plan.steps,
        proposal: plan.proposal,
        decisions: [],
        outcome: null,
      };
      state.lastTrace = trace;
      const usageNote = plan.usage
        ? ` SERV usage: ${plan.usage.totalTokens} tokens (${plan.usage.promptTokens} in / ${plan.usage.completionTokens} out, ${plan.usage.model}, ${plan.usage.latencyMs}ms${plan.usage.estCostUsd != null ? `, ≈$${plan.usage.estCostUsd.toFixed(4)}` : ''}).`
        : '';
      store.audit(state, 'serv-plan',
        `SERV trace ${trace.traceId} (${plan.mode}) planned "${text}": ${plan.steps.length} reasoning steps, proposed ${plan.noMatch ? 'nothing — no honest fit' : plan.proposal.map((p) => p.name).join(' · ')}.${usageNote}`,
        { servTraceId: trace.traceId, ...(plan.usage ? { servUsage: plan.usage } : {}) });
      for (const s of plan.steps) steps.push({ kind: 'reason', phase: s.phase, text: s.text });
    }

    // Nothing in the catalog genuinely fits: Jaja declines, spends nothing.
    if (plan.noMatch) {
      if (trace) trace.outcome = 'no-match';
      steps.push({ kind: 'pitch', text: plan.pitch });
      steps.push({ kind: 'nomatch', text: `No purchase. Jaja only buys what the catalog honestly offers — and the policy engine never even had to wake up.` });
      store.audit(state, 'no-match', `Mission "${text}" — nothing in the catalog fits; no purchase.`);
      state.diary.push({ ts: new Date().toISOString(), mood: store.moodFor(state.balance).key, text: await agent.writeDiaryAsync('nomatch', { mission: text }) });
      store.save(state);
      return res.json({ steps, outcome: 'no-match', trace, state: publicState(state) });
    }

    const cmp = agent.compareLine(plan.options);
    if (cmp) steps.push({ kind: 'compare', text: cmp });
    steps.push({ kind: 'pitch', text: plan.pitch });

    // SERV proposes; the policy engine disposes. If the pick is BLOCKed,
    // Jaja sheepishly tries its next option once before giving up.
    let chosen = null;
    let verdict = null;
    for (let i = 0; i < plan.options.length; i++) {
      const candidate = plan.options[i];
      verdict = policyEngine.evaluate(candidate, policyCtx(state));
      steps.push({ kind: 'verdict', decision: verdict.decision, rule: verdict.rule, text: `${candidate.name}: ${verdict.decision} — rule "${verdict.rule}". ${verdict.reason}` });
      if (trace) trace.decisions.push({ itemId: candidate.id, name: candidate.name, price: candidate.price, decision: verdict.decision, rule: verdict.rule });
      if (verdict.decision !== 'BLOCK') { chosen = candidate; break; }
      // A frozen wallet blocks everything identically — no sheepish retries.
      if (i < plan.options.length - 1 && verdict.rule !== 'kill-switch') {
        steps.push({ kind: 'retry', text: `Okay, okay — not that one then. Checking my next option…` });
      }
    }

    if (!chosen) {
      if (trace) trace.outcome = 'blocked';
      store.audit(state, 'blocked', `Mission "${text}" — every option was blocked. Last rule: ${verdict.rule}`);
      state.diary.push({ ts: new Date().toISOString(), mood: store.moodFor(state.balance).key, text: await agent.writeDiaryAsync('blocked', { item: plan.pick, price: plan.pick.price.toFixed(2), reason: verdict.reason, rule: verdict.rule }) });
      store.save(state);
      return res.json({ steps, outcome: 'blocked', trace, state: publicState(state) });
    }

    if (verdict.decision === 'ASK') {
      if (trace) trace.outcome = 'ask';
      const pending = { id: `pend-${Date.now()}`, item: chosen, verdict, mission: text, createdAt: new Date().toISOString() };
      state.pending.push(pending);
      store.audit(state, 'ask', `Asked owner before buying "${chosen.name}" ($${chosen.price.toFixed(2)})`, { rule: verdict.rule });
      state.diary.push({ ts: new Date().toISOString(), mood: store.moodFor(state.balance).key, text: await agent.writeDiaryAsync('asked', { item: chosen, price: chosen.price.toFixed(2) }) });
      store.save(state);
      steps.push({ kind: 'pending', text: `Waiting on the boss. Approve it and I pay instantly.` });
      return res.json({ steps, outcome: 'ask', pendingId: pending.id, verdict, trace, state: publicState(state) });
    }

    // ALLOW — pay right away. A PayPal failure is a first-class outcome:
    // no money moves, the balance is untouched, the failure is audited.
    let result;
    try {
      result = await executePayment(state, chosen, verdict);
    } catch (payErr) {
      console.error(payErr);
      if (trace) trace.outcome = 'payment-failed';
      store.audit(state, 'payment-failed', `Payment for "${chosen.name}" ($${chosen.price.toFixed(2)}) failed at PayPal: ${String(payErr.message || payErr).slice(0, 140)}`);
      store.save(state);
      steps.push({ kind: 'nomatch', text: `Payment failed at PayPal — no money moved, balance unchanged. The failure is in the audit log; the mission can be retried.` });
      return res.json({ steps, outcome: 'payment-failed', trace, state: publicState(state) });
    }
    if (trace) { trace.outcome = 'paid'; trace.orderId = result.orderId; }
    store.save(state); // record the payment before any diary rendering
    state.diary.push({ ts: new Date().toISOString(), mood: store.moodFor(state.balance).key, text: await agent.writeDiaryAsync('paid', { item: chosen, price: chosen.price.toFixed(2), balance: state.balance.toFixed(2), rule: verdict.rule }) });
    store.save(state);
    steps.push({ kind: 'paid', text: `Paid via PayPal (${paypal.mode}). Order ${result.orderId}. New balance $${state.balance.toFixed(2)}.` });
    return res.json({ steps, outcome: 'paid', verdict, order: result, trace, state: publicState(state) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/approve', async (req, res) => {
  const state = store.load();
  const idx = state.pending.findIndex((p) => p.id === (req.body || {}).id);
  if (idx === -1) return res.status(404).json({ error: 'Pending approval not found.' });
  const [pending] = state.pending.splice(idx, 1);
  if (state.frozen) {
    return res.status(409).json({ error: 'Jaja is frozen (kill switch). Unfreeze before approving purchases.' });
  }
  if (pending.item.price > state.balance) {
    return res.status(409).json({ error: 'Not enough uang jajan left for this purchase.' });
  }
  try {
    const result = await executePayment(state, pending.item, null);
    store.save(state); // record the payment before any diary rendering
    state.diary.push({ ts: new Date().toISOString(), mood: store.moodFor(state.balance).key, text: await agent.writeDiaryAsync('paid', { item: pending.item, price: pending.item.price.toFixed(2), balance: state.balance.toFixed(2), rule: 'owner-approved' }) });
    store.save(state);
    return res.json({ outcome: 'paid', order: result, state: publicState(state) });
  } catch (err) {
    // Payment failed after approval: put the request back so the owner can
    // retry, audit the failure, and leave the balance untouched.
    console.error(err);
    state.pending.push(pending);
    store.audit(state, 'payment-failed', `Approved payment for "${pending.item.name}" ($${pending.item.price.toFixed(2)}) failed at PayPal: ${String(err.message || err).slice(0, 140)} — request restored for retry.`);
    store.save(state);
    return res.status(502).json({ error: `Payment failed at PayPal — no money moved. The approval is back in the queue so you can retry. (${String(err.message || err).slice(0, 120)})`, state: publicState(state) });
  }
});

app.post('/api/deny', async (req, res) => {
  const state = store.load();
  const idx = state.pending.findIndex((p) => p.id === (req.body || {}).id);
  if (idx === -1) return res.status(404).json({ error: 'Pending approval not found.' });
  const [pending] = state.pending.splice(idx, 1);
  store.audit(state, 'denial', `Owner denied "${pending.item.name}" ($${pending.item.price.toFixed(2)})`);
  state.diary.push({ ts: new Date().toISOString(), mood: store.moodFor(state.balance).key, text: await agent.writeDiaryAsync('denied', { item: pending.item, price: pending.item.price.toFixed(2) }) });
  store.save(state);
  res.json({ outcome: 'denied', state: publicState(state) });
});

app.post('/api/plea', async (req, res) => {
  const state = store.load();
  if (state.balance >= 5) return res.status(409).json({ error: `Jaja still has $${state.balance.toFixed(2)} — pleas are only for the truly broke (under $5).` });
  if (!state.plea) {
    const plea = await agent.composePlea(state);
    state.plea = { id: `plea-${Date.now()}`, ...plea, createdAt: new Date().toISOString() };
    store.audit(state, 'plea', `Jaja composed a plea for a $${plea.amount} top-up.`);
    store.save(state);
  }
  res.json({ plea: state.plea, state: publicState(state) });
});

app.post('/api/plea/approve', async (req, res) => {
  const state = store.load();
  if (!state.plea) return res.status(404).json({ error: 'No plea to approve.' });
  const amount = state.plea.amount;
  try {
    const result = await paypal.topUp(amount);
    state.plea = null;
    state.balance = store.round2(state.balance + amount);
    store.audit(state, 'topup', `Owner approved the plea — topped up $${amount.toFixed(2)} (${result.payoutId})`, { amount });
    state.diary.push({ ts: new Date().toISOString(), mood: store.moodFor(state.balance).key, text: await agent.writeDiaryAsync('topup', { amount: amount.toFixed(2), balance: state.balance.toFixed(2) }) });
    store.save(state);
    res.json({ outcome: 'topped-up', payout: result, state: publicState(state) });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: `Top-up failed at PayPal — the plea is still open and no money moved. (${String(err.message || err).slice(0, 120)})` });
  }
});

app.post('/api/plea/deny', async (req, res) => {
  const state = store.load();
  if (!state.plea) return res.status(404).json({ error: 'No plea to deny.' });
  state.plea = null;
  store.audit(state, 'plea-denied', 'Owner denied Jaja\'s top-up plea.');
  state.diary.push({ ts: new Date().toISOString(), mood: store.moodFor(state.balance).key, text: await agent.writeDiaryAsync('pleaDenied', {}) });
  store.save(state);
  res.json({ outcome: 'plea-denied', state: publicState(state) });
});

app.post('/api/topup', async (req, res) => {
  const amount = Number((req.body || {}).amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 500) return res.status(400).json({ error: 'Top-up amount must be between $0 and $500.' });
  const state = store.load();
  try {
    const result = await paypal.topUp(amount);
    state.balance = store.round2(state.balance + amount);
    if (state.plea && state.balance >= 5) state.plea = null;
    store.audit(state, 'topup', `Owner topped up $${amount.toFixed(2)} (${result.payoutId})`, { amount });
    state.diary.push({ ts: new Date().toISOString(), mood: store.moodFor(state.balance).key, text: await agent.writeDiaryAsync('topup', { amount: amount.toFixed(2), balance: state.balance.toFixed(2) }) });
    store.save(state);
    res.json({ outcome: 'topped-up', payout: result, state: publicState(state) });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: `Top-up failed at PayPal — no money moved. (${String(err.message || err).slice(0, 120)})` });
  }
});

app.post('/api/freeze', (req, res) => {
  const state = store.load();
  state.frozen = Boolean((req.body || {}).frozen);
  store.audit(state, state.frozen ? 'freeze' : 'unfreeze', state.frozen ? 'Kill switch ON — Jaja is frozen.' : 'Kill switch OFF — Jaja may shop again.');
  store.save(state);
  res.json(publicState(state));
});

app.post('/api/reset', (req, res) => {
  res.json(publicState(store.reset()));
});

app.listen(PORT, () => {
  console.log(`AIJajan (SERV edition) is awake on http://localhost:${PORT}  (SERV: ${serv.mode}, PayPal: ${paypal.mode}, diary voice: ${process.env.GEMINI_API_KEY ? 'gemini' : 'mock'})`);
});
