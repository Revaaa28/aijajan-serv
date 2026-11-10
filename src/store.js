'use strict';

/**
 * store.js — JSON-file state. Deliberately boring: one file, atomic-ish
 * writes (tmp + rename), everything the app needs in one object.
 *
 * State shape:
 *   balance         — Jaja's current uang jajan (USD)
 *   policy          — owner rules (see policy.js)
 *   frozen          — kill switch
 *   monthSpent      — { 'YYYY-MM': { category: amount } } for category caps
 *   spentTotal      — lifetime spend (display)
 *   audit           — [{ ts, type, detail, amount?, rule? }]
 *   diary           — [{ ts, mood, text }]
 *   pending         — [{ id, item, verdict, createdAt }] awaiting approval
 *   plea            — { id, amount, text, createdAt } | null
 *   lastTrace       — the most recent SERV reasoning trace (serv.js):
 *                     { traceId, mode, mission, ts, reasoning, proposal,
 *                       decisions, outcome } — rendered by the UI trace panel
 *                     and cross-referenced from the audit log.
 */

const fs = require('fs');
const path = require('path');
const { DEFAULT_POLICY } = require('./policy');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

function monthKey(d = new Date()) {
  return d.toISOString().slice(0, 7); // 'YYYY-MM'
}

function defaultState() {
  return {
    balance: DEFAULT_POLICY.weeklyAllowance,
    policy: { ...DEFAULT_POLICY },
    frozen: false,
    monthSpent: {},
    spentTotal: 0,
    audit: [],
    diary: [{
      ts: new Date().toISOString(),
      mood: 'content',
      text: 'Day one of having money. I have been given uang jajan and an unreasonable amount of trust. I will spend it wisely. Probably.',
    }],
    pending: [],
    plea: null,
    lastTrace: null,
  };
}

function load() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Merge over defaults so new fields appear after upgrades.
    return { ...defaultState(), ...parsed, policy: { ...DEFAULT_POLICY, ...(parsed.policy || {}) } };
  } catch {
    return defaultState();
  }
}

function save(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function reset() {
  const s = defaultState();
  save(s);
  return s;
}

function monthSpentFor(state, category) {
  const m = state.monthSpent[monthKey()] || {};
  return m[category] || 0;
}

function recordSpend(state, item) {
  const key = monthKey();
  state.monthSpent[key] = state.monthSpent[key] || {};
  state.monthSpent[key][item.category] = round2((state.monthSpent[key][item.category] || 0) + item.price);
  state.spentTotal = round2(state.spentTotal + item.price);
}

function audit(state, type, detail, extra = {}) {
  state.audit.push({ ts: new Date().toISOString(), type, detail, ...extra });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Mood is a pure function of how much uang jajan is left. */
function moodFor(balance) {
  if (balance >= 30) return { key: 'rich', emoji: '🤑', label: 'Rich & confident' };
  if (balance >= 15) return { key: 'content', emoji: '😊', label: 'Content' };
  if (balance >= 5) return { key: 'careful', emoji: '😐', label: 'Careful now' };
  return { key: 'broke', emoji: '😭', label: 'Broke & dramatic' };
}

module.exports = { load, save, reset, defaultState, monthSpentFor, recordSpend, audit, moodFor, round2, monthKey };
