# AIJajan — SERV Edition (Kite track)

AIJajan gives an AI agent a weekly pocket-money allowance. The owner writes spending rules in plain language; a deterministic policy engine turns them into law. In this SERV Edition, OpenServ's **SERV Reasoning** is the agent's planning brain: for every mission, SERV reads the catalog and proposes a purchase plan with reasons; the policy engine then rules **ALLOW / ASK / BLOCK** per item — only approved items are paid (PayPal; sandbox/mock in the public demo). Every plan is rendered as an auditable **reasoning trace** (phases, proposal vs. verdict, model, tokens, cost) and cross-referenced in the audit log by trace ID. A kill switch freezes the wallet instantly.

**The key design decision: the owner's rules are never sent to SERV.** SERV proposes blind; the policy engine alone decides money. In live testing, sending the rules made SERV pre-decline missions itself and the engine never ruled — a separation-of-powers leak we removed. SERV's raw responses vary in shape between calls, so a structural normalizer validates every proposed item ID against the catalog: the agent can never invent products. If SERV errors or times out, a built-in planner takes over and the fallback is recorded in the audit log.

**Built during the hackathon (Nov 10–16, 2026):** the SERV Reasoning integration (`src/serv.js`), the reasoning trace panel, the audit cross-reference, 14 new tests, and this edition's separate deployment.
**Pre-existing (PayPal AI Hackathon, Nov 9):** the base app — policy engine, catalog, wallet, spending diary — reused unchanged. Cross-entry verified against both rule sets: PayPal's rules contain no exclusivity clause, and SERV explicitly allows existing projects with a meaningful new feature.

**Live proof (real SERV API):** three smoke missions — a nasi goreng voucher (ALLOW, paid $50.00 → $43.50), a music subscription SERV proposed and policy BLOCKED (`no-subscriptions`), and "buy me a house" (SERV declined honestly, $0 spent). Total SERV cost of all development and testing: under $0.05.

- Live demo: https://aijajan-serv.onrender.com
- Demo video: https://youtu.be/Ur-3E4z-8ss
- Track: Kite (agents with verifiable identity and spending limits that shop and pay safely)
