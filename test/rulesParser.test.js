'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRules } = require('../src/rulesParser');

test('ask-first threshold sets the auto-allow ceiling', () => {
  const { updates, understood } = parseRules('ask me first above $15');
  assert.equal(updates.maxPerPurchase, 15);
  assert.equal(understood.length, 1);
});

test('no subscriptions bans them', () => {
  const { updates } = parseRules('no subscriptions, ever');
  assert.equal(updates.blockSubscriptions, true);
});

test('allow subscriptions lifts the ban', () => {
  const { updates } = parseRules('subscriptions are fine');
  assert.equal(updates.blockSubscriptions, false);
});

test('category monthly cap is parsed', () => {
  const { updates } = parseRules('games max $20 a month');
  assert.equal(updates.categoryCaps.games, 20);
});

test('hard ceiling blocks above the amount', () => {
  const { updates } = parseRules('never spend more than $40');
  assert.equal(updates.askAbove, 40);
});

test('category ban is parsed', () => {
  const { updates } = parseRules('block hosting');
  assert.deepEqual(updates.blockedCategories, ['hosting']);
});

test('weekly allowance is parsed', () => {
  const { updates } = parseRules('weekly allowance $50');
  assert.equal(updates.weeklyAllowance, 50);
});

test('the full demo sentence parses all four rules', () => {
  const { updates, understood } = parseRules(
    'ask me first above $15, no subscriptions, games max $20 a month, never spend more than $40',
  );
  assert.equal(updates.maxPerPurchase, 15);
  assert.equal(updates.blockSubscriptions, true);
  assert.equal(updates.categoryCaps.games, 20);
  assert.equal(updates.askAbove, 40);
  assert.equal(understood.length, 4);
});

test('gibberish yields no updates', () => {
  const { updates, understood } = parseRules('hello jaja how are you');
  assert.deepEqual(updates, {});
  assert.deepEqual(understood, []);
});
