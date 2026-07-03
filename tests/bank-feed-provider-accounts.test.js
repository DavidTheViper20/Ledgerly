'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { annotateProviderAccounts } = require('../src/services/bank-feed/connections');

test('annotateProviderAccounts: pre-checks accounts with no existing link', () => {
  const providerAccounts = [
    { providerAccountId: 'acc-1', providerAccountName: 'Business Everyday' },
    { providerAccountId: 'acc-2', providerAccountName: 'Business Savings' },
  ];

  const result = annotateProviderAccounts(providerAccounts, []);

  assert.equal(result.length, 2);
  for (const account of result) {
    assert.equal(account.alreadyMapped, false);
    assert.equal(account.selectable, true);
    assert.equal(account.preChecked, true);
    assert.equal(account.mappedBankAccountName, '');
  }
});

test('annotateProviderAccounts: flags and disables accounts already mapped to a ledger account', () => {
  const providerAccounts = [
    { providerAccountId: 'acc-1', providerAccountName: 'Business Everyday' },
    { providerAccountId: 'acc-2', providerAccountName: 'Business Savings' },
  ];
  const accountLinks = [
    { provider_account_id: 'acc-1', bank_account_name: 'Operating Account' },
  ];

  const result = annotateProviderAccounts(providerAccounts, accountLinks);

  const mapped = result.find(a => a.providerAccountId === 'acc-1');
  const unmapped = result.find(a => a.providerAccountId === 'acc-2');

  assert.equal(mapped.alreadyMapped, true);
  assert.equal(mapped.selectable, false);
  assert.equal(mapped.preChecked, false);
  assert.equal(mapped.mappedBankAccountName, 'Operating Account');

  assert.equal(unmapped.alreadyMapped, false);
  assert.equal(unmapped.selectable, true);
  assert.equal(unmapped.preChecked, true);
});

test('annotateProviderAccounts: matches links using camelCase providerAccountId shape too', () => {
  const providerAccounts = [{ providerAccountId: 'acc-9', providerAccountName: 'Everyday' }];
  const accountLinks = [{ providerAccountId: 'acc-9', bank_account_name: 'Checking' }];

  const result = annotateProviderAccounts(providerAccounts, accountLinks);

  assert.equal(result[0].alreadyMapped, true);
  assert.equal(result[0].selectable, false);
});

test('annotateProviderAccounts: handles empty inputs without throwing', () => {
  assert.deepEqual(annotateProviderAccounts(), []);
  assert.deepEqual(annotateProviderAccounts([], undefined), []);
});
