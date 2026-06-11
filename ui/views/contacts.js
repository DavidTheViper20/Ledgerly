'use strict';

VIEWS.contacts = async function (main, params) {
  const filter = params.tab || 'all';
  const search = params.q || '';
  const rows = await api('contacts.list', { filter, search });
  const tab = (id, label) =>
    `<a href="#/contacts?tab=${id}" class="${filter === id ? 'active' : ''}">${label}</a>`;

  main.innerHTML = `
    <div class="page-head">
      <h1>Contacts</h1>
      <div class="spacer"></div>
      <input class="search" id="contact-search" placeholder="Search contacts…" value="${esc(search)}" />
      <a class="btn primary" href="#/contacts/new">New contact</a>
    </div>
    <div class="tabs">
      ${tab('all', 'All')}${tab('customers', 'Customers')}${tab('suppliers', 'Suppliers')}${tab('archived', 'Archived')}
    </div>
    <div class="card">
      <table class="data">
        <thead><tr>
          <th>Name</th><th>Email</th><th>Phone</th><th class="num">They owe</th><th class="num">You owe</th>
        </tr></thead>
        <tbody>
          ${rows.length === 0 ? '<tr><td colspan="5"><div class="empty">No contacts found</div></td></tr>' : ''}
          ${rows.map(c => `
            <tr class="click" data-go="#/contacts/${c.id}">
              <td><b>${esc(c.name)}</b></td>
              <td>${esc(c.email)}</td>
              <td>${esc(c.phone)}</td>
              <td class="num">${c.they_owe_cents ? fmtMoney(c.they_owe_cents) : ''}</td>
              <td class="num">${c.you_owe_cents ? fmtMoney(c.you_owe_cents) : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  const si = document.getElementById('contact-search');
  si.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') navigate(`#/contacts?tab=${filter}&q=${encodeURIComponent(si.value)}`);
  });
};

VIEWS.contactDetail = async function (main, params) {
  const c = await api('contacts.get', { id: Number(params.id) });
  const docRows = (docs, base) => docs.slice(0, 15).map(d => `
    <tr class="click" data-go="#/${base}/${d.id}">
      <td>${esc(d.number || d.reference || '#' + d.id)}</td>
      <td>${fmtDate(d.issue_date)}</td>
      <td>${fmtDate(d.due_date)}</td>
      <td>${badge(d.status === 'AUTHORISED' && d.due_date < today() ? 'OVERDUE' : d.status)}</td>
      <td class="num">${fmtMoney(d.total_cents)}</td>
      <td class="num">${fmtMoney(d.total_cents - d.paid_cents)}</td>
    </tr>`).join('');

  main.innerHTML = `
    <div class="page-head">
      <h1>${esc(c.name)}</h1>
      ${c.is_customer ? '<span class="badge PAID">Customer</span>' : ''}
      ${c.is_supplier ? '<span class="badge AUTHORISED">Supplier</span>' : ''}
      ${c.is_archived ? '<span class="badge VOIDED">Archived</span>' : ''}
      <div class="spacer"></div>
      <a class="btn" href="#/contacts/${c.id}/edit">Edit</a>
      <button class="btn" id="btn-archive">${c.is_archived ? 'Restore' : 'Archive'}</button>
      <a class="btn primary" href="#/invoices/new?contact=${c.id}">New invoice</a>
    </div>

    <div class="grid cols-3">
      <div class="card">
        <h2>Details</h2>
        <table class="data"><tbody>
          ${c.contact_person ? `<tr><td>Contact</td><td>${esc(c.contact_person)}</td></tr>` : ''}
          ${c.email ? `<tr><td>Email</td><td>${esc(c.email)}</td></tr>` : ''}
          ${c.phone ? `<tr><td>Phone</td><td>${esc(c.phone)}</td></tr>` : ''}
          ${c.address || c.city ? `<tr><td>Address</td><td>${esc([c.address, c.city, c.postcode, c.country].filter(Boolean).join(', '))}</td></tr>` : ''}
          ${c.tax_number ? `<tr><td>Tax number</td><td>${esc(c.tax_number)}</td></tr>` : ''}
          ${c.notes ? `<tr><td>Notes</td><td>${esc(c.notes)}</td></tr>` : ''}
        </tbody></table>
      </div>
      <div class="card">
        <h2>They owe</h2>
        <div class="doc-total">${fmtMoney(c.invoices.filter(i => i.status === 'AUTHORISED').reduce((s, i) => s + i.total_cents - i.paid_cents, 0))}</div>
        <div class="page-sub" style="margin-top:4px">across ${c.invoices.filter(i => i.status === 'AUTHORISED').length} open invoice(s)</div>
      </div>
      <div class="card">
        <h2>You owe</h2>
        <div class="doc-total">${fmtMoney(c.bills.filter(i => i.status === 'AUTHORISED').reduce((s, i) => s + i.total_cents - i.paid_cents, 0))}</div>
        <div class="page-sub" style="margin-top:4px">across ${c.bills.filter(i => i.status === 'AUTHORISED').length} open bill(s)</div>
      </div>
    </div>

    <div class="card">
      <h2>Invoices</h2>
      ${c.invoices.length === 0 ? '<div class="empty">No invoices for this contact</div>' : `
      <table class="data">
        <thead><tr><th>Number</th><th>Date</th><th>Due</th><th>Status</th><th class="num">Total</th><th class="num">Due</th></tr></thead>
        <tbody>${docRows(c.invoices, 'invoices')}</tbody>
      </table>`}
    </div>
    <div class="card">
      <h2>Bills</h2>
      ${c.bills.length === 0 ? '<div class="empty">No bills for this contact</div>' : `
      <table class="data">
        <thead><tr><th>Number</th><th>Date</th><th>Due</th><th>Status</th><th class="num">Total</th><th class="num">Due</th></tr></thead>
        <tbody>${docRows(c.bills, 'bills')}</tbody>
      </table>`}
    </div>`;

  document.getElementById('btn-archive').addEventListener('click', async () => {
    try {
      await api('contacts.archive', { id: c.id, archived: !c.is_archived });
      toast(c.is_archived ? 'Contact restored' : 'Contact archived', 'success');
      navigate('#/contacts');
    } catch (e) { showError(e); }
  });
};

