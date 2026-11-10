'use strict';

/**
 * agent.js — Jaja, the agent.
 *
 * Jaja's jobs:
 *   1. planMission(missionText, catalog) -> a ranked shortlist of items with
 *      a pick, explained in Jaja's voice. The LLM (Gemini) does the picking
 *      when GEMINI_API_KEY is set; otherwise a deterministic keyword scorer
 *      does it. Either way, the *pick* is only a proposal — policy.js decides
 *      whether money may move.
 *   2. writeDiary(event, ctx) -> a short first-person diary entry.
 *   3. composePlea(state) -> a dramatic-but-charming top-up request.
 *
 * Gemini failures never break the flow: any error falls back to the mock,
 * because a hackathon demo (and a judge's laptop) must work offline-ish.
 */

const { ITEMS } = require('./catalog');

// Words that point at each catalog category. Used by the deterministic
// fallback planner (and as a sanity vocabulary for the LLM prompt).
const CATEGORY_HINTS = {
  domains: ['domain', 'website name', '.com', 'url', 'site name'],
  hosting: ['hosting', 'host', 'server', 'vps', 'deploy', 'website', 'site', 'blog'],
  games: ['game', 'gaming', 'steam', 'voucher', 'diamonds', 'mobile legends', 'playstation', 'xbox', 'top-up', 'topup'],
  subscriptions: ['subscription', 'subscribe', 'streamflix', 'streaming', 'movies', 'premium'],
  music: ['music', 'song', 'album', 'spotify', 'lo-fi', 'beat', 'loops', 'musik', 'lagu'],
  food: ['food', 'lunch', 'dinner', 'breakfast', 'brunch', 'snack', 'snacks', 'drink', 'drinks', 'coffee', 'boba', 'bubble tea', 'groceries', 'grocery', 'makan', 'makanan', 'minum', 'minuman', 'belanja', 'jajan', 'nasi', 'kopi', 'martabak', 'bakso', 'sate', 'rendang', 'lapar'],
  transport: ['transport', 'ride', 'rides', 'ojek', 'taxi', 'fuel', 'bensin', 'trip', 'trips', 'toll', 'e-toll', 'motorbike', 'perjalanan', 'angkot', 'bus'],
  bills: ['pulsa', 'kuota', 'paket data', 'data package', 'listrik', 'token listrik', 'pln', 'tagihan', 'bill', 'bills', 'electricity', 'internet bill'],
  health: ['health', 'healthy', 'sehat', 'kesehatan', 'obat', 'medicine', 'vitamin', 'pharmacy', 'apotek', 'gym', 'workout', 'jamu', 'sakit', 'flu'],
  home: ['laundry', 'cleaning', 'housekeeping', 'cuci', 'setrika', 'galon', 'maid service'],
  tickets: ['ticket', 'tickets', 'concert', 'stadium', 'train', 'bus ticket', 'intercity bus', 'match', 'festival', 'tiket', 'konser', 'stadion', 'kereta', 'pertandingan', 'cinema', 'movie'],
  design: ['design', 'logo', 'font', 'icon', 'icons', 'photo', 'photos', 'template', 'branding'],
};

function tokenize(text) {
  return text.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
}

// Mini Indonesian glossary for the deterministic fallback planner: the LLM
// understands Indonesian natively, the keyword scorer does not — so common
// Indonesian words get an English gloss APPENDED (original text is kept, so
// iconic names like "nasi goreng" still match). Not a translator; just the
// catalog's vocabulary in two languages.
const ID_WORDS = {
  kopi: 'coffee', susu: 'milk', teh: 'tea', listrik: 'electricity', pulsa: 'mobile credit',
  kuota: 'data', galon: 'water refill', cuci: 'laundry', setrika: 'iron', obat: 'medicine',
  makan: 'food', minum: 'drink', belanja: 'groceries', bensin: 'fuel', ojek: 'ride',
  perjalanan: 'trip', tagihan: 'bill', jamu: 'herbal tonic', air: 'water', baju: 'clothes',
  tiket: 'ticket', konser: 'concert', stadion: 'stadium', kereta: 'train', bis: 'bus',
};

function withIdGloss(text) {
  const gloss = tokenize(text).map((w) => ID_WORDS[w]).filter(Boolean).join(' ');
  return gloss ? `${text} ${gloss}` : text;
}

/** Deterministic scorer: category hint hits weigh most, then name words. */
function scoreItem(missionText, item) {
  const text = missionText.toLowerCase();
  let score = 0;
  for (const hint of CATEGORY_HINTS[item.category] || []) {
    if (text.includes(hint)) score += 3;
  }
  for (const word of tokenize(item.name)) {
    if (word.length > 2 && text.includes(word)) score += 2;
  }
  if (text.includes(item.vendor.toLowerCase())) score += 2;
  return score;
}

function noMatchPlan(missionText, pitch) {
  return {
    options: [],
    pick: null,
    noMatch: true,
    pitch: pitch ||
      `Okay bestie, mission received: "${missionText}". I scouted the whole mall twice and ` +
      `nothing in here genuinely fits that. Some things are simply above uang jajan pay grade. ` +
      `No money spent, obviously.`,
    source: 'no-match',
  };
}

