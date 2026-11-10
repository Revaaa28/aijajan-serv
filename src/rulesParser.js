'use strict';

/**
 * rulesParser.js — teach Jaja rules in plain language.
 *
 * The owner types rules the way they would say them ("ask me first above
 * $15, no subscriptions, games max $20 a month") and this deterministic
 * parser turns them into structured policy fields. No LLM involved: the
 * translation itself must be predictable, because the whole point of
 * AIJajan is that the rule layer cannot be talked into anything.
 *
 * Returns { updates, understood } — `updates` is a partial policy object,
 * `understood` is a list of human-readable lines echoing what was heard.
 */

const CATEGORIES = ['domains', 'hosting', 'games', 'subscriptions', 'music', 'design', 'food', 'transport', 'bills', 'health', 'home', 'tickets'];

function moneyAfter(text, regex) {
  const m = text.match(regex);
  return m ? Number(m[1]) : null;
}

function parseRules(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  const updates = {};
  const understood = [];

  // Hard ceiling: "never (spend|pay) more than $X", "nothing above $X",
  // "max $X per purchase", "block anything over $X".
  const hard = moneyAfter(t, /(?:never|nothing|block anything|no purchase)[^$]{0,24}\$(\d+(?:\.\d{1,2})?)/)
    ?? moneyAfter(t, /(?:max|maximum|at most)\s*\$(\d+(?:\.\d{1,2})?)\s*(?:per purchase|a purchase|per buy)/);
  if (hard !== null) {
    updates.askAbove = hard;
    understood.push(`Hard ceiling: anything above $${hard} is blocked outright.`);
  }

  // Ask-first threshold: "ask (me) first above $X", "over $X ask me",
  // "above $X ask first". Sets the auto-allow ceiling.
  const ask = moneyAfter(t, /ask[^$]{0,20}(?:above|over)\s*\$(\d+(?:\.\d{1,2})?)/)
    ?? moneyAfter(t, /(?:above|over)\s*\$(\d+(?:\.\d{1,2})?)[^.]{0,20}ask/)
    ?? moneyAfter(t, /(?:above|over)\s*\$(\d+(?:\.\d{1,2})?)\s*(?:needs|requires) approval/);
  if (ask !== null) {
    updates.maxPerPurchase = ask;
    understood.push(`Auto-allow up to $${ask}; above that Jaja must ask first.`);
  }

  // Subscriptions.
  if (/(no|never|ban|block|banning|blocking)[^.]{0,16}subscription/.test(t) || /no auto-?renew/.test(t)) {
    updates.blockSubscriptions = true;
    understood.push('Subscriptions and auto-renewals are banned.');
  } else if (/allow subscriptions/.test(t) || /subscriptions? (are )?(ok|okay|fine|allowed)/.test(t)) {
    updates.blockSubscriptions = false;
    understood.push('Subscriptions are allowed.');
  }

  // Per-category monthly caps: "games max $20 a month", "$20/month for games",
  // "music budget $10 monthly". The subscriptions category is handled by the
  // dedicated rule above, so it is skipped here (otherwise "no subscriptions,
  // games max $20 a month" would also invent a subscriptions cap and ban).
  for (const cat of CATEGORIES) {
    if (cat === 'subscriptions') continue;
    const cap = moneyAfter(t, new RegExp(`${cat}[^$,]{0,20}\\$(\\d+(?:\\.\\d{1,2})?)\\s*(?:a month|/month|per month|monthly)`))
      ?? moneyAfter(t, new RegExp(`\\$(\\d+(?:\\.\\d{1,2})?)\\s*(?:a month|/month|per month|monthly)[^a-z]{0,12}(?:for|on)\\s+${cat}`))
      ?? moneyAfter(t, new RegExp(`${cat}[^$]{0,10}(?:budget|cap)[^$]{0,6}\\$(\\d+(?:\\.\\d{1,2})?)`));
    if (cap !== null) {
      updates.categoryCaps = { ...(updates.categoryCaps || {}), [cat]: cap };
      understood.push(`${cat} capped at $${cap} per month.`);
    }
    // Category bans: "no games", "block hosting", "never buy domains".
    if (new RegExp(`(?:no|block|ban|never buy)\\s+${cat}\\b`).test(t)) {
      updates.blockedCategories = [...(updates.blockedCategories || []), cat];
      understood.push(`${cat} is blocked entirely.`);
    }
  }

  // Weekly allowance: "weekly allowance $50", "uang jajan $50 a week".
  const weekly = moneyAfter(t, /(?:weekly allowance|allowance|uang jajan)[^$]{0,12}\$(\d+(?:\.\d{1,2})?)/)
    ?? moneyAfter(t, /\$(\d+(?:\.\d{1,2})?)\s*(?:a week|per week|weekly)/);
  if (weekly !== null) {
    updates.weeklyAllowance = weekly;
    understood.push(`Weekly allowance set to $${weekly}.`);
  }

  return { updates, understood };
}

module.exports = { parseRules };
