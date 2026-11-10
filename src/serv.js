'use strict';

/**
 * serv.js — the SERV Reasoning layer (OpenServ SERV Hackathon, Edition 02).
 *
 * This is Jaja's *planning brain* for the SERV edition of AIJajan:
 *
 *   planMission(missionText, ctx) -> {
 *     traceId,            // id of this reasoning trace (audited, shown in UI)
 *     mode,               // 'mock' | 'live'
 *     source,             // 'serv-mock' | 'serv'
 *     steps,              // [{ phase, text }] — the auditable reasoning trace
 *     options,            // ranked catalog items (same contract as agent.js)
 *     proposal,           // [{ itemId, name, price, category, reason }]
 *     pick, pitch,        // Jaja's voice, as before
 *     noMatch,            // true when nothing in the catalog honestly fits
 *   }
 *
 * THE ARCHITECTURE RULE (unchanged from the PayPal edition, and the whole
 * point of the Kite track): SERV *proposes and explains* — it never disposes.
 * Every proposed item still goes through the deterministic policy engine
 * (policy.js) before a cent moves, and SERV has no path around it: this
 * module returns data, not decisions. The "rules-preview" step in the trace
 * is advisory narration only; the engine re-derives every verdict itself.
 *
 * Modes (mirroring paypal.js):
 *   MOCK (SERV_MOCK=1, or SERV_API_KEY missing): a deterministic local
 *     reasoning engine. It builds its shortlist with the same proven scorer
 *     as the original planner (agent.js) and wraps it in a full, realistic
 *     reasoning trace — so the whole flow runs and is testable offline.
 *   LIVE: POSTs the mission + catalog + policy context to the SERV
 *     Reasoning API (OpenAI-compatible chat completions — see the Live
 *     transport section for why not /v1/responses) and normalizes the
 *     reply into the shape above. The reply carries token usage, which
 *     is attached to the plan as `usage` and recorded in the audit log:
 *     the tokens are the evidence SERV was really consulted.
 */

const crypto = require('crypto');
const { ITEMS, byId } = require('./catalog');
const agent = require('./agent');

const CATEGORY_LABELS = {
  domains: 'domains', hosting: 'hosting', games: 'games', subscriptions: 'subscriptions',
  music: 'music', food: 'food & drink', transport: 'transport', bills: 'bills & top-ups',
  health: 'health', home: 'home services', tickets: 'tickets', design: 'design assets',
};

function money(n) { return `$${Number(n).toFixed(2)}`; }

/** Stable trace id for a (mission, policy, balance) triple — mock traces are reproducible. */
function traceIdFor(missionText, ctx) {
  const basis = JSON.stringify({
    m: missionText,
    p: ctx.policy || {},
    b: ctx.balance,
    f: Boolean(ctx.frozen),
  });
  return 'serv-' + crypto.createHash('sha256').update(basis).digest('hex').slice(0, 12);
}

// --- Mock reasoning engine ----------------------------------------------------
// Deterministic: same mission + same context => byte-identical trace. The
// shortlist comes from agent.mockPlan (the PayPal edition's proven scorer);
// this layer's job is to *show the work* around it, step by step, and to
// explain every proposed item — including flagging risks (e.g. auto-renew)
// that the policy engine, not SERV, will rule on.

function budgetNote(item, policy) {
  if (item.subscription) {
    return `Heads-up: this item auto-renews. SERV flags it; whether that is allowed is the policy engine's call, not mine.`;
  }
  if (item.price > policy.askAbove) {
    return `At ${money(item.price)} it sits above even the owner's ${money(policy.askAbove)} ask ceiling — expect resistance from the policy engine.`;
  }
  if (item.price > policy.maxPerPurchase) {
    return `At ${money(item.price)} it is above the ${money(policy.maxPerPurchase)} auto-allow line, so the policy engine will likely ask the owner first.`;
  }
  return `At ${money(item.price)} it sits inside the ${money(policy.maxPerPurchase)} auto-allow line — the policy engine still re-checks it before any money moves.`;
}

