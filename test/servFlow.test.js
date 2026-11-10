'use strict';

/**
 * servFlow.test.js — end-to-end over HTTP: the real server, SERV in mock
 * mode, PayPal in mock mode. Proves the integrated claims of the SERV
 * edition: every mission leaves an auditable SERV trace (in the response,
 * in persisted state, and cross-referenced from the audit log), and the
 * policy engine's verdicts — ALLOW, BLOCK, kill switch — are unchanged.
 *
 * The server's data/state.json is backed up before and restored after.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'data', 'state.json');
const PORT = 3477;
const BASE = `http://127.0.0.1:${PORT}`;

let child = null;
let stateBackup = null;

async function post(pathName, body) {
  const res = await fetch(BASE + pathName, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, data: await res.json() };
}

async function getState() {
  const res = await fetch(BASE + '/api/state');
  return res.json();
}

before(async () => {
  stateBackup = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE) : null;
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SERV_MOCK: '1', PAYPAL_MOCK: '1', SERV_API_KEY: '', GEMINI_API_KEY: '' },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) {
        const health = await res.json();
        assert.equal(health.servMode, 'mock');
        return;
      }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start in time');
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(() => {
  if (child) child.kill();
  if (stateBackup === null) { try { fs.unlinkSync(STATE_FILE); } catch { /* already gone */ } }
  else fs.writeFileSync(STATE_FILE, stateBackup);
});

test('paid mission: trace in response, state and audit — balance moves once', async () => {
  await post('/api/reset');
  const { data } = await post('/api/mission', { text: 'Buy me a nasi goreng voucher' });
  assert.equal(data.outcome, 'paid');
  assert.match(data.trace.traceId, /^serv-/);
  assert.equal(data.trace.outcome, 'paid');
  assert.equal(data.trace.decisions[0].decision, 'ALLOW');
  assert.ok(data.trace.reasoning.length >= 5);
  // Feed shows the reasoning steps inline too.
  assert.ok(data.steps.some((s) => s.kind === 'reason' && s.phase === 'propose'));

  const state = await getState();
  assert.equal(state.balance, 43.5);
  assert.equal(state.servTrace.traceId, data.trace.traceId);
  const auditEntry = state.audit.find((a) => a.type === 'serv-plan');
  assert.ok(auditEntry, 'audit log has a serv-plan entry');
  assert.equal(auditEntry.servTraceId, data.trace.traceId);
  assert.match(auditEntry.detail, /reasoning steps/);
});

test('SERV-proposed subscription is blocked end-to-end; balance untouched', async () => {
  await post('/api/reset');
  const { data } = await post('/api/mission', { text: 'Subscribe me to a music streaming premium plan' });
  assert.equal(data.outcome, 'blocked');
  assert.equal(data.trace.decisions[0].rule, 'no-subscriptions');
  const state = await getState();
  assert.equal(state.balance, 50);
  assert.equal(state.servTrace.outcome, 'blocked');
});

test('kill switch wins end-to-end over SERV proposals', async () => {
  await post('/api/reset');
  await post('/api/freeze', { frozen: true });
  const { data } = await post('/api/mission', { text: 'Buy me lunch' });
  assert.equal(data.outcome, 'blocked');
  assert.ok(data.trace.decisions.length > 0);
  assert.ok(data.trace.decisions.every((d) => d.rule === 'kill-switch'));
  await post('/api/freeze', { frozen: false });
  const state = await getState();
  assert.equal(state.balance, 50);
});

test('owner-blocked category vetoes the SERV proposal end-to-end', async () => {
  await post('/api/reset');
  await post('/api/policy', { blockedCategories: ['games'] });
  const { data } = await post('/api/mission', { text: 'Get me a game voucher, I had a long week' });
  assert.equal(data.outcome, 'blocked');
  assert.equal(data.trace.decisions[0].rule, 'blocked-category');
});

test('no-match mission still leaves a trace and spends nothing', async () => {
  await post('/api/reset');
  const { data } = await post('/api/mission', { text: 'Buy me a house' });
  assert.equal(data.outcome, 'no-match');
  assert.equal(data.trace.outcome, 'no-match');
  assert.deepEqual(data.trace.proposal, []);
  const state = await getState();
  assert.equal(state.balance, 50);
});
