import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.PUBLIC_SUPABASE_URL;
const key = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const db = url && key ? createClient(url, key) : null;
const $ = (selector: string) => document.querySelector(selector) as HTMLElement | null;
const $$ = (selector: string) => [...document.querySelectorAll(selector)] as HTMLElement[];
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const state: Record<string, any[]> = { contacts: [], deals: [], tasks: [], activities: [], emailThreads: [], emailMessages: [], proposals: [], invoices: [] };
let activeContactId = '';
const esc = (value: unknown = '') => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c] || c));
const nice = (value = '') => value.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
const date = (value?: string) => value ? new Date(value).toLocaleDateString() : 'No due date';
const form = (id: string) => document.querySelector(id) as HTMLFormElement;
const dialog = (id: string) => document.querySelector(id) as HTMLDialogElement;

async function boot() {
  if (!db) { $('#login-message')!.textContent = 'CRM environment is not configured.'; return; }
  const { data } = await db.auth.getSession();
  if (data.session) await enter(data.session.user); else ($('#login-screen') as HTMLElement).hidden = false;
}

async function enter(user: any) {
  ($('#login-screen') as HTMLElement).hidden = true;
  ($('#crm-app') as HTMLElement).hidden = false;
  $('#user-email')!.textContent = user.email || '';
  await reloadAll();
}

async function reloadAll() {
  const results = await Promise.all([
    db!.from('contacts').select('*').neq('status', 'archived').order('created_at', { ascending: false }),
    db!.from('deals').select('*,contacts(first_name,last_name,company)').order('created_at', { ascending: false }),
    db!.from('tasks').select('*').neq('status', 'cancelled').order('due_at', { ascending: true, nullsFirst: false }),
    db!.from('activities').select('*').order('occurred_at', { ascending: false }),
    db!.from('email_threads').select('*,contacts(first_name,last_name,company,email)').order('last_message_at', { ascending: false }),
    db!.from('email_messages').select('*').order('sent_at', { ascending: false }),
    db!.from('proposals').select('*,contacts(first_name,last_name,company,email)').order('created_at', { ascending: false }),
    db!.from('invoices').select('*,contacts(first_name,last_name,company,email)').order('created_at', { ascending: false }),
  ]);
  const error = results.find(result => result.error)?.error;
  if (error) {
    ($('#crm-app') as HTMLElement).hidden = true; ($('#login-screen') as HTMLElement).hidden = false;
    $('#login-message')!.textContent = 'Your account is signed in but has not been granted CRM access.'; return;
  }
  ['contacts','deals','tasks','activities','emailThreads','emailMessages','proposals','invoices'].forEach((name, index) => state[name] = results[index].data || []);
  render();
}

function render() {
  const open = state.deals.filter(d => !['won','lost'].includes(d.stage));
  $('#pipeline-value')!.textContent = money.format(open.reduce((sum, deal) => sum + Number(deal.value), 0));
  $('#open-deals')!.textContent = `${open.length} active ${open.length === 1 ? 'opportunity' : 'opportunities'}`;
  $('#relationship-count')!.textContent = String(state.contacts.length);
  $('#contact-count')!.textContent = String(state.contacts.length);
  $('#task-count')!.textContent = String(state.tasks.filter(t => !['done','cancelled'].includes(t.status)).length);
  renderContacts(); renderPipeline(); renderTasks(); renderEmail(); renderProposals(); renderInvoices(); fillContactSelects();
  renderNotifications();
}

function renderNotifications() {
  const unread = state.emailMessages.filter(message => message.direction === 'inbound' && !message.read_at);
  $('#email-count')!.textContent = unread.length ? String(unread.length) : '0';
  const panel = $('#inbox-alerts') as HTMLElement;
  panel.hidden = unread.length === 0;
  $('#inbox-alert-list')!.innerHTML = unread.slice(0, 4).map(message => {
    const contact = state.contacts.find(item => item.id === message.contact_id);
    const name = contact ? `${contact.first_name} ${contact.last_name}`.trim() : message.from_address;
    return `<article class="inbox-alert"><div><strong>${esc(name)}</strong><p>${esc(message.subject)} · ${date(message.sent_at)}</p></div><button data-review-email="${message.id}" data-thread="${message.thread_id}">Review</button></article>`;
  }).join('');
}