function mockPlanMission(missionText, ctx) {
  const policy = ctx.policy || {};
  const base = agent.mockPlan(missionText);
  const traceId = traceIdFor(missionText, ctx);
  const categories = [...new Set(ITEMS.map((i) => i.category))];
  const steps = [];

  if (base.noMatch) {
    steps.push({
      phase: 'understand',
      text: `Mission received: "${missionText}". Intent: find a catalog item that genuinely serves it — or honestly decline. No forcing a fit.`,
    });
    steps.push({
      phase: 'scan',
      text: `Scanned all ${ITEMS.length} catalog items across ${categories.length} categories. Zero items genuinely serve this mission (near-misses in wording are not fits).`,
    });
    steps.push({
      phase: 'rules-preview',
      text: `Owner context noted — balance ${money(ctx.balance)}, auto-allow up to ${money(policy.maxPerPurchase)}. Irrelevant here: with no honest fit, no proposal reaches the policy engine at all.`,
    });
    steps.push({
      phase: 'propose',
      text: `Proposal: buy nothing. The correct plan for an unservable mission is to spend $0 and explain why.`,
    });
    return {
      traceId, mode: 'mock', source: 'serv-mock', steps,
      options: [], proposal: [], pick: null, pitch: base.pitch, noMatch: true,
    };
  }

  const options = base.options;
  const pick = base.pick;
  const cheapest = options.reduce((a, b) => (b.price < a.price ? b : a), options[0]);

  steps.push({
    phase: 'understand',
    text: `Mission received: "${missionText}". Intent: a genuine ${CATEGORY_LABELS[pick.category] || pick.category} purchase that serves the request; "${pick.name}" is the archetype of what is being asked for.`,
  });
  steps.push({
    phase: 'scan',
    text: `Scanned all ${ITEMS.length} catalog items across ${categories.length} categories and built a shortlist of ${options.length} genuine fit(s): ${options.map((o) => o.name).join(' · ')}.`,
  });
  steps.push({
    phase: 'weigh',
    text: `Head-to-head: ${options.map((o) => `${o.name} ${money(o.price)}`).join(' · ')}. Best mission fit: ${pick.name}. Cheapest fit: ${cheapest.name} (${money(cheapest.price)})${cheapest.id === pick.id ? ' — the pick is also the cheapest, no trade-off to explain.' : ` — the pick costs ${money(pick.price - cheapest.price)} more but matches the mission more closely.`}`,
  });
  steps.push({
    phase: 'rules-preview',
    text: `${ctx.frozen ? 'Kill switch is ON: any proposal will be blocked — planning anyway so the audit trail shows the attempt. ' : ''}Owner's rules on file: auto-allow ≤ ${money(policy.maxPerPurchase)}, owner approval up to ${money(policy.askAbove)}, subscriptions ${policy.blockSubscriptions ? 'banned' : 'allowed'}, blocked categories: ${(policy.blockedCategories || []).length ? policy.blockedCategories.join(', ') : 'none'}, balance ${money(ctx.balance)}. This preview is narration only — the deterministic policy engine re-checks every item itself.`,
  });
  steps.push({
    phase: 'propose',
    text: `Proposal: ${pick.name} (${money(pick.price)}) first${options.length > 1 ? `, then ${options.slice(1).map((o) => o.name).join(', ')} as fallbacks if the policy engine vetoes` : ''}. Each item now goes to the policy engine, one by one.`,
  });

  const proposal = options.map((item, idx) => ({
    itemId: item.id,
    name: item.name,
    price: item.price,
    category: item.category,
    reason: idx === 0
      ? `Top pick — strongest ${CATEGORY_LABELS[item.category] || item.category} match for this mission. ${item.blurb} ${budgetNote(item, policy)}`
      : `Runner-up — also a genuine ${CATEGORY_LABELS[item.category] || item.category} fit, kept as a fallback if the policy engine vetoes the pick. ${budgetNote(item, policy)}`,
  }));

  return {
    traceId, mode: 'mock', source: 'serv-mock', steps,
    options, proposal, pick, pitch: base.pitch, noMatch: false,
  };
}

