# AIJajan — SERV Edition: design notes

**Event:** OpenServ SERV Hackathon — Edition 02, **Kite track** ("Build agents
with a verifiable identity and spending limits you control, so it can shop,
book, and pay on your behalf, safely.")
**Deadline:** final submission Mon 2026-11-16 07:59 WITA.
**Status of this document:** the real SERV adapter is **live-proven**
(2026-11-10): endpoint chosen from live probes, three-mission smoke run
through the real server passed (ALLOW paid, subscription BLOCKed by
policy, house honestly declined), and the fallback path is verified.
Remaining: GitHub repo, separate deploy, demo video, final submission.

---

## 1. The design: SERV is the brain, the policy engine is the law

The Kite track asks for an agent that can spend on your behalf *safely*.
AIJajan's answer is a strict separation of powers, in three layers:

```
  mission (plain words, EN/ID)
        │
        ▼
  ┌─────────────────────┐   plans + explains; returns DATA, never decisions
  │  SERV Reasoning     │   steps[]  — auditable reasoning trace
  │  (src/serv.js)      │   proposal[] — ranked items, each with a reason
  └─────────────────────┘
        │  every proposed item, one by one
        ▼
  ┌─────────────────────┐   deterministic code, NOT an LLM; cannot be
  │  Policy engine      │   sweet-talked, prompt-injected or bargained with
  │  (src/policy.js)    │   verdicts: ALLOW / ASK / BLOCK, rule cited
  └─────────────────────┘
        │  ALLOW, or ASK + owner approval
        ▼
  ┌─────────────────────┐   PayPal sandbox payouts (the agent-disbursement
  │  PayPal (sandbox)   │   rail, because an autonomous agent has no human
  │  (src/paypal.js)    │   sitting at a checkout page to approve orders)
  └─────────────────────┘
```

Why this split is the product, not an implementation detail:

- **Reasoning is persuasive; law must not be.** A reasoning layer is
  exactly the component that can be talked into things — by a mission
  text, by a poisoned catalog description, by its own enthusiasm. So it
  is given *zero* authority: `serv.js` returns a plan object; it holds no
  reference to the payment client, and `server.js` only ever pays for
  items that `policy.evaluate()` returned ALLOW for (or that the owner
  approved after an ASK).
- **Auditability is the trust mechanism.** Every mission produces a trace
  (id `serv-…`) containing the reasoning steps and the proposal; the
  policy engine's verdict per item is attached to the same trace; the
  audit log gets a `serv-plan` entry carrying the same trace id. An owner
  (or a judge) can reconstruct *why the agent wanted something, what the
  rules said about each item, and what actually happened* — the Kite
  track's "spending limits you control" made inspectable.
- **SERV explains risks; the engine enforces them.** The mock trace's
  proposal reasons already flag e.g. auto-renewing items ("SERV flags it;
  whether that is allowed is the policy engine's call"). Explanation and
  enforcement are deliberately different voices.
- **Degradation is safe.** If SERV is unreachable, `server.js` falls back
  to the built-in deterministic planner for drafting, and the trace panel
  shows a `fallback` step saying so. The policy engine judges the fallback
  plan identically. There is no failure mode in which a planner outage
  becomes a spending spree.

## 2. What was built during this hackathon vs. what pre-existed

Honest split, as the SERV FAQ requires ("explain what you built during
the hackathon"). The SERV FAQ explicitly allows existing projects with a
meaningful new feature; this section is that explanation.

**Built for this hackathon (SERV Edition, in `~/workspace/aijajan-serv`):**

- `src/serv.js` — the SERV Reasoning layer: `planMission(mission, ctx)`
  returning `{ traceId, steps, proposal, options, pick, pitch, noMatch }`;
  a deterministic mock reasoning engine (full traces, offline) behind
  `SERV_MOCK`, mirroring the existing `PAYPAL_MOCK` pattern; the live
  transport isolated in `callServApi()` + `normalizeServResponse()`.
- `server.js` mission flow rewired: SERV plans first; trace built and
  persisted (`state.lastTrace`); a `serv-plan` audit entry with the trace
  id on every mission; per-item policy verdicts recorded onto the trace;
  trace outcome (`paid` / `ask` / `blocked` / `no-match` /
  `payment-failed`) and order id attached; planner fallback path.
- UI: the **Reasoning trace panel** (timeline of SERV steps, proposal →
  policy-verdict rows with reasons, outcome banner), reasoning steps
  rendered inline in the mission feed with phase chips, a "SERV
  Reasoning: mock/live" header badge, and updated how-it-works copy.
- `test/serv.test.js` (9 tests) + `test/servFlow.test.js` (5 end-to-end
  tests) — see §4.
- `SERV-DESIGN.md` (this file), the README's SERV Edition section, and
  `.env.example` SERV configuration.

**Pre-existing (the original AIJajan, submitted to the PayPal AI
Hackathon; copied unchanged except where the integration required it):**

- The concept, Jaja's character/voice, and the app skeleton (Express,
  zero deps beyond express).
- `src/policy.js` — the deterministic policy engine (**untouched**: the
  law did not need amending to gain a brain).
- `src/paypal.js` — PayPal sandbox client, mock + live payout modes
  (untouched).
- `src/catalog.js` — the 47-item catalog (untouched).
- `src/agent.js` — diary voice, pleas, and the deterministic keyword
  scorer. Unchanged; the SERV mock engine reuses its scorer for
  shortlisting, and it remains the fallback planner + diary voice.
- `src/rulesParser.js` — plain-words rules → policy (untouched).
- The base UI (tabs, catalog, rules, diary, audit log, dark mode) and the
  original 28 tests.

`~/workspace/aijajan` (the PayPal submission) is **not** modified by any
of this — the SERV edition is a separate copy with its own git history.

## 3. How mock mode works (and why judges can trust it)

`SERV_MOCK=1` (or no `SERV_API_KEY`) selects the local reasoning engine.
It is deterministic — the same mission + policy + balance yields a
byte-identical trace, including the trace id (a hash of those inputs) —
so demos and tests are reproducible. The engine shortlists with the same
proven scorer as the original planner, then composes the trace around
the result: intent, catalog scan, a head-to-head price/fit comparison, a
*rules preview* (explicitly labelled narration-only), and the proposal
with a reason per item. Nothing about the gating changes in mock mode:
the tests below run the real engine against real SERV-mode plans.

## 4. Tests — 42 passing (`npm test`)

Pre-existing suites (28): policy engine, rules parser, planner.

New (14):

- `serv.test.js` — client mode selection (mock/live, mirroring
  PAYPAL_MOCK); trace shape (5 phases, explained proposal); determinism;
  honest decline on unservable missions; **a SERV-proposed item in an
  owner-blocked category is BLOCKed (`blocked-category`)**; a
  SERV-proposed subscription is BLOCKed (`no-subscriptions`) while SERV's
  own reason flags the auto-renew risk; **kill switch BLOCKs every SERV
  proposal (`kill-switch`)**; ASK path preserved; balance law
  (`insufficient-allowance`).
- `servFlow.test.js` — spawns the real server in full mock mode and
  drives it over HTTP: a paid mission leaves the trace in the response,
  in persisted state, and cross-referenced in the audit log
  (`servTraceId`), with the balance moving exactly once; subscription
  blocked end-to-end with balance untouched; kill switch wins
  end-to-end; owner-blocked category vetoes end-to-end; no-match mission
  still leaves a trace and spends nothing.

Note on rule interaction the tests document: the engine checks the
subscription ban *before* the blocked-category list (documented order in
policy.js), so a subscription item in a blocked category cites
`no-subscriptions`. Both block; the citation differs.

## 5. Live adapter — proven 2026-11-10

**Endpoint: `POST /v1/chat/completions`** on
`https://inference-api.openserv.ai` (OpenAI-compatible, Bearer key,
system message required). `/v1/responses` was probed first and rejected
on evidence: it refuses `google/gemini-2.5-flash` outright ("not
available on the Responses API"), and for a model it accepts
(`openai/gpt-5.4-nano`) the reply held only a message item with
`reasoning_tokens: 0` — no reasoning item exists to surface. SERV's
reasoning runs server-side and exposes **no trace/steps field on either
endpoint**; the UI trace therefore stays OUR 5-phase structure, filled
with the reasoning sentences the model returns, with the call's usage
(model, tokens, latency, estimated cost) attached to the trace and
written into the audit log (`serv-plan` entry, `servUsage` detail) as
the evidence SERV was really consulted.

**Default model:** `google/gemini-2.5-flash` (override `SERV_MODEL`),
temperature 0.3, `max_tokens` 1500, timeout 45s (`SERV_TIMEOUT_MS`).
Estimated cost uses the docs' per-1M-token price table.

**The gateway's reply schema is not stable.** Across ~15 probed calls it
varied constantly: items under `proposal | proposals | proposed_items |
selected_items`, as a nested `proposal.items`, or as a single
`proposal`/`selection` object; ids as `itemId | item_id | id`; reasoning
as a steps array, a string array (under `reasoning`, `reasoning_phases`,
…), or a phase-keyed object (under `reasoning | planning | phases`,
values as strings or `{ explanation }` objects, keys in the gateway's
own wording); risks as a list or per-item `item_risks` maps; declines as
`pickId: null`, an `outcome: "declined"` object, or a `decline` /
`decline_reason` string. `normalizeServResponse()` therefore extracts
structurally (known keys → generic structural fallbacks) and validates
every id against the catalog — unverifiable entries are dropped, never
invented. Two design decisions came out of probing:

- **The owner's rules are NOT sent to SERV.** Told "subscriptions are
  banned", the gateway declined a subscription mission itself and the
  policy engine never ruled — a separation-of-powers leak. SERV now
  gets the mission, the catalog and the balance only, plus the
  instruction to propose genuine fits and flag visible risks instead of
  pre-applying rules. Verdicts belong to the engine alone.
- **Any SERV failure falls back safely.** Timeout/401/bad JSON/shapeless
  reply → `server.js` uses the built-in planner (identical policy
  gating) and records a `serv-fallback` audit entry. Verified live with
  a deliberately bogus key: mission still paid, fallback audited, no
  trace fabricated.

**Live smoke (real server, SERV live, PayPal mock), all PASS:**
`Buy me a nasi goreng voucher` → SERV proposed fod-01 → ALLOW
(`within-limits`) → paid, balance $50 → $43.50, exactly one purchase in
the audit log (2,503 tokens, ≈$0.0015, 3.0s). `Subscribe me to a music
streaming premium plan` → SERV proposed mus-03 → **BLOCK
(`no-subscriptions`)**, balance untouched (3,249 tokens, ≈$0.0014).
`Buy me a house` → SERV declined honestly → no-match, $0 spent
(3,219 tokens, ≈$0.0014). Smoke total: **8,971 tokens ≈ $0.0043**;
including all development probing, total live spend stayed under $0.05
of the $1.00 account balance.

## 6. Remaining work (in order)

1. ~~Real API adapter~~ — done and live-proven, see §5. `npm test`
   still passes 42/42 in mock mode, unchanged.
2. ~~GitHub repo~~ — done 2026-11-10:
   https://github.com/Revaaa28/aijajan-serv (public, hygiene-verified:
   `.env` gitignored and absent, no secret values in any tracked file).
   The PayPal repo stays separate and untouched.
3. **Deploy** a separate instance (e.g. a second Render service) so the
   SERV demo is live without disturbing the PayPal demo; set
   `PAYPAL_MOCK` per the demo plan and `SERV_MOCK=0` + the key once the
   adapter is verified.
4. **Demo video** (< 3 min): one ALLOW (nasi goreng), one SERV-proposed
   subscription getting BLOCKed with the trace panel visible, kill
   switch on → everything BLOCKed, and the audit log cross-reference.
   Brainstorm/script with Rev before recording (standing rule).
5. **Final submission** before Mon 2026-11-16 07:59 WITA: form links
   (repo, live demo, video, X post tagging @openservai — the
   registration post already exists from signup), and a write-up that
   reuses §2's honest split verbatim in substance.
6. Watch for the prize-pool breakdown announcement (TBA at registration)
   to confirm the entry's upside before investing in polish beyond this.