function renderContacts() {
  const q = ((document.querySelector('#contact-search') as HTMLInputElement)?.value || '').toLowerCase();
  const filter = (document.querySelector('#contact-filter') as HTMLSelectElement)?.value || '';
  const contacts = state.contacts.filter(c => (!filter || c.status === filter) && (!q || `${c.first_name} ${c.last_name} ${c.company} ${c.email}`.toLowerCase().includes(q)));
  const row = (c: any) => `<tr data-open-contact="${c.id}"><td><strong>${esc(c.first_name)} ${esc(c.last_name)}</strong></td><td>${esc(c.company || '—')}</td><td>${esc(c.email || '—')}</td><td><span class="status ${esc(c.status)}">${nice(c.status)}</span></td><td>${date(c.created_at)}</td></tr>`;
  $('#contacts-table')!.innerHTML = contacts.length ? contacts.map(row).join('') : '<tr><td colspan="5" class="empty">No matching contacts.</td></tr>';
  $('#recent-contacts')!.innerHTML = state.contacts.slice(0, 5).map(c => `<tr data-open-contact="${c.id}"><td><strong>${esc(c.first_name)} ${esc(c.last_name)}</strong></td><td>${esc(c.company || '—')}</td><td><span class="status ${esc(c.status)}">${nice(c.status)}</span></td><td>${esc(nice(c.source))}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Your newest relationships will appear here.</td></tr>';
}

function renderPipeline() {
  const stages = ['new','discovery','proposal','negotiation','won','lost'];
  $('#kanban')!.innerHTML = stages.map(stage => {
    const deals = state.deals.filter(d => d.stage === stage);
    return `<section class="lane"><header><span>${nice(stage)}</span><b>${deals.length}</b></header><div>${deals.map(d => `<article><small>${esc(d.contacts?.company || 'Opportunity')}</small><h3>${esc(d.name)}</h3><strong>${money.format(d.value)}</strong><p>${esc([d.contacts?.first_name,d.contacts?.last_name].filter(Boolean).join(' '))}</p><div class="object-actions"><button data-edit-deal="${d.id}">Edit</button><button class="danger" data-delete-deal="${d.id}">Delete</button></div></article>`).join('') || '<p class="lane-empty">No opportunities</p>'}</div></section>`;
  }).join('');
  const max = Math.max(1, ...stages.map(s => state.deals.filter(d => d.stage === s).length));
  $('#stage-bars')!.innerHTML = stages.slice(0, 4).map(s => { const n = state.deals.filter(d => d.stage === s).length; return `<div><span>${nice(s)}</span><i><b style="width:${n / max * 100}%"></b></i><strong>${n}</strong></div>`; }).join('');
}

function renderTasks() {
  const active = state.tasks.filter(t => !['done','cancelled'].includes(t.status));
  const item = (t: any) => `<div class="task"><input type="checkbox" data-complete-task="${t.id}" ${t.status === 'done' ? 'checked' : ''}/><span><strong>${esc(t.title)}</strong><small>${date(t.due_at)} · ${nice(t.priority)}</small></span><div class="object-actions"><button data-edit-task="${t.id}">Edit</button><button class="danger" data-delete-task="${t.id}">Delete</button></div></div>`;
  $('#tasks-list')!.innerHTML = active.length ? active.map(item).join('') : '<p class="empty">Nothing open. Add the next action when you’re ready.</p>';
  $('#priority-list')!.innerHTML = active.slice(0, 5).map(item).join('') || '<p class="empty">No open priorities.</p>';
}

function renderEmail() {
  const select = document.querySelector('#email-contact') as HTMLSelectElement;
  if (!select) return;
  const selected = select.value;
  select.innerHTML = '<option value="">Select a contact</option>' + state.contacts.filter(c => c.email).map(c => `<option value="${c.id}" data-email="${esc(c.email)}">${esc(`${c.first_name} ${c.last_name}`.trim())}${c.company ? ` — ${esc(c.company)}` : ''}</option>`).join('');
  select.value = selected;
  $('#email-threads')!.innerHTML = state.emailThreads.length ? state.emailThreads.map(thread => {
    const latest = state.emailMessages.find(m => m.thread_id === thread.id);
    const name = `${thread.contacts?.first_name || ''} ${thread.contacts?.last_name || ''}`.trim() || thread.contacts?.email || 'Contact';
    const direction = latest?.direction === 'inbound' ? 'Received' : 'Sent';
    const unread = state.emailMessages.some(message => message.thread_id === thread.id && message.direction === 'inbound' && !message.read_at);
    return `<article class="email-thread ${unread ? 'unread' : ''}"><div><strong>${esc(name)}</strong><small>${esc(thread.contacts?.company || '')}</small></div><div><b>${esc(thread.subject)}</b><p><span class="direction ${latest?.direction || ''}">${direction}</span> ${esc((latest?.text_body || '').slice(0, 110))}</p></div><time>${date(thread.last_message_at)}</time><div class="object-actions">${unread ? `<button data-review-thread="${thread.id}">Mark reviewed</button>` : ''}<button data-reply-thread="${thread.id}">Reply</button><button class="danger" data-delete-thread="${thread.id}">Delete</button></div></article>`;
  }).join('') : '<p class="empty">Messages and replies will appear here.</p>';
}

function fillContactSelects() {
  ['#task-contact','#deal-contact','#proposal-contact'].forEach(id => {
    const select = document.querySelector(id) as HTMLSelectElement | null; if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">No contact</option>' + state.contacts.map(c => `<option value="${c.id}">${esc(`${c.first_name} ${c.last_name}`.trim())}${c.company ? ` — ${esc(c.company)}` : ''}</option>`).join('');
    select.value = current;
  });
}

function renderProposals() {
  const list = $('#proposals-list'); if (!list) return;
  list.innerHTML = state.proposals.length ? state.proposals.map(p => {
    const name = `${p.contacts?.first_name || ''} ${p.contacts?.last_name || ''}`.trim() || p.contacts?.email || 'Client';
    return `<article class="proposal-row"><div><p class="kicker">${esc(name)}</p><h3>${esc(p.title)}</h3><small>${date(p.created_at)} · ${nice(p.status)}</small></div><strong>${money.format(Number(p.amount_cents || 0) / 100)}</strong><div class="object-actions">${p.payment_url ? `<a class="button-link" href="${esc(p.payment_url)}" target="_blank" rel="noreferrer">Open link</a>` : ''}<button class="danger" data-delete-proposal="${p.id}">Delete</button></div></article>`;
  }).join('') : '<p class="empty">Create a proposal and send a secure Stripe payment link.</p>';
}
function renderInvoices() {
  const list = $('#invoices-list'); if (!list) return;
  list.innerHTML = state.invoices.length ? state.invoices.map(i => { const name = `${i.contacts?.first_name || ''} ${i.contacts?.last_name || ''}`.trim() || i.contacts?.email || 'Client'; return `<article class="proposal-row"><div><p class="kicker">${esc(name)}</p><h3>${esc(i.title)}</h3><small>${date(i.created_at)} · ${nice(i.status)} · due ${date(i.due_at)}</small></div><strong>${money.format(Number(i.amount_cents || 0) / 100)}</strong><div class="object-actions">${i.hosted_invoice_url ? `<a class="button-link" href="${esc(i.hosted_invoice_url)}" target="_blank" rel="noreferrer">Open invoice</a>` : ''}<button class="danger" data-delete-invoice="${i.id}">Delete</button></div></article>`; }).join('') : '<p class="empty">Invoices sent from the Business Office will appear here.</p>';
}

function openForm(kind: 'contact'|'task'|'deal', record?: any) {
  const target = form(`#${kind}-form`); target.reset();
  (target.elements.namedItem('id') as HTMLInputElement).value = record?.id || '';
  if (record) Object.entries(record).forEach(([name, value]) => { const input = target.elements.namedItem(name) as HTMLInputElement | null; if (input && value != null && typeof value !== 'object') input.value = name === 'due_at' ? String(value).slice(0,10) : String(value); });
  $(`#${kind}-dialog-title`)!.textContent = record ? `Edit ${kind === 'deal' ? 'opportunity' : kind}` : `Add ${kind === 'deal' ? 'an opportunity' : `a ${kind}`}`;
  $(`#${kind}-message`)!.textContent = ''; dialog(`#${kind}-dialog`).showModal();
}

async function save(kind: 'contact'|'task'|'deal', event: SubmitEvent) {
  event.preventDefault();
  const target = event.currentTarget as HTMLFormElement;
  const values: any = Object.fromEntries(new FormData(target));
  const id = values.id; delete values.id;
  Object.keys(values).forEach(key => { if (values[key] === '') values[key] = null; });
  if (kind === 'contact' && !id) values.source = 'manual';
  if (kind === 'deal') { values.value = Number(values.value || 0); values.probability = Number(values.probability || 10); }
  const query = id ? db!.from(`${kind}s`).update(values).eq('id', id) : db!.from(`${kind}s`).insert(values);
  const { error } = await query;
  if (error) { $(`#${kind}-message`)!.textContent = error.message; return; }
  dialog(`#${kind}-dialog`).close(); await reloadAll();
}

async function openContact(id: string) {
  activeContactId = id; const contact = state.contacts.find(c => c.id === id); if (!contact) return;
  $('#detail-name')!.textContent = `${contact.first_name} ${contact.last_name}`.trim();
  $('#detail-meta')!.textContent = [contact.title, contact.company, contact.email, contact.phone].filter(Boolean).join(' · ');
  (form('#activity-form').elements.namedItem('contact_id') as HTMLInputElement).value = id;
  const activities = state.activities.filter(a => a.contact_id === id);
  const messages = state.emailMessages.filter(m => m.contact_id === id).map(m => ({ ...m, activity_type: 'email', summary: `${m.direction === 'inbound' ? 'Email received' : 'Email sent'}: ${m.subject}`, details: m.text_body, occurred_at: m.sent_at, email: true }));
  const timeline = [...activities, ...messages].sort((a,b) => +new Date(b.occurred_at) - +new Date(a.occurred_at));
  $('#contact-timeline')!.innerHTML = timeline.length ? timeline.map(item => `<article><span>${nice(item.activity_type)}</span><div><strong>${esc(item.summary)}</strong><p>${esc(item.details || '')}</p><small>${new Date(item.occurred_at).toLocaleString()}</small></div>${item.email ? '' : `<div class="object-actions"><button data-edit-activity="${item.id}">Edit</button><button class="danger" data-delete-activity="${item.id}">Delete</button></div>`}</article>`).join('') : '<p class="empty">No activity yet.</p>';
  dialog('#contact-detail').showModal();
}

async function archive(table: string, id: string, label: string) {
  if (!confirm(`Delete ${label}? This removes it from the active CRM.`)) return;
  let query;
  if (table === 'contacts') query = db!.from(table).update({ status: 'archived' }).eq('id', id);
  else if (table === 'tasks') query = db!.from(table).update({ status: 'cancelled' }).eq('id', id);
  else query = db!.from(table).delete().eq('id', id);
  const { error } = await query; if (error) { alert(error.message); return; }
  await reloadAll();
}

function showView(view: string) {
  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.panel === view));
  $$('.nav-link').forEach(v => v.classList.toggle('active', v.dataset.view === view));
  $('#view-title')!.textContent = ({overview:'Business overview',contacts:'Relationships',pipeline:'Opportunity pipeline',proposals:'Proposals & payment',invoices:'Invoices',tasks:'Tasks & follow-up',email:'Email center'} as any)[view];
  document.body.classList.remove('nav-open');
}

