'use strict';

function directionOf(amountCents) {
  return amountCents < 0 ? 'money_out' : 'money_in';
}

function listRules(db) {
  return db.prepare('SELECT * FROM bank_rules ORDER BY priority DESC, id ASC').all();
}

function saveRule(db, d) {
  if (!d.name || !String(d.name).trim()) throw new Error('Rule name is required');
  if (!['any', 'money_in', 'money_out'].includes(d.direction || 'any')) throw new Error('Invalid rule direction');
  const cols = {
    name: String(d.name).trim(),
    bank_account_id: d.bankAccountId || null,
    direction: d.direction || 'any',
    text_contains: d.textContains || '',
    min_amount_cents: d.minAmountCents == null ? null : Math.round(d.minAmountCents),
    max_amount_cents: d.maxAmountCents == null ? null : Math.round(d.maxAmountCents),
    contact_id: d.contactId || null,
    account_id: d.accountId || null,
    tax_rate_id: d.taxRateId || null,
    description_template: d.descriptionTemplate || '',
    priority: Math.round(d.priority || 0),
    enabled: d.enabled === false ? 0 : 1,
  };
  if (d.id) {
    db.prepare(`UPDATE bank_rules SET ${Object.keys(cols).map(k => `${k}=?`).join(', ')} WHERE id=?`)
      .run(...Object.values(cols), d.id);
    return db.prepare('SELECT * FROM bank_rules WHERE id=?').get(d.id);
  }
  const r = db.prepare(`INSERT INTO bank_rules (${Object.keys(cols).join(',')})
    VALUES (${Object.keys(cols).map(() => '?').join(',')})`).run(...Object.values(cols));
  return db.prepare('SELECT * FROM bank_rules WHERE id=?').get(Number(r.lastInsertRowid));
}

function ruleMatches(rule, line) {
  if (!rule.enabled) return false;
  if (rule.bank_account_id && rule.bank_account_id !== line.bank_account_id) return false;
  if (rule.direction !== 'any' && rule.direction !== directionOf(line.amount_cents)) return false;
  const abs = Math.abs(line.amount_cents);
  if (rule.min_amount_cents != null && abs < rule.min_amount_cents) return false;
  if (rule.max_amount_cents != null && abs > rule.max_amount_cents) return false;
  const haystack = `${line.payee || ''} ${line.description || ''} ${line.reference || ''}`.toLowerCase();
  if (rule.text_contains && !haystack.includes(String(rule.text_contains).toLowerCase())) return false;
  return true;
}

function suggestRules(db, line) {
  return listRules(db)
    .filter(rule => ruleMatches(rule, line))
    .map(rule => ({
      rule_id: rule.id,
      name: rule.name,
      contact_id: rule.contact_id,
      account_id: rule.account_id,
      tax_rate_id: rule.tax_rate_id,
      description: rule.description_template || line.description || line.payee || 'Bank transaction',
      priority: rule.priority,
    }));
}

module.exports = { listRules, saveRule, suggestRules };
