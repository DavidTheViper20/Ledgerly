'use strict';

// Pass B — report library (#/reports) redesign: pure helpers for search
// filtering and favourite toggling, plus the report_favourites setting default.

const { test } = require('node:test');
const assert = require('node:assert');

const { filterReports, toggleFavourite, parseFavourites } = require('../src/services/report-library');
const { DEFAULT_SETTINGS } = require('../src/db');

const REPORTS = [
  { route: '#/reports/profit-loss', name: 'Profit and Loss', description: 'Income, expenses and profit over a period' },
  { route: '#/reports/balance-sheet', name: 'Balance Sheet', description: 'Assets, liabilities and equity at a date' },
  { route: '#/reports/tax', name: 'Tax Summary', description: 'GST collected on sales and paid on purchases' },
];

// ---------- filterReports ----------

test('filterReports: matches by name case-insensitively', () => {
  const r = filterReports(REPORTS, 'profit');
  assert.equal(r.length, 1);
  assert.equal(r[0].route, '#/reports/profit-loss');

  const r2 = filterReports(REPORTS, 'PROFIT');
  assert.equal(r2.length, 1);
  assert.equal(r2[0].route, '#/reports/profit-loss');
});

test('filterReports: matches by description case-insensitively', () => {
  const r = filterReports(REPORTS, 'liabilities');
  assert.equal(r.length, 1);
  assert.equal(r[0].route, '#/reports/balance-sheet');

  const r2 = filterReports(REPORTS, 'GST');
  assert.equal(r2.length, 1);
  assert.equal(r2[0].route, '#/reports/tax');
});

test('filterReports: returns empty array for no match', () => {
  const r = filterReports(REPORTS, 'nonexistent-xyz');
  assert.deepEqual(r, []);
});

test('filterReports: empty/blank query returns all reports', () => {
  assert.equal(filterReports(REPORTS, '').length, REPORTS.length);
  assert.equal(filterReports(REPORTS, '   ').length, REPORTS.length);
  assert.equal(filterReports(REPORTS).length, REPORTS.length);
});

// ---------- toggleFavourite ----------

test('toggleFavourite: adds a route when absent', () => {
  const next = toggleFavourite('[]', '#/reports/tax');
  assert.deepEqual(JSON.parse(next), ['#/reports/tax']);
});

test('toggleFavourite: removes a route when present', () => {
  const start = JSON.stringify(['#/reports/tax', '#/reports/bas']);
  const next = toggleFavourite(start, '#/reports/tax');
  assert.deepEqual(JSON.parse(next), ['#/reports/bas']);
});

test('toggleFavourite: tolerates empty string input', () => {
  const next = toggleFavourite('', '#/reports/bas');
  assert.deepEqual(JSON.parse(next), ['#/reports/bas']);
});

test('toggleFavourite: tolerates invalid JSON input', () => {
  const next = toggleFavourite('not-json{{{', '#/reports/bas');
  assert.deepEqual(JSON.parse(next), ['#/reports/bas']);
});

test('toggleFavourite: tolerates null/undefined input', () => {
  const next = toggleFavourite(null, '#/reports/bas');
  assert.deepEqual(JSON.parse(next), ['#/reports/bas']);
});

// ---------- parseFavourites ----------

test('parseFavourites: returns [] for invalid/empty input', () => {
  assert.deepEqual(parseFavourites(''), []);
  assert.deepEqual(parseFavourites(null), []);
  assert.deepEqual(parseFavourites('garbage'), []);
});

test('parseFavourites: parses a valid JSON array', () => {
  assert.deepEqual(parseFavourites('["#/reports/tax"]'), ['#/reports/tax']);
});

// ---------- DEFAULT_SETTINGS ----------

test('DEFAULT_SETTINGS includes report_favourites', () => {
  assert.ok(Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, 'report_favourites'));
});