// --- Live transport -------------------------------------------------------------
// Real SERV Reasoning API (docs.openserv.ai/serv-reasoning; probed live
// 2026-11-10 before this code was written). Base: https://inference-api.openserv.ai,
// auth: Authorization: Bearer $SERV_API_KEY, and every request needs a system
// message or it is rejected.
//
// Endpoint choice: POST /v1/chat/completions. The /v1/responses endpoint was
// the first choice (its output[] can carry "reasoning" items), but probing
// killed it twice over: it rejects google/gemini-2.5-flash outright ("not
// available on the Responses API"), and for a model it does accept
// (openai/gpt-5.4-nano) the reply contained only a message item with
// reasoning_tokens: 0 — there is no reasoning item to surface. So: the
// gateway's reasoning runs server-side and exposes NO trace/steps field on
// either endpoint; what chat completions does return, reliably, is the plan
// plus token usage. The trace the UI renders is therefore OUR 5-phase
// structure — populated with the reasoning sentences SERV's model returns
// when it returns them, and with the call's usage (model, tokens, latency,
// estimated cost) attached as the auditable evidence of the call.
//
// The gateway interprets the prompt through its own reasoning layer and its
// reply schema varies between calls (items under proposal | proposals |
// proposed_items | selected_items, or nested in proposal.items; ids as
// itemId | item_id | id; reasoning as a steps array OR an object keyed by
// phase names under `reasoning` or `planning`, the keys in the gateway's
// own wording; risks as a separate list). normalizeServResponse() is
// therefore deliberately schema-tolerant — but never trusting: every
// proposed id is validated against the catalog and unverifiable entries
// are dropped, never invented.

const SERV_BASE_URL = 'https://inference-api.openserv.ai';
const DEFAULT_SERV_MODEL = 'google/gemini-2.5-flash';
const SERV_PHASES = ['understand', 'scan', 'weigh', 'rules-preview', 'propose'];

// USD per 1M tokens (input / output), from the SERV docs' model list —
// used only to estimate the cost recorded in the audit trail.
const SERV_PRICING = {
  'openai/gpt-5.4': [3.25, 20.0],
  'openai/gpt-5.4-mini': [1.0, 6.0],
  'openai/gpt-5.4-nano': [0.25, 1.6],
  'anthropic/claude-sonnet-4.5': [3.0, 15.0],
  'anthropic/claude-sonnet-5': [2.6, 13.0],
  'google/gemini-2.5-flash': [0.4, 3.5],
};

function estimateCostUsd(model, promptTokens, completionTokens) {
  const price = SERV_PRICING[model];
  if (!price || promptTokens == null || completionTokens == null) return null;
  return Math.round(((promptTokens / 1e6) * price[0] + (completionTokens / 1e6) * price[1]) * 1e6) / 1e6;
}

const SERV_PLAN_CONTRACT = '{"steps":[{"phase":"understand","text":"..."},{"phase":"scan","text":"..."},{"phase":"weigh","text":"..."},{"phase":"rules-preview","text":"..."},{"phase":"propose","text":"..."}],"pickId":"<catalog id or null>","optionIds":["<id>"],"proposal":[{"itemId":"<id>","reason":"..."}],"pitch":"..."}';

