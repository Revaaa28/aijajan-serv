'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mockPlan } = require('../src/agent');

test('mission with no catalog fit is declined, not force-matched', () => {
  const plan = mockPlan('Buy me a house');
  assert.equal(plan.noMatch, true);
  assert.equal(plan.pick, null);
  assert.equal(plan.options.length, 0);
});

test('food mission picks a food voucher (English)', () => {
  const plan = mockPlan('Buy me lunch and something to drink');
  assert.equal(plan.noMatch, undefined);
  assert.equal(plan.pick.category, 'food');
});

test('food mission picks a food voucher (Indonesian)', () => {
  const plan = mockPlan('beli makanan dan minuman online');
  assert.equal(plan.pick.category, 'food');
});

test('everyday missions pick their categories', () => {
  assert.equal(mockPlan('beli token listrik sebelum habis').pick.category, 'bills');
  assert.equal(mockPlan('book a ride across town').pick.category, 'transport');
  assert.equal(mockPlan('buy me vitamins, I feel a flu coming').pick.category, 'health');
  assert.equal(mockPlan('laundry voucher please, mine is piling up').pick.category, 'home');
});

test('buying a house is still declined (a house is not home services)', () => {
  assert.equal(mockPlan('beli rumah untuk keluarga').noMatch, true);
});

test('fallback planner understands Indonesian at item level', () => {
  assert.equal(mockPlan('beli kopi susu').pick.id, 'fod-02');
  assert.equal(mockPlan('beli galon air').pick.id, 'hom-03');
  assert.equal(mockPlan('cuci baju seminggu numpuk').pick.id, 'hom-01');
  assert.equal(mockPlan('nasi goreng satu porsi').pick.id, 'fod-01');
});

test('compareLine recommends honestly on price', () => {
  const { compareLine } = require('../src/agent');
  const cheap = { id: 'a', name: 'Cheap', price: 5 };
  const pricey = { id: 'b', name: 'Pricey', price: 9 };
  assert.match(compareLine([cheap, pricey]), /cheapest fit/);
  assert.match(compareLine([pricey, cheap]), /recommends Pricey/);
  assert.match(compareLine([cheap]), /only one genuine fit/);
  assert.equal(compareLine([]), null);
});

test('ticket missions pick tickets in both languages', () => {
  assert.equal(mockPlan('buy me a concert ticket').pick.id, 'tic-01');
  assert.equal(mockPlan('beli tiket kereta ke kota sebelah').pick.id, 'tic-03');
  assert.equal(mockPlan('tiket ke stadion buat nonton pertandingan').pick.id, 'tic-02');
  assert.equal(mockPlan('get me an intercity bus ticket').pick.id, 'tic-04');
});

test('domain mission still picks a domain', () => {
  const plan = mockPlan('Buy me a cheap domain for my bakery');
  assert.equal(plan.pick.category, 'domains');
});

test('game mission still picks a game voucher', () => {
  const plan = mockPlan('Get me a game voucher, I had a long week');
  assert.equal(plan.pick.category, 'games');
});
