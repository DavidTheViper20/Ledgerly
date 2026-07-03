'use strict';

// Pure, environment-free helpers shared between the sandboxed renderer and
// the main process / tests. Loaded as a plain <script> in ui/index.html
// (exposes window.LedgerlyShared) and require()-able from Node — the single
// implementation for logic that both sides need.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LedgerlyShared = Object.assign(root.LedgerlyShared || {}, factory());
})(typeof self !== 'undefined' ? self : this, function () {

  // Flags provider accounts that are already mapped to a ledger account
  // (disabled in the picker) vs unmapped ones (selectable, pre-checked).
  function annotateProviderAccounts(providerAccounts = [], accountLinks = []) {
    const mappedByProviderId = new Map(
      accountLinks.map(l => [String(l.provider_account_id ?? l.providerAccountId ?? ''), l]),
    );
    return providerAccounts.map((account) => {
      const providerAccountId = String(account.providerAccountId ?? account.provider_account_id ?? '');
      const link = mappedByProviderId.get(providerAccountId);
      const alreadyMapped = Boolean(link);
      return {
        ...account,
        alreadyMapped,
        mappedBankAccountName: link ? (link.bank_account_name || '') : '',
        selectable: !alreadyMapped,
        preChecked: !alreadyMapped,
      };
    });
  }

  // Filters report descriptors ({ route, name, description }) by a
  // case-insensitive substring match against name or description.
  function filterReports(reports = [], query = '') {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return reports.slice();
    return reports.filter((r) => {
      const name = String(r.name || '').toLowerCase();
      const desc = String(r.description || '').toLowerCase();
      return name.includes(q) || desc.includes(q);
    });
  }

  // Parses a favourites JSON string into an array, tolerant of bad input.
  function parseFavourites(favouritesJson) {
    try {
      const parsed = JSON.parse(favouritesJson || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // Toggles a report route in a JSON-encoded array of favourite routes.
  // Returns a new JSON string (never mutates the input).
  function toggleFavourite(favouritesJson, route) {
    const list = parseFavourites(favouritesJson);
    const next = list.includes(route) ? list.filter((r) => r !== route) : [...list, route];
    return JSON.stringify(next);
  }

  return { annotateProviderAccounts, filterReports, toggleFavourite, parseFavourites };
});