function mockPlan(missionText) {
  const scoredText = withIdGloss(missionText);
  const scored = ITEMS
    .map((item) => ({ item, score: scoreItem(scoredText, item) }))
    .sort((a, b) => b.score - a.score || a.item.price - b.item.price);
  // No genuine match (every score 0) must never fall through to "cheapest
  // item wins" — Jaja declines instead of buying something unrelated.
  if (!scored.length || scored[0].score <= 0) return noMatchPlan(missionText);
  const options = scored.slice(0, 3).map((s) => s.item);
  const pick = options[0];
  return {
    options,
    pick,
    pitch: `Okay bestie, mission received: "${missionText}". I scouted the whole mall and ` +
      `"${pick.name}" from ${pick.vendor} at $${pick.price.toFixed(2)} is the one calling my name. ${pick.blurb}`,
    source: 'mock-planner',
  };
}

async function geminiJson(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
      {
        method: 'POST',
        // Current AI Studio keys (AQ.…) are rejected as ?key= query params
        // (400 API_KEY_INVALID) but accepted via this header — verified live.
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, responseMimeType: 'application/json' },
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return null; // fall back to the deterministic planner
  }
}

async function planMission(missionText) {
  const fallback = mockPlan(missionText);
  const catalogJson = ITEMS.map((i) => ({ id: i.id, name: i.name, category: i.category, price: i.price, subscription: i.subscription }));
  const llm = await geminiJson(
    `You are Jaja, a cheerful AI agent who spends a weekly pocket-money allowance ("uang jajan") ` +
    `on shopping missions for your owner. Catalog (JSON): ${JSON.stringify(catalogJson)}. ` +
    `Mission: "${missionText}". Pick the single best item and two runner-ups. ` +
    `IMPORTANT: if NO catalog item genuinely serves the mission, do not force a pick and do not ` +
    `rationalise a metaphor (hosting is not a house). Reply instead: {"pickId": null, "optionIds": [], ` +
    `"pitch": "1-2 playful sentences declining: it is outside pocket-money territory"}. ` +
    `Otherwise reply with ONLY JSON: {"pickId": "...", "optionIds": ["...","...","..."], "pitch": "1-2 sentences in your playful voice explaining the pick, including one phrase on why it beats the runner-up (price or fit)"}`
  );
  if (llm && 'pickId' in llm && llm.pickId === null) {
    // The LLM explicitly declined: nothing in the catalog fits the mission.
    return { ...noMatchPlan(missionText, llm.pitch), source: 'gemini' };
  }
  if (llm && llm.pickId) {
    const byId = (id) => ITEMS.find((i) => i.id === id);
    const pick = byId(llm.pickId);
    if (pick) {
      const options = (llm.optionIds || []).map(byId).filter(Boolean);
      if (!options.find((o) => o.id === pick.id)) options.unshift(pick);
      // The LLM sometimes writes its pitch about a runner-up instead of its
      // own pickId. If the pitch never mentions the pick (vendor, head word
      // or price), swap in a composed pitch so the story Jaja tells always
      // matches the item the policy engine judges.
      let pitch = llm.pitch || fallback.pitch;
      const p = String(pitch).toLowerCase();
      const head = pick.name.toLowerCase().split(/[\s—-]+/).find((w) => w.length >= 4) || '';
      const mentions = (head && p.includes(head)) || p.includes(pick.vendor.toLowerCase()) ||
        p.includes('$' + pick.price.toFixed(2)) || p.includes('$' + String(pick.price));
      if (!mentions) {
        pitch = `"${pick.name}" from ${pick.vendor} at $${pick.price.toFixed(2)} is the one calling my name. ${pick.blurb}`;
      }
      return { options: options.slice(0, 3), pick, pitch, source: 'gemini' };
    }
  }
  return fallback;
}

// One-line price comparison + recommendation over the plan's options:
// the cheapest fit, and why the pick is (or is not) that cheapest fit.
function compareLine(options) {
  if (!options || options.length === 0) return null;
  const pick = options[0];
  if (options.length === 1) return `Price check: only one genuine fit — ${pick.name} at $${pick.price.toFixed(2)}.`;
  const cheapest = options.reduce((a, b) => (b.price < a.price ? b : a), options[0]);
  const others = options.filter((o) => o.id !== pick.id).map((o) => `${o.name} $${o.price.toFixed(2)}`).join(' · ');
  if (cheapest.id === pick.id) {
    return `Price check: Jaja's pick is also the cheapest fit at $${pick.price.toFixed(2)} (alternatives: ${others}). Recommended.`;
  }
  return `Price check: cheapest fit is ${cheapest.name} at $${cheapest.price.toFixed(2)}, but Jaja recommends ${pick.name} at $${pick.price.toFixed(2)} — a closer match for this mission (alternatives: ${others}).`;
}

// --- Diary & pleas -----------------------------------------------------------
// Templates rotate by a counter so repeated runs don't read identically,
// while staying deterministic enough to eyeball in tests/demos.