VIEWS.contactEdit = async function (main, params) {
  const isEdit = !!params.id;
  const c = isEdit ? await api('contacts.get', { id: Number(params.id) }) : {
    name: '', contact_person: '', email: '', phone: '', address: '', city: '',
    postcode: '', country: '', tax_number: '', notes: '', is_customer: 0, is_supplier: 0,
  };

  main.innerHTML = `
    <div class="page-head"><h1>${isEdit ? 'Edit contact' : 'New contact'}</h1></div>
    <div class="card" style="max-width:760px">
      <form id="contact-form">
        <label class="field">Name *
          <input name="name" required value="${esc(c.name)}" />
        </label>
        <div class="field-row">
          <label class="field">Contact person<input name="contact_person" value="${esc(c.contact_person)}" /></label>
          <label class="field">Email<input name="email" type="email" value="${esc(c.email)}" /></label>
          <label class="field">Phone<input name="phone" value="${esc(c.phone)}" /></label>
        </div>
        <div class="field-row">
          <label class="field">Address<input name="address" value="${esc(c.address)}" /></label>
          <label class="field">City<input name="city" value="${esc(c.city)}" /></label>
        </div>
        <div class="field-row">
          <label class="field">Postcode<input name="postcode" value="${esc(c.postcode)}" /></label>
          <label class="field">Country<input name="country" value="${esc(c.country)}" /></label>
          <label class="field">Tax number<input name="tax_number" value="${esc(c.tax_number)}" /></label>
        </div>
        <label class="field">Notes<textarea name="notes" rows="3">${esc(c.notes)}</textarea></label>
        <div class="field-row">
          <label class="checkbox"><input type="checkbox" name="is_customer" ${c.is_customer ? 'checked' : ''}/> Customer</label>
          <label class="checkbox"><input type="checkbox" name="is_supplier" ${c.is_supplier ? 'checked' : ''}/> Supplier</label>
        </div>
        <div class="btn-row">
          <button type="submit" class="btn primary">Save contact</button>
          <a class="btn" href="${isEdit ? '#/contacts/' + c.id : '#/contacts'}">Cancel</a>
        </div>
      </form>
    </div>`;

  document.getElementById('contact-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const data = Object.fromEntries(f.entries());
    data.is_customer = f.has('is_customer');
    data.is_supplier = f.has('is_supplier');
    if (isEdit) data.id = c.id;
    try {
      const saved = await api('contacts.save', data);
      toast('Contact saved', 'success');
      navigate('#/contacts/' + saved.id);
    } catch (e) { showError(e); }
  });
};