function servSystemPrompt() {
  return [
    'You are the planning brain (SERV Reasoning) for Jaja, a pocket-money shopping agent.',
    'You ONLY plan and explain. A separate deterministic policy engine judges every item you propose and decides whether money moves; you cannot approve spending.',
    'Pick only from the catalog in the user message; never invent items or ids. If no catalog item genuinely serves the mission, decline honestly (a metaphor is not a fit: hosting is not a house).',
    `Your ENTIRE reply must be one JSON object, no prose, no markdown fences, exactly this shape: ${SERV_PLAN_CONTRACT}`,
    'steps: exactly those 5 phases, one short sentence each, your real reasoning about this mission. proposal: one entry per optionId, same order, with a concrete reason; flag risks you can see (e.g. an auto-renewing subscription) in the reason.',
    'Propose the best genuine fit even if you suspect the owner\'s rules might reject it — flag the risk in the reason instead of declining; the verdict is not yours to make. Decline ONLY when no catalog item genuinely serves the mission.',
    'If declining: pickId null, optionIds [], proposal [], pitch = a playful 1-2 sentence decline in Jaja\'s voice.',
  ].join('\n');
}

function servUserPrompt(missionText, ctx) {
  // Deliberately NOT shown to SERV: the owner's actual rules. The whole
  // architecture is separation of powers — if SERV can read the rulebook it
  // starts pre-applying it (probed live: told "subscriptions are banned",
  // it declined a subscription mission itself, and the policy engine never
  // got to rule). SERV's job is genuine fit + visible risks; verdicts
  // belong to the engine alone.
  const catalogJson = ITEMS.map((i) => ({ id: i.id, name: i.name, category: i.category, price: i.price, subscription: i.subscription }));
  return [
    `Catalog (JSON): ${JSON.stringify(catalogJson)}.`,
    `Owner context: balance ${money(ctx.balance)}. A deterministic policy engine judges every proposed item against the owner's rules after you propose; those rules are not shown to you, and guessing or pre-applying them is not your job. Propose genuine fits, flag visible risks (price, auto-renewal), and let the engine decide.`,
    `Mission: "${missionText}"`,
    'Reply with ONLY the JSON object described in your instructions.',
  ].join('\n');
}

/** Parse the model's reply into an object, tolerating fences and stray prose. */
function parseServJson(content) {
  const cleaned = String(content).replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through to slice extraction */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* give up below */ }
  }
  throw new Error('SERV Reasoning API returned unparseable JSON.');
}

