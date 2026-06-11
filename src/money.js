'use strict';

// All monetary amounts are stored as integer cents.
// Rounding: half away from zero (matches common invoicing behaviour).

function round(n) {
  return n >= 0 ? Math.floor(n + 0.5) : Math.ceil(n - 0.5);
}

function toCents(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[,\s]/g, ''));
  if (!isFinite(n)) return 0;
  return round(n * 100);
}

function fromCents(cents) {
  return (cents || 0) / 100;
}

// Compute one document line.
// qty * unitPriceCents, optional discount %, then tax according to mode.
// mode: 'exclusive' | 'inclusive' | 'none'
// ratePct: e.g. 20 for 20%
function calcLine({ qty, unitPriceCents, discountPct = 0, ratePct = 0, mode = 'exclusive' }) {
  const q = isFinite(qty) ? qty : 0;
  const gross = round(q * (unitPriceCents || 0) * (1 - (discountPct || 0) / 100));
  if (mode === 'none' || !ratePct) {
    return { netCents: gross, taxCents: mode === 'inclusive' ? 0 : 0, totalCents: gross };
  }
  const r = ratePct / 100;
  if (mode === 'inclusive') {
    const net = round(gross / (1 + r));
    return { netCents: net, taxCents: gross - net, totalCents: gross };
  }
  // exclusive
  const tax = round(gross * r);
  return { netCents: gross, taxCents: tax, totalCents: gross + tax };
}

// Sum an array of computed lines into document totals.
function sumLines(lines) {
  let subtotal = 0, tax = 0;
  for (const l of lines) { subtotal += l.netCents; tax += l.taxCents; }
  return { subtotalCents: subtotal, taxCents: tax, totalCents: subtotal + tax };
}

module.exports = { round, toCents, fromCents, calcLine, sumLines };
