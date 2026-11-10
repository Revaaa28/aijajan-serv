'use strict';

/**
 * paypal.js — PayPal sandbox REST client.
 *
 * Two modes:
 *   MOCK (PAYPAL_MOCK=1, or credentials missing): fully simulated — realistic
 *     fake order/payout IDs and small latencies, zero network calls. This is
 *     how judges can run the whole flow with no PayPal account at all.
 *   LIVE SANDBOX: real calls to api-m.sandbox.paypal.com — OAuth client
 *     credentials token, Orders v2 create + capture, Payouts for top-ups.
 *
 * Nothing in here ever touches the live (production) PayPal API.
 */

const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function fakeId(prefix) {
  const rand = Array.from({ length: 12 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
  return `${prefix}-${rand}`;
}

function createPayPalClient(env = process.env) {
  const clientId = env.PAYPAL_CLIENT_ID;
  const clientSecret = env.PAYPAL_CLIENT_SECRET;
  const mock = env.PAYPAL_MOCK === '1' || !clientId || !clientSecret;

  if (mock) {
    return {
      mode: 'mock',
      /** Simulate creating + capturing a checkout order for an item. */
      async payForItem(item) {
        await sleep(250 + Math.random() * 350);
        const orderId = fakeId('MOCK-ORDER');
        await sleep(150);
        return { orderId, captureId: fakeId('MOCK-CAPTURE'), status: 'COMPLETED', payer: 'jaja-sandbox-buyer' };
      },
      /** Simulate the owner topping up Jaja's allowance (a payout in reverse). */
      async topUp(amount) {
        await sleep(250 + Math.random() * 250);
        return { payoutId: fakeId('MOCK-PAYOUT'), status: 'SUCCESS', amount };
      },
    };
  }

  // --- Live sandbox ---------------------------------------------------------
  let tokenCache = { token: null, expiresAt: 0 };

  async function accessToken() {
    if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
    const res = await fetch(`${SANDBOX_BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`PayPal OAuth failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
    return tokenCache.token;
  }

  async function api(pathName, options = {}) {
    const token = await accessToken();
    const res = await fetch(`${SANDBOX_BASE}${pathName}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    if (!res.ok) throw new Error(`PayPal ${pathName} failed: ${res.status} ${await res.text()}`);
    return res.status === 204 ? {} : res.json();
  }

  // Agent disbursements settle over the Payouts API, not Checkout: an
  // autonomous agent has no human sitting at a checkout page to approve an
  // order (capture would fail with ORDER_NOT_APPROVED). The policy engine in
  // policy.js IS the approval layer; once it says ALLOW (or the owner
  // approves an ASK), the payout executes server-side.
  const merchantReceiver = env.PAYPAL_PAYOUT_RECEIVER || 'merchants@aijajan.example';

  async function sendPayout(receiver, amount, note) {
    const batch = await api('/v1/payments/payouts', {
      method: 'POST',
      body: JSON.stringify({
        sender_batch_header: { sender_batch_id: `aijajan-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, email_subject: 'AIJajan payment' },
        items: [{
          recipient_type: 'EMAIL',
          amount: { value: amount.toFixed(2), currency: 'USD' },
          receiver,
          note,
        }],
      }),
    });
    const batchId = batch?.batch_header?.payout_batch_id || null;
    let itemId = null;
    let txStatus = batch?.batch_header?.batch_status || 'PENDING';
    if (batchId) {
      try {
        const detail = await api(`/v1/payments/payouts/${batchId}`, { method: 'GET' });
        const item = detail?.items?.[0];
        itemId = item?.payout_item_id || null;
        txStatus = item?.transaction_status || txStatus;
      } catch { /* batch id alone is enough for the audit trail */ }
    }
    return { batchId, itemId, txStatus };
  }

  return {
    mode: 'sandbox',
    async payForItem(item) {
      const { batchId, itemId, txStatus } = await sendPayout(
        merchantReceiver,
        item.price,
        `AIJajan: ${item.name} (${item.vendor})`,
      );
      return { orderId: itemId || batchId, captureId: batchId, status: txStatus, payer: 'jaja-agent-wallet' };
    },
    async topUp(amount) {
      // In the sandbox demo the "top-up" is a payout from the app account to
      // Jaja's sandbox wallet. Kept as one call so the flow stays demo-simple.
      const payout = await api('/v1/payments/payouts', {
        method: 'POST',
        body: JSON.stringify({
          sender_batch_header: { sender_batch_id: `aijajan-${Date.now()}`, email_subject: 'Uang jajan top-up' },
          items: [{
            recipient_type: 'EMAIL',
            amount: { value: amount.toFixed(2), currency: 'USD' },
            receiver: 'jaja-agent@aijajan.example',
            note: 'Weekly uang jajan top-up',
          }],
        }),
      });
      return { payoutId: payout?.batch_header?.payout_batch_id || null, status: payout?.batch_header?.batch_status || 'PENDING', amount };
    },
  };
}

module.exports = { createPayPalClient };