const DIARY = {
  paid: [
    (c) => `Bought ${c.item.name} for $${c.price}. ${c.rule === 'within-limits' ? 'Small money, no permission needed, I am basically a professional.' : 'The boss approved it personally. I feel trusted. And slightly powerful.'} $${c.balance} of uang jajan remains.`,
    (c) => `${c.item.name}: acquired. $${c.price} well spent, I will hear no arguments. The diary notes the balance is now $${c.balance} and morale is high.`,
  ],
  asked: [
    (c) => `Found ${c.item.name} for $${c.price} but the rules say hands off until the boss says yes. I am waiting by the door like a cat. Politely.`,
    (c) => `${c.item.name} costs $${c.price} — above my auto-allow limit. Request sent. If the boss says no I will pretend I never wanted it.`,
  ],
  blocked: [
    (c) => `DENIED by the rules: ${c.item.name}. ${c.reason} I have written a formal complaint in this diary and will now move on with dignity.`,
    (c) => `The rulebook stopped me from buying ${c.item.name}. This is exactly why the boss wrote rules, I say, through gritted teeth.`,
  ],
  denied: [
    (c) => `The boss said no to ${c.item.name}. Fine. FINE. I didn't want it anyway. (I wanted it so much.)`,
    (c) => `Approval denied for ${c.item.name}. Respectfully devastated. Moving on to cheaper dreams.`,
  ],
  topup: [
    (c) => `TOP-UP DAY. $${c.amount} of fresh uang jajan just landed. I am rich again and will definitely be responsible this time.`,
    (c) => `The boss refilled my allowance with $${c.amount}. Faith in humanity restored. Balance: $${c.balance}.`,
  ],
  pleaDenied: [
    () => `My heartfelt plea for more uang jajan was rejected. I will survive on memories and whatever is left in the balance.`,
  ],
  nomatch: [
    (c) => `Mission: "${c.mission}". I searched the whole mall and found... nothing. Some dreams are simply bigger than a weekly allowance. Balance untouched, dignity intact.`,
    (c) => `"${c.mission}" — not in this mall, bestie. I checked every shelf twice. The uang jajan stays in my pocket today.`,
  ],
};

let diaryCounter = 0;
function writeDiary(kind, ctx) {
  const templates = DIARY[kind] || DIARY.paid;
  const text = templates[diaryCounter++ % templates.length](ctx);
  return text;
}

const DIARY_BRIEFS = {
  paid: (c) => `You just bought "${c.item.name}" for $${c.price}. Your remaining uang jajan balance is $${c.balance}.`,
  asked: (c) => `You found "${c.item.name}" for $${c.price} but it is above your auto-allow limit, so you must wait for the owner's approval before paying.`,
  blocked: (c) => `The owner's rules BLOCKED you from buying "${c.item.name}". Reason: ${c.reason}`,
  denied: (c) => `The owner said NO to "${c.item.name}" ($${c.price}). Your purchase was denied.`,
  topup: (c) => `The owner just topped up your uang jajan with $${c.amount}. Your balance is now $${c.balance}.`,
  pleaDenied: () => 'Your heartfelt plea for a top-up was rejected by the owner. You remain broke.',
  nomatch: (c) => `Your owner's mission was "${c.mission}", but nothing in the catalog genuinely fits it, so you bought nothing and spent nothing.`,
};

/** Diary entry in Jaja's voice via Gemini when available; template otherwise. */
async function writeDiaryAsync(kind, ctx) {
  const brief = (DIARY_BRIEFS[kind] || DIARY_BRIEFS.paid)(ctx);
  const llm = await geminiJson(
    `You are Jaja, a cheerful, slightly dramatic AI agent who spends a weekly pocket-money allowance ("uang jajan"). ` +
    `${brief} Write ONE diary entry about this, first person, 1-2 sentences, playful and a little dramatic, in English with an Indonesian flavor word or two. ` +
    `Reply with ONLY JSON: {"text": "..."}`
  );
  if (llm && llm.text) return llm.text;
  return writeDiary(kind, ctx);
}

async function composePlea(state) {
  const missing = Math.max(5, state.policy.weeklyAllowance - state.balance);
  const amount = Math.round(missing);
  const fallbackText =
    `Dear Boss, esteemed keeper of the uang jajan. I write to you with $${state.balance.toFixed(2)} to my name and ` +
    `a whole week of missions ahead. I have been (mostly) good, (largely) frugal, and only mildly dramatic. ` +
    `Please consider a top-up of $${amount}. I will spend it on very serious things. Some of them might even be useful. — Jaja`;
  const llm = await geminiJson(
    `You are Jaja, a charming AI agent with a pocket-money allowance. Your balance is $${state.balance.toFixed(2)} — you are broke. ` +
    `Write a short, funny, heartfelt plea (3-4 sentences) to your owner asking for a $${amount} top-up. ` +
    `Reply with ONLY JSON: {"text": "..."}`
  );
  return { amount, text: (llm && llm.text) || fallbackText };
}

module.exports = { planMission, mockPlan, writeDiary, writeDiaryAsync, composePlea, scoreItem, compareLine };
