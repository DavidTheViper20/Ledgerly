'use strict';

// Pass E — settings home + focused panes: pure routing helper mapping
// #/settings query params (?pane= / legacy ?focus=) onto a pane id.
// See docs/superpowers/plans/2026-07-03-xero-ia-product-plan.md §6.

const { test } = require('node:test');
const assert = require('node:assert');

const { paneForQuery, SETTINGS_PANE_IDS } = require('../ui/shared');

test('paneForQuery: no params returns empty string (settings home)', () => {
  assert.equal(paneForQuery({}), '');
  assert.equal(paneForQuery(), '');
});

test('paneForQuery: ?pane=<id> returns the pane id when valid', () => {
  for (const id of SETTINGS_PANE_IDS) {
    assert.equal(paneForQuery({ pane: id }), id);
  }
});

test('paneForQuery: ?pane=<unknown> falls back to home', () => {
  assert.equal(paneForQuery({ pane: 'not-a-real-pane' }), '');
});

test('paneForQuery: legacy ?focus=ai maps to the assistant pane', () => {
  assert.equal(paneForQuery({ focus: 'ai' }), 'assistant');
});

test('paneForQuery: legacy ?focus=sales and ?focus=purchases map onto their panes', () => {
  assert.equal(paneForQuery({ focus: 'sales' }), 'sales');
  assert.equal(paneForQuery({ focus: 'purchases' }), 'purchases');
});

test('paneForQuery: unknown ?focus= falls back to home', () => {
  assert.equal(paneForQuery({ focus: 'nonsense' }), '');
});

test('paneForQuery: ?pane= takes precedence over ?focus= when both present', () => {
  assert.equal(paneForQuery({ pane: 'taxes', focus: 'ai' }), 'taxes');
});

test('SETTINGS_PANE_IDS covers all nine grouped sections from the plan', () => {
  assert.deepEqual(SETTINGS_PANE_IDS, [
    'organisation', 'sales', 'purchases', 'taxes',
    'bank-feeds', 'cloud', 'security', 'assistant', 'advanced',
  ]);
});