form('#login-form').addEventListener('submit', async event => { event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement); $('#login-message')!.textContent = 'Signing in…'; const result = await db!.auth.signInWithPassword({ email: String(data.get('email') || ''), password: String(data.get('password') || '') }); if (result.error) { $('#login-message')!.textContent = result.error.message; return; } await enter(result.data.user); });
$('#sign-out')!.addEventListener('click', async () => { await db!.auth.signOut(); location.reload(); });
$$('.nav-link').forEach(button => button.addEventListener('click', () => showView(button.dataset.view!)));
$$('[data-jump]').forEach(button => button.addEventListener('click', () => showView(button.dataset.jump!)));
$('#mobile-nav')!.addEventListener('click', () => document.body.classList.toggle('nav-open'));
$('#contact-search')!.addEventListener('input', renderContacts); $('#contact-filter')!.addEventListener('change', renderContacts);
$('#new-contact')!.addEventListener('click', () => openForm('contact')); $('#new-task')!.addEventListener('click', () => openForm('task')); $('#new-deal')!.addEventListener('click', () => openForm('deal'));
$('#new-proposal')!.addEventListener('click', () => { fillContactSelects(); form('#proposal-form').reset(); $('#proposal-message')!.textContent = ''; dialog('#proposal-dialog').showModal(); });
$('#new-invoice')!.addEventListener('click', () => { fillContactSelects(); form('#invoice-form').reset(); $('#invoice-message')!.textContent = ''; dialog('#invoice-dialog').showModal(); });
form('#contact-form').addEventListener('submit', event => save('contact', event)); form('#task-form').addEventListener('submit', event => save('task', event)); form('#deal-form').addEventListener('submit', event => save('deal', event));
$('#close-detail')!.addEventListener('click', () => dialog('#contact-detail').close());
$('#detail-edit')!.addEventListener('click', () => { const contact = state.contacts.find(c => c.id === activeContactId); dialog('#contact-detail').close(); openForm('contact', contact); });
$('#detail-delete')!.addEventListener('click', async () => { dialog('#contact-detail').close(); await archive('contacts', activeContactId, 'this contact'); });
$('#detail-task')!.addEventListener('click', () => { dialog('#contact-detail').close(); openForm('task', { contact_id: activeContactId }); });
$('#detail-email')!.addEventListener('click', () => { const contact = state.contacts.find(c => c.id === activeContactId); dialog('#contact-detail').close(); showView('email'); const select = document.querySelector('#email-contact') as HTMLSelectElement; select.value = activeContactId; (document.querySelector('#email-to') as HTMLInputElement).value = contact?.email || ''; });
form('#activity-form').addEventListener('submit', async event => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget as HTMLFormElement)); const { error } = await db!.from('activities').insert(values); if (error) { alert(error.message); return; } form('#activity-form').reset(); await reloadAll(); await openContact(activeContactId); });
$('#email-contact')!.addEventListener('change', event => { const select = event.target as HTMLSelectElement; (document.querySelector('#email-to') as HTMLInputElement).value = select.selectedOptions[0]?.dataset.email || ''; });
$('#refresh-email')!.addEventListener('click', reloadAll);
form('#email-form').addEventListener('submit', async event => { event.preventDefault(); const message = $('#email-message')!; message.textContent = 'Sending…'; const { data: { session } } = await db!.auth.getSession(); if (!session) { message.textContent = 'Session expired. Sign in again.'; return; } const payload = Object.fromEntries(new FormData(event.currentTarget as HTMLFormElement)); const response = await fetch('/api/crm/email/send', { method:'POST', headers:{'content-type':'application/json','authorization':`Bearer ${session.access_token}`}, body:JSON.stringify(payload) }); const result = await response.json(); if (!response.ok) { message.textContent = result.error || 'Message could not be sent.'; return; } message.textContent = 'Message sent and saved to this contact.'; form('#email-form').reset(); await reloadAll(); });
form('#proposal-form').addEventListener('submit', async event => { event.preventDefault(); const message = $('#proposal-message')!; message.textContent = 'Creating secure Stripe link…'; const { data: { session } } = await db!.auth.getSession(); if (!session) { message.textContent = 'Session expired. Sign in again.'; return; } const payload = Object.fromEntries(new FormData(event.currentTarget as HTMLFormElement)); const response = await fetch('/api/crm/proposals/create', { method:'POST', headers:{'content-type':'application/json','authorization':`Bearer ${session.access_token}`}, body:JSON.stringify(payload) }); const result = await response.json(); if (!response.ok) { message.textContent = result.error || 'Proposal could not be created.'; return; } dialog('#proposal-dialog').close(); await reloadAll(); showView('proposals'); });
form('#invoice-form').addEventListener('submit', async event => { event.preventDefault(); const message = $('#invoice-message')!; message.textContent = 'Creating Stripe invoice…'; const { data: { session } } = await db!.auth.getSession(); if (!session) { message.textContent = 'Session expired. Sign in again.'; return; } const payload = Object.fromEntries(new FormData(event.currentTarget as HTMLFormElement)); const response = await fetch('/api/crm/invoices/create', { method:'POST', headers:{'content-type':'application/json','authorization':`Bearer ${session.access_token}`}, body:JSON.stringify(payload) }); const result = await response.json(); if (!response.ok) { message.textContent = result.error || 'Invoice could not be created.'; return; } dialog('#invoice-dialog').close(); await reloadAll(); showView('invoices'); });