async function callServApi(env, missionText, ctx) {
  const base = (env.SERV_API_URL || SERV_BASE_URL).replace(/\/+$/, '');
  const model = env.SERV_MODEL || DEFAULT_SERV_MODEL;
  const timeoutMs = Number(env.SERV_TIMEOUT_MS) > 0 ? Number(env.SERV_TIMEOUT_MS) : 45000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let res;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.SERV_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: servSystemPrompt() },
          { role: 'user', content: servUserPrompt(missionText, ctx) },
        ],
        temperature: 0.3,
        max_tokens: 1500, // modest cap; the plan JSON is a few hundred tokens
        response_format: { type: 'json_object' },
      }),
    });
  } catch (err) {
    throw new Error(err && err.name === 'AbortError'
      ? `SERV Reasoning API timed out after ${timeoutMs}ms.`
      : `SERV Reasoning API request failed: ${String((err && err.message) || err)}`);
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - started;
  if (!res.ok) throw new Error(`SERV Reasoning API failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('SERV Reasoning API returned no message content.');
  return {
    plan: parseServJson(content),
    usageRaw: data.usage || null,
    model: data.model || model,
    requestId: data.id || null,
    latencyMs,
  };
}

/** Map a gateway phase key (they vary: understanding, rules_preview, …) to ours. */
const PHASE_ALIASES = {
  understand: 'understand', understanding: 'understand',
  scan: 'scan', scanning: 'scan',
  weigh: 'weigh', weighing: 'weigh',
  'rules-preview': 'rules-preview', rulespreview: 'rules-preview',
  propose: 'propose', proposing: 'propose', proposal: 'propose',
};
function canonicalPhase(key) {
  const k = String(key || '').toLowerCase().replace(/_/g, '-');
  if (PHASE_ALIASES[k]) return PHASE_ALIASES[k];
  return SERV_PHASES.includes(k) ? k : null;
}

/** The phase-keyed object the gateway wraps its reasoning in, if present. */
function servPhaseObject(data) {
  for (const key of ['reasoning', 'planning', 'phases']) {
    const v = data[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  // Generic fallback: any object value keyed mostly by phase names.
  for (const v of Object.values(data)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.filter((k) => canonicalPhase(k)).length >= 2) return v;
    }
  }
  return null;
}

/** Step text from a phase value: a string, or an object carrying one. */
function phaseText(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    const t = value.explanation || value.text || value.message || value.reason
      || value.summary || value.detail || value.content || value.description;
    if (typeof t === 'string') return t.trim();
  }
  return '';
}

/** Steps from an array of strings / { phase, text } objects. */
function stepsFromArray(arr) {
  return arr.map((s) => (typeof s === 'string'
    ? { phase: 'reason', text: s }
    : { phase: canonicalPhase(s && s.phase) || 'reason', text: phaseText(s) }
  )).filter((s) => s.text);
}

/** Reasoning steps from whichever shape the gateway chose this time. */
function servStepsFrom(data) {
  if (Array.isArray(data.steps)) return stepsFromArray(data.steps);
  if (Array.isArray(data.reasoning)) return stepsFromArray(data.reasoning);
  // Generic fallback: the gateway also invents key names (reasoning_phases,
  // …) — any reasoning-ish top-level array of strings/objects will do.
  for (const [key, value] of Object.entries(data)) {
    if (/reason|phase|step|plan/i.test(key) && Array.isArray(value)) {
      const steps = stepsFromArray(value);
      if (steps.length) return steps;
    }
  }
  // Probed live: reasoning most often arrives as an object keyed by phase
  // names — under `reasoning`, `planning` or `phases`, keys in the
  // gateway's own wording (understanding / scanning / weighing /
  // rules_preview / …), values either strings or { explanation, … }.
  const obj = servPhaseObject(data);
  if (obj) {
    const steps = [];
    for (const phase of SERV_PHASES) {
      const key = Object.keys(obj).find((k) => canonicalPhase(k) === phase);
      const text = key ? phaseText(obj[key]) : '';
      if (text) steps.push({ phase, text });
    }
    for (const [key, value] of Object.entries(obj)) {
      if (!canonicalPhase(key)) {
        const text = phaseText(value);
        if (text) steps.push({ phase: 'reason', text });
      }
    }
    return steps;
  }
  if (typeof data.reasoning === 'string' && data.reasoning.trim()) {
    return [{ phase: 'reason', text: data.reasoning.trim() }];
  }
  return [];
}

/** Every decision/outcome string in the reply (decline detection). */
function servOutcomeText(data) {
  const parts = [data.decision, data.outcome];
  if (data.proposal && typeof data.proposal === 'object' && !Array.isArray(data.proposal)) {
    parts.push(data.proposal.decision, data.proposal.outcome);
  }
  const obj = servPhaseObject(data);
  if (obj) {
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') parts.push(value.outcome, value.decision);
    }
  }
  return parts.filter(Boolean).join(' ');
}

/** The playful decline text, wherever the gateway put it. */
function servDeclinePitch(data) {
  if (typeof data.pitch === 'string' && data.pitch) return data.pitch;
  // Decline text also arrives under invented keys: decline, decline_reason, …
  for (const [key, value] of Object.entries(data)) {
    if (/declin/i.test(key) && typeof value === 'string' && value) return value;
  }
  if (data.proposal && typeof data.proposal === 'object' && !Array.isArray(data.proposal)) {
    const t = data.proposal.reason || data.proposal.message || data.proposal.text;
    if (typeof t === 'string' && t) return t;
  }
  const obj = servPhaseObject(data);
  if (obj) {
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object' && /declin|reject/i.test(String(value.outcome || value.decision || ''))) {
        const t = value.reason || value.message;
        if (typeof t === 'string' && t) return t;
      }
    }
  }
  return null;
}

/** Per-item risk notes (phase objects carry item_risks maps keyed by id). */
function servItemRisks(data) {
  const map = {};
  const absorb = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [id, text] of Object.entries(v)) if (typeof text === 'string') map[id] = text;
    }
  };
  absorb(data.item_risks); absorb(data.itemRisks);
  const obj = servPhaseObject(data);
  if (obj) {
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') { absorb(value.item_risks); absorb(value.itemRisks); }
    }
  }
  return map;
}

/** The proposed-items array, under any of the key names the gateway uses. */
function servItemsFrom(data, includeFound = true) {
  const lists = [];
  const push = (v) => { if (Array.isArray(v)) lists.push(v); };
  push(data.proposal); push(data.proposals); push(data.proposed_items); push(data.proposedItems);
  push(data.selected_items); push(data.selectedItems); push(data.items); push(data.options); push(data.selection);
  // One probed variant nests the items: proposal: { decision, items: [...] }.
  if (data.proposal && typeof data.proposal === 'object' && !Array.isArray(data.proposal)) {
    push(data.proposal.items); push(data.proposal.options); push(data.proposal.proposed_items);
  }
  if (data.selection && typeof data.selection === 'object' && !Array.isArray(data.selection)) {
    push(data.selection.items); push(data.selection.options);
  }
  const found = [];
  const obj = servPhaseObject(data);
  if (obj) {
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') {
        found.push(value.items, value.found_items, value.foundItems, value.selected_items);
      }
    }
  }
  // Scanning artifacts (found_items) are a last-resort item source, and
  // never override an explicit decline — a scan can list near-misses for
  // a mission SERV rightly refused.
  if (includeFound) for (const f of found) push(f);
  for (const list of lists) {
    if (list.length) return list;
  }
  // Single-entry variants: proposal / selection / pick as ONE object with
  // an id field ({ item_id: "fod-01", reason: "…" }) instead of an array.
  for (const v of [data.proposal, data.selection, data.pick, data.chosen_item, data.selected_item, data.selectedItem]) {
    if (v && typeof v === 'object' && !Array.isArray(v) && (v.itemId || v.item_id || v.id)) return [v];
  }
  // Generic fallback: any array (top level or one level deep) whose
  // entries all carry catalog-id-shaped fields is an item list.
  const hasId = (e) => e && typeof e === 'object' && (e.itemId || e.item_id || e.id);
  for (const value of Object.values(data)) {
    if (Array.isArray(value) && value.length && value.every(hasId)) return value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const inner of Object.values(value)) {
        if (Array.isArray(inner) && inner.length && inner.every(hasId)) return inner;
      }
    }
  }
  return [];
}

function normalizeServResponse(data, missionText, ctx, meta = {}) {
  if (!data || typeof data !== 'object') throw new Error('SERV Reasoning API returned a non-object response.');
  const steps = servStepsFrom(data);
  const risks = Array.isArray(data.risks) ? data.risks.map((r) => String(r)).filter(Boolean) : [];
  const explicitDecline = data.declined === true || typeof data.decline === 'string'
    || Object.keys(data).some((k) => /declin/i.test(k) && data[k])
    || data.pickId === null || data.pick_id === null
    || /declin|reject|cannot|unable|unfulfil/i.test(servOutcomeText(data));
  const itemRisks = servItemRisks(data);
  const proposal = [];
  const options = [];
  for (const entry of servItemsFrom(data, !explicitDecline)) {
    const rawId = entry && (entry.itemId || entry.item_id || entry.id);
    const item = rawId ? byId(rawId) : null;
    if (!item || options.find((o) => o.id === item.id)) continue; // unknown ids are dropped, never invented
    options.push(item);
    let reason = String(entry.reason || 'Proposed by SERV Reasoning.');
    if (itemRisks[item.id]) reason = `${reason} SERV-flagged risk: ${itemRisks[item.id]}`;
    proposal.push({
      itemId: item.id, name: item.name, price: item.price, category: item.category,
      reason,
    });
    if (options.length >= 3) break;
  }
  // Risks the gateway flagged ride on the pick's reason — visible in the
  // trace panel next to the policy engine's verdict on that same item.
  if (proposal.length && risks.length) {
    proposal[0].reason = `${proposal[0].reason} SERV-flagged risk: ${risks.join(' ')}`;
  }
  const usage = meta.usage || null;
  if (!options.length) {
    // A decline is only believed when SERV actually said so (explicit null
    // pick) or showed reasoning while proposing nothing; a shapeless reply
    // is an error, and server.js falls back to the built-in planner.
    if (explicitDecline || steps.length) {
      if (!steps.length) {
        steps.push({ phase: 'propose', text: 'SERV Reasoning declined this mission and returned no step-by-step reasoning text for the call.' });
      }
      const proposeStep = steps.find((s) => s.phase === 'propose');
      return {
        traceId: traceIdFor(missionText, ctx), mode: 'live', source: 'serv',
        steps, options: [], proposal: [], pick: null,
        pitch: String(servDeclinePitch(data) || (proposeStep && proposeStep.text) || `Nothing in the catalog genuinely fits "${missionText}". No money spent.`),
        noMatch: true, usage,
      };
    }
    throw new Error('SERV Reasoning API returned no usable proposal.');
  }
  if (!steps.length) {
    steps.push({
      phase: 'propose',
      text: `SERV Reasoning proposed ${options.map((o) => o.name).join(' · ')} — it returned no step-by-step reasoning text for this call, so this line is the whole trace; the verdicts below are the policy engine's own.`,
    });
  }
  return {
    traceId: traceIdFor(missionText, ctx), mode: 'live', source: 'serv',
    steps, options, proposal, pick: options[0],
    pitch: String(data.pitch || `"${options[0].name}" from ${options[0].vendor} at ${money(options[0].price)} is the pick. ${options[0].blurb}`),
    noMatch: false, usage,
  };
}

