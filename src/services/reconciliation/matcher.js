'use strict';

function daysApart(a, b) {
  return Math.abs((new Date(a) - new Date(b)) / 864e5);
}

function clean(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function containsEither(haystack, ...needles) {
  const h = clean(haystack);
  return needles.some(n => {
    const c = clean(n);
    return c && h.includes(c);
  });
}

function scoreCandidate(statementLine, candidate) {
  let score = 0;
  const reasons = [];
  if (statementLine.amount_cents === candidate.amount_cents) {
    score += 60;
    reasons.push('Exact amount');
  } else {
    return { score: -1000, reasons: ['Amount mismatch'] };
  }

  const gap = daysApart(statementLine.date, candidate.date);
  if (gap === 0) {
    score += 20;
    reasons.push('Same date');
  } else if (gap <= 1) {
    score += 16;
    reasons.push('Within 1 day');
  } else if (gap <= 7) {
    score += 8;
    reasons.push('Within 7 days');
  }

  if (containsEither(statementLine.reference, candidate.reference, candidate.description)) {
    score += 20;
    reasons.push('Reference match');
  }
  if (containsEither(`${statementLine.payee} ${statementLine.description}`, candidate.description, candidate.reference)) {
    score += 10;
    reasons.push('Payee or description match');
  }
  return { score, reasons };
}

function suggestMatches(statementLines, candidates) {
  const used = new Set();
  return statementLines.map(line => {
    const suggestions = candidates
      .filter(c => !used.has(`${c.kind}:${c.id}:${c.direction || ''}`))
      .map(c => ({ ...c, ...scoreCandidate(line, c) }))
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score || a.date.localeCompare(b.date) || a.id - b.id)
      .slice(0, 5);
    if (suggestions[0]) used.add(`${suggestions[0].kind}:${suggestions[0].id}:${suggestions[0].direction || ''}`);
    return { ...line, suggestions };
  });
}

module.exports = { scoreCandidate, suggestMatches };