document.addEventListener('click', async event => {
  const target = (event.target as HTMLElement).closest('button,[data-open-contact]') as HTMLElement | null; if (!target) return;
  if (target.dataset.openContact) return openContact(target.dataset.openContact);
  if (target.dataset.editTask) return openForm('task', state.tasks.find(t => t.id === target.dataset.editTask));
  if (target.dataset.editDeal) return openForm('deal', state.deals.find(d => d.id === target.dataset.editDeal));
  if (target.dataset.deleteTask) return archive('tasks', target.dataset.deleteTask, 'this task');
  if (target.dataset.deleteDeal) return archive('deals', target.dataset.deleteDeal, 'this opportunity');
  if (target.dataset.deleteProposal) return archive('proposals', target.dataset.deleteProposal, 'this proposal');
  if (target.dataset.deleteInvoice) return archive('invoices', target.dataset.deleteInvoice, 'this invoice');
  if (target.dataset.deleteActivity) { await archive('activities', target.dataset.deleteActivity, 'this activity'); return openContact(activeContactId); }
  if (target.dataset.editActivity) { const item = state.activities.find(a => a.id === target.dataset.editActivity); const summary = prompt('Update summary', item?.summary); if (!summary) return; const details = prompt('Update details', item?.details || '') ?? item?.details; await db!.from('activities').update({ summary, details }).eq('id', item.id); await reloadAll(); return openContact(activeContactId); }
  if (target.dataset.deleteThread) return archive('email_threads', target.dataset.deleteThread, 'this conversation');
  if (target.dataset.reviewEmail) { await db!.from('email_messages').update({ read_at: new Date().toISOString() }).eq('id', target.dataset.reviewEmail); showView('email'); return reloadAll(); }
  if (target.dataset.reviewThread) { await db!.from('email_messages').update({ read_at: new Date().toISOString() }).eq('thread_id', target.dataset.reviewThread).eq('direction', 'inbound').is('read_at', null); return reloadAll(); }
  if (target.dataset.replyThread) { const thread = state.emailThreads.find(t => t.id === target.dataset.replyThread); const contact = state.contacts.find(c => c.id === thread?.contact_id); const emailForm = form('#email-form'); (emailForm.elements.namedItem('threadId') as HTMLInputElement).value = thread.id; (emailForm.elements.namedItem('contactId') as HTMLSelectElement).value = contact?.id || ''; (emailForm.elements.namedItem('to') as HTMLInputElement).value = contact?.email || ''; (emailForm.elements.namedItem('subject') as HTMLInputElement).value = /^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`; (emailForm.elements.namedItem('text') as HTMLTextAreaElement).focus(); }
});

document.addEventListener('change', async event => { const target = event.target as HTMLInputElement; if (!target.dataset.completeTask) return; await db!.from('tasks').update({ status: target.checked ? 'done' : 'open' }).eq('id', target.dataset.completeTask); await reloadAll(); });
boot();