// --- Client factory (mirrors paypal.js) ------------------------------------------

function createServClient(env = process.env) {
  const mock = env.SERV_MOCK === '1' || !env.SERV_API_KEY;
  if (mock) {
    return {
      mode: 'mock',
      async planMission(missionText, ctx) {
        return mockPlanMission(missionText, ctx);
      },
    };
  }
  return {
    mode: 'live',
    async planMission(missionText, ctx) {
      const { plan, usageRaw, model, requestId, latencyMs } = await callServApi(env, missionText, ctx);
      // The usage record is the audit evidence that SERV was really
      // consulted for this mission: model, tokens, latency, estimated
      // cost. reasoningTokens stays null on chat completions — that
      // endpoint exposes no reasoning-token split, and we do not invent one.
      const usage = {
        endpoint: 'chat/completions',
        model,
        requestId,
        promptTokens: usageRaw && usageRaw.prompt_tokens != null ? usageRaw.prompt_tokens : null,
        completionTokens: usageRaw && usageRaw.completion_tokens != null ? usageRaw.completion_tokens : null,
        totalTokens: usageRaw && usageRaw.total_tokens != null ? usageRaw.total_tokens : null,
        reasoningTokens: null,
        latencyMs,
        estCostUsd: usageRaw ? estimateCostUsd(model, usageRaw.prompt_tokens, usageRaw.completion_tokens) : null,
      };
      return normalizeServResponse(plan, missionText, ctx, { usage });
    },
  };
}

module.exports = { createServClient, mockPlanMission, normalizeServResponse, traceIdFor };
