'use strict';

// Pure, UI-free helpers for the Xero-style report library (#/reports).
// Kept dependency-free (no DOM, no db) so they're unit testable directly and
// mirrored into ui/views/reports.js for the sandboxed renderer, exactly like
// annotateProviderAccounts in src/services/bank-feed/connections.js.

// Filters a flat list of report descriptors ({ route, name, description, ... })
// by a case-insensitive substring match against name or description.
function filterReports(reports = [], query = '') {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return reports.slice();
  return reports.filter((r) => {
    const name = String(r.name || '').toLowerCase();
    const desc = String(r.description || '').toLowerCase();
    return name.includes(q) || desc.includes(q);
  });
}

// Toggles a report route in a JSON-encoded array of favourite routes.
// Tolerant of '' / null / invalid JSON (treated as an empty list).
// Returns a new JSON string (never mutates the input).
function toggleFavourite(favouritesJson, route) {
  let list;
  try {
    const parsed = JSON.parse(favouritesJson || '[]');
    list = Array.isArray(parsed) ? parsed : [];
  } catch {
    list = [];
  }
  const idx = list.indexOf(route);
  const next = idx === -1 ? [...list, route] : list.filter((r) => r !== route);
  return JSON.stringify(next);
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

module.exports = { filterReports, toggleFavourite, parseFavourites };
