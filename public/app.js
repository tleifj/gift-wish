// Gift Wish — a tiny single-page app with hash routing. No build step.
import { icon } from './icons.js';
const app = document.getElementById('app');
const account = document.getElementById('account');
const toastEl = document.getElementById('toast');

let me = null; // { user, family, members, years }

// Which year's lists are showing. Each year starts fresh; past years are read-only.
const THIS_YEAR = new Date().getFullYear();
let year = THIS_YEAR;
try {
  year = Number(sessionStorage.getItem('gw-year')) || THIS_YEAR;
} catch {}
function setYear(y) {
  year = y;
  try {
    sessionStorage.setItem('gw-year', String(y));
  } catch {}
}

// ---------- helpers ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(method, path, body) {
  // Every change (POST/PUT/DELETE) is sent as JSON, even with nothing to send:
  // the server only accepts JSON for changes, as protection against cross-site forms.
  const sendsJson = method !== 'GET';
  const res = await fetch(path, {
    method,
    headers: sendsJson ? { 'Content-Type': 'application/json' } : {},
    body: sendsJson ? JSON.stringify(body ?? {}) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', isError);
  toastEl.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (toastEl.hidden = true), 3200);
}

/**
 * A styled replacement for window.confirm(). Resolves true only if the person
 * picks the confirm button; Cancel, Esc and clicking outside all resolve false.
 */
function confirmDialog({ title, message = '', confirmLabel = 'Confirm', icon: iconName = 'trash-2', danger = iconName === 'trash-2' }) {
  const dlg = document.getElementById('confirm');
  if (typeof dlg?.showModal !== 'function') return Promise.resolve(window.confirm(title));
  dlg.querySelector('.confirm-icon').innerHTML = icon(iconName, { size: 22 });
  dlg.querySelector('.confirm-icon').classList.toggle('ok', !danger);
  dlg.querySelector('#confirm-ok').className = `btn ${danger ? 'danger' : 'primary'}`;
  dlg.querySelector('#confirm-title').textContent = title;
  dlg.querySelector('#confirm-message').textContent = message;
  dlg.querySelector('#confirm-message').hidden = !message;
  dlg.querySelector('#confirm-ok').innerHTML = `${icon(iconName, { size: 16 })}${confirmLabel}`;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    // A click on the dialog element itself (not its contents) is a click on the backdrop.
    const onBackdrop = (e) => {
      if (e.target === dlg) dlg.close('cancel');
    };
    dlg.addEventListener('click', onBackdrop);
    dlg.addEventListener(
      'close',
      () => {
        dlg.removeEventListener('click', onBackdrop);
        resolve(dlg.returnValue === 'confirm');
      },
      { once: true }
    );
  });
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'link';
  }
}

/**
 * Prices are free text. Plain amounts get a dollar sign ("24" -> "$24", "25-30" -> "$25-30");
 * anything that already names a currency ("$24.95", "£20", "20 EUR") is shown as typed.
 */
function formatPrice(price) {
  const p = String(price ?? '').trim();
  return /^\d[\d.,\s\-–~+]*$/.test(p) ? `$${p}` : p;
}

const PRIORITY = { 1: 'Most wanted', 2: 'Would like', 3: 'Nice to have' };

// ---------- routing ----------
window.addEventListener('hashchange', render);

async function loadMe() {
  try {
    me = await api('GET', `/api/me?year=${year}`);
  } catch (e) {
    if (e.status !== 401) throw e;
    me = null;
  }
}

async function render() {
  await loadMe();
  renderAccount();
  const hash = location.hash.replace(/^#/, '') || '/';

  const reset = hash.match(/^\/reset\/([A-Za-z0-9_-]+)$/);
  if (reset) return renderPasswordReset(reset[1]);
  if (!me) return renderAuth(hash.startsWith('/signup') ? 'signup' : hash.startsWith('/login') ? 'login' : 'default');
  if (!me.family) return renderOnboarding();
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);

  const m = hash.match(/^\/list\/(\d+)$/);
  if (m) return renderList(Number(m[1]));
  if (hash === '/shopping') return renderShopping();
  if (hash === '/family') return renderFamily();
  return renderList(me.user.id);
}

function renderAccount() {
  if (!me) {
    account.innerHTML = '';
    return;
  }
  account.innerHTML = `<span class="muted">Hi, ${esc(me.user.name)}</span>
    <button class="link-btn" id="logout">${icon('log-out', { size: 16 })}Sign out</button>`;
  document.getElementById('logout').onclick = async () => {
    await api('POST', '/api/logout', {});
    location.hash = '#/';
    render();
  };
}

function nav(active) {
  const others = me.members.filter((m) => m.id !== me.user.id);
  const tab = (href, label, key, extra = '', ic = '') =>
    `<a href="${href}" class="tab ${active === key ? 'active' : ''}">${ic ? icon(ic, { size: 16 }) : ''}${label}${extra}</a>`;
  return `<nav class="tabs" aria-label="Lists">
    ${tab('#/', 'My list', `list-${me.user.id}`, '', 'heart')}
    ${tab('#/shopping', 'My shopping', 'shopping', '', 'shopping-bag')}
    ${others
      .map((m) => tab(`#/list/${m.id}`, esc(m.name), `list-${m.id}`, `<span class="count">${m.itemCount}</span>`))
      .join('')}
    ${tab('#/family', 'Family', 'family', '', 'users')}
  </nav>`;
}

/** Year picker: this year plus every year the family has lists for. */
function yearPicker() {
  const years = [...new Set([THIS_YEAR, year, ...(me.years || [])])].sort((a, b) => b - a);
  return `<label class="year-picker">${icon('calendar', { size: 16 })}<span class="sr-only">Year</span>
    <select id="year-select" aria-label="Show lists for year">
      ${years.map((y) => `<option value="${y}" ${y === year ? 'selected' : ''}>${y}</option>`).join('')}
    </select>
  </label>`;
}

function wireYearPicker() {
  const sel = document.getElementById('year-select');
  if (sel) sel.onchange = () => {
    setYear(Number(sel.value));
    render();
  };
}

// ---------- auth ----------
function renderAuth(mode) {
  const invite = new URLSearchParams(location.search).get('invite') || '';
  const isSignup = mode === 'signup' || (mode === 'default' && Boolean(invite));
  app.innerHTML = `
    <section class="card narrow">
      <h1>${isSignup ? 'Create your account' : 'Welcome back'}</h1>
      <p class="muted">Share your wish list with family. They’ll coordinate who buys what — and you’ll never see the spoilers.</p>
      <form id="auth">
        ${isSignup ? `<label>Your name<input name="name" required maxlength="60" autocomplete="given-name" /></label>` : ''}
        <label>Email<input name="email" type="email" required autocomplete="email" /></label>
        <label>Password<input name="password" type="password" required minlength="${isSignup ? 8 : 1}"
          autocomplete="${isSignup ? 'new-password' : 'current-password'}" /></label>
        ${isSignup ? `<label>Family invite code <span class="muted">(optional)</span>
          <input name="inviteCode" value="${esc(invite)}" autocapitalize="characters" /></label>` : ''}
        <button class="btn primary" type="submit">${isSignup ? 'Sign up' : 'Sign in'}</button>
      </form>
      ${
        isSignup
          ? ''
          : `<details class="forgot">
              <summary>Forgot your password?</summary>
              <p>Ask the person who set up your family on Gift Wish. They can open <b>Family</b>, tap
                <b>Reset password</b> next to your name, and send you a link to choose a new one.</p>
            </details>`
      }
      <p class="switch">${
        isSignup
          ? 'Already have an account? <a href="#/login">Sign in</a>'
          : 'New here? <a href="#/signup">Create an account</a>'
      }</p>
    </section>`;

  document.getElementById('auth').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('POST', isSignup ? '/api/signup' : '/api/login', formData(e.target));
      location.hash = '#/';
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };
}

function renderOnboarding() {
  const invite = new URLSearchParams(location.search).get('invite') || '';
  app.innerHTML = `
    <section class="card narrow">
      <h1>Join your family</h1>
      <p class="muted">Lists are shared within a family group. Start a new one, or enter the invite code someone sent you.</p>
      <form id="join" class="stack">
        <label>Invite code<input name="code" required autocapitalize="characters" placeholder="e.g. K7M2QX9A" value="${esc(invite)}" /></label>
        <button class="btn primary">Join family</button>
      </form>
      <div class="divider"><span>or</span></div>
      <form id="create" class="stack">
        <label>Family name<input name="name" required maxlength="80" placeholder="The Smiths" /></label>
        <button class="btn">Start a new family</button>
      </form>
    </section>`;
  const submit = (path) => async (e) => {
    e.preventDefault();
    try {
      await api('POST', path, formData(e.target));
      location.hash = '#/family';
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };
  document.getElementById('join').onsubmit = submit('/api/families/join');
  document.getElementById('create').onsubmit = submit('/api/families');
}

// ---------- family ----------
function renderFamily() {
  const link = `${location.origin}/?invite=${encodeURIComponent(me.family.inviteCode)}`;
  app.innerHTML = `
    ${nav('family')}
    <section class="card">
      <h1>${esc(me.family.name)}</h1>
      <p>Invite family members by sending them this link, or have them enter the code when they sign up.</p>
      <div class="invite">
        <code class="code">${esc(me.family.inviteCode)}</code>
        <input readonly value="${esc(link)}" aria-label="Invite link" />
        <button class="btn" id="copy">${icon('copy', { size: 16 })}Copy link</button>
      </div>
      <h2>Members</h2>
      <ul class="members">
        ${me.members
          .map(
            (m) => `<li>
              <div class="member-name">
                <a href="${m.id === me.user.id ? '#/' : `#/list/${m.id}`}">${esc(m.name)}</a>
                ${m.id === me.user.id ? '<span class="muted">(you)</span>' : ''}
                ${m.id === me.family.organizerId ? '<span class="badge organizer">Organizer</span>' : ''}
              </div>
              <div class="member-side">
                <span class="muted">${m.itemCount} item${m.itemCount === 1 ? '' : 's'}</span>
                ${
                  me.family.isOrganizer && m.id !== me.user.id
                    ? `<button class="btn small ghost" data-reset="${m.id}">${icon('key-round', { size: 15 })}Reset password</button>`
                    : ''
                }
              </div>
            </li>`
          )
          .join('')}
      </ul>
      <p class="help member-help">${
        me.family.isOrganizer
          ? 'As the organizer, you can send anyone who forgets their password a link to choose a new one.'
          : `Forgot your password? ${esc(me.family.organizerName ?? 'The family organizer')} can send you a link to reset it.`
      }</p>
    </section>`;
  app.querySelectorAll('[data-reset]').forEach((btn) => {
    const member = me.members.find((m) => m.id === Number(btn.dataset.reset));
    btn.onclick = () => createResetLink(member);
  });
  document.getElementById('copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied!');
    } catch {
      toast('Copy failed — select the link and copy it manually', true);
    }
  };
}

// ---------- password reset ----------
async function createResetLink(member) {
  const ok = await confirmDialog({
    title: `Reset ${member.name}’s password?`,
    message: `You’ll get a link to send ${member.name}. Their current password keeps working until they use it.`,
    confirmLabel: 'Create link',
    icon: 'key-round',
  });
  if (!ok) return;
  let link;
  try {
    link = await api('POST', `/api/members/${member.id}/reset-link`);
  } catch (err) {
    return toast(err.message, true);
  }

  const dlg = document.getElementById('reset-link');
  dlg.querySelector('.confirm-icon').innerHTML = icon('key-round', { size: 22 });
  dlg.querySelector('#reset-link-title').textContent = `Send this link to ${member.name}`;
  dlg.querySelector('#reset-link-help').textContent =
    `Text or message it to them. It works once and expires in 24 hours. When they open it, they’ll choose a new password and be signed out everywhere else.`;
  const field = dlg.querySelector('#reset-link-url');
  field.value = link.url;

  const copyBtn = dlg.querySelector('#reset-link-copy');
  copyBtn.innerHTML = `${icon('copy', { size: 16 })}Copy link`;
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
      copyBtn.innerHTML = `${icon('check', { size: 16 })}Copied`;
    } catch {
      field.focus();
      field.select();
      toast('Copy didn’t work. The link is selected, so copy it from there.', true);
    }
  };

  const shareBtn = dlg.querySelector('#reset-link-share');
  const shareData = { title: 'Reset your Gift Wish password', text: `Here’s a link to reset your Gift Wish password:`, url: link.url };
  shareBtn.hidden = !(navigator.share && navigator.canShare?.(shareData));
  shareBtn.innerHTML = `${icon('share-2', { size: 16 })}Share`;
  shareBtn.onclick = () => navigator.share(shareData).catch(() => {});

  dlg.showModal();
}

async function renderPasswordReset(token) {
  let who;
  try {
    who = await api('POST', '/api/password-reset/check', { token });
  } catch (err) {
    app.innerHTML = `
      <section class="card narrow">
        <div class="confirm-icon">${icon('triangle-alert', { size: 22 })}</div>
        <h1>This link doesn’t work anymore</h1>
        <p class="muted">${esc(err.message)}</p>
        <a class="btn" href="#/login">Go to sign in</a>
      </section>`;
    return;
  }
  app.innerHTML = `
    <section class="card narrow">
      <div class="confirm-icon ok">${icon('key-round', { size: 22 })}</div>
      <h1>Choose a new password</h1>
      <p class="muted">For ${esc(who.name)}’s Gift Wish account. You’ll be signed in when you’re done.</p>
      <form id="reset-form">
        <label>New password<input name="password" type="password" required minlength="8" autocomplete="new-password" /></label>
        <label>Type it again<input name="again" type="password" required minlength="8" autocomplete="new-password" /></label>
        <button class="btn primary" type="submit">${icon('shield-check', { size: 16 })}Save password</button>
      </form>
    </section>`;
  app.querySelector('[name=password]').focus();
  document.getElementById('reset-form').onsubmit = async (e) => {
    e.preventDefault();
    const { password, again } = formData(e.target);
    if (password !== again) return toast('The two passwords don’t match', true);
    try {
      await api('POST', '/api/password-reset', { token, password });
      toast('Password saved. You’re signed in.');
      location.hash = '#/';
    } catch (err) {
      toast(err.message, true);
    }
  };
}

// ---------- lists ----------
async function renderList(userId) {
  let data;
  try {
    data = await api('GET', `/api/lists/${userId}?year=${year}`);
  } catch (err) {
    app.innerHTML = `${nav('')}<section class="card"><p>${esc(err.message)}</p></section>`;
    return;
  }
  const { owner, isMine, items, isOpen } = data;
  app.innerHTML = `
    ${nav(`list-${owner.id}`)}
    <section>
      <div class="list-head">
        <div class="title-row">
          <h1>${isMine ? 'My wish list' : `${esc(owner.name)}’s wish list`}</h1>
          ${yearPicker()}
        </div>
        ${
          isMine && isOpen
            ? `<div class="head-actions">
                <button class="btn" id="import">${icon('import')}Import from Amazon</button>
                <button class="btn primary" id="add">${icon('plus')}Add a wish</button>
              </div>`
            : ''
        }
      </div>
      ${
        !isOpen
          ? `<p class="hint past">${icon('lock')}<span>This is ${year}’s list. Past years are kept so you can look back, but they can’t be changed.
              ${isMine ? `Tap <b>Add to ${THIS_YEAR}</b> to bring a wish over to this year.` : ''}
              <button type="button" class="link-btn" id="to-this-year">Go to ${THIS_YEAR}</button></span></p>`
          : isMine
          ? `<p class="hint">${icon('eye-off')}<span>No peeking: you won’t see who is buying what from your list. Everyone else will, so nobody doubles up.</span></p>`
          : `<p class="hint">${icon('gift')}<span>Tap <b>I’ll get this</b> so others know, then <b>Mark bought</b> once you have it. ${esc(owner.name)} can’t see any of this.</span></p>`
      }
      <div id="editor"></div>
      <ul class="items">
        ${items.length ? items.map((i) => itemHtml(i, isMine, isOpen)).join('') : emptyHtml(isMine, owner, isOpen)}
      </ul>
    </section>`;

  wireYearPicker();
  const back = document.getElementById('to-this-year');
  if (back) back.onclick = () => {
    setYear(THIS_YEAR);
    render();
  };
  if (isMine && isOpen) {
    document.getElementById('add').onclick = () => openEditor(null);
    document.getElementById('import').onclick = () => openImporter();
  }
  app.querySelectorAll('[data-action]').forEach((btn) => {
    btn.onclick = () => onItemAction(btn.dataset.action, Number(btn.dataset.id), items, owner);
  });
}

function emptyHtml(isMine, owner, isOpen = true) {
  let text;
  if (!isOpen) text = isMine ? `You didn’t have a list in ${year}.` : `${esc(owner.name)} didn’t have a list in ${year}.`;
  else if (isMine) text = `Your ${year} list is empty. Add the first thing you’d love to get, or import your Amazon wish list.`;
  else text = `${esc(owner.name)} hasn’t added anything for ${year} yet.`;
  return `<li class="empty">${icon('package-open', { size: 28 })}<span>${text}</span></li>`;
}

function itemHtml(item, isMine, isOpen = true) {
  const c = item.claim;
  let status = '';
  let actions = '';
  let cls = '';

  if (isMine && !isOpen) {
    actions = `<button class="btn small" data-action="copy" data-id="${item.id}">${icon('copy-plus', { size: 15 })}Add to ${THIS_YEAR}</button>`;
  } else if (isMine) {
    actions = `<button class="btn small" data-action="edit" data-id="${item.id}">${icon('pencil', { size: 15 })}Edit</button>
               <button class="btn small ghost" data-action="delete" data-id="${item.id}">${icon('trash-2', { size: 15 })}Remove</button>`;
  } else if (item.removed) {
    cls = 'removed';
    status = `<span class="badge warn">${icon('triangle-alert', { size: 14 })}Removed from the list</span>`;
    actions = `<button class="btn small" data-action="release" data-id="${item.id}">${icon('x', { size: 15 })}Got it, dismiss</button>`;
  } else if (!c) {
    if (isOpen) actions = `<button class="btn small primary" data-action="claim" data-id="${item.id}">${icon('bookmark-plus', { size: 15 })}I’ll get this</button>
               <button class="btn small" data-action="purchase" data-id="${item.id}">${icon('check', { size: 15 })}I already bought it</button>`;
  } else if (c.byMe) {
    cls = c.status === 'purchased' ? 'bought' : 'mine';
    status =
      c.status === 'purchased'
        ? `<span class="badge done">${icon('circle-check', { size: 14 })}You bought this</span>`
        : `<span class="badge mine">${icon('bookmark-plus', { size: 14 })}You’re getting this</span>`;
    if (item.changes?.length) {
      cls += ' changed';
      status += changesHtml(item, c.status);
    }
    if (item.changes?.length) {
      actions += `<button class="btn small primary" data-action="seen" data-id="${item.id}">${icon('check', { size: 15 })}Got it</button>`;
    }
    if (isOpen) actions +=
      (c.status === 'claimed' ? `<button class="btn small primary" data-action="purchase" data-id="${item.id}">${icon('check', { size: 15 })}Mark bought</button>` : '') +
      `<button class="btn small ghost" data-action="release" data-id="${item.id}">${icon('undo-2', { size: 15 })}${c.status === 'purchased' ? 'Undo' : 'Release'}</button>`;
  } else {
    cls = c.status === 'purchased' ? 'bought' : 'taken';
    status =
      c.status === 'purchased'
        ? `<span class="badge done">${icon('circle-check', { size: 14 })}Bought by ${esc(c.userName)}</span>`
        : `<span class="badge taken">${icon('bookmark-plus', { size: 14 })}${esc(c.userName)} is getting this</span>`;
  }

  return `<li class="item ${cls}">
    <div class="item-main">
      <div class="item-title">
        <span class="title">${esc(item.title)}</span>
        <span class="prio p${item.priority}">${PRIORITY[item.priority]}</span>
      </div>
      <div class="meta">
        ${item.price ? `<span class="price">${esc(formatPrice(item.price))}</span>` : ''}
        ${item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${icon('external-link', { size: 14 })}${esc(hostOf(item.url))}</a>` : ''}
      </div>
      ${item.notes ? `<p class="notes">${esc(item.notes)}</p>` : ''}
      ${status}
    </div>
    <div class="actions">${actions}</div>
  </li>`;
}

/** "Changed since you bought this" notice: each changed field, old value struck through, new value after. */
function changesHtml(item, claimStatus) {
  const show = (field, value) => {
    if (value === null || value === '') return '<i>empty</i>';
    if (field === 'price') return esc(formatPrice(value));
    if (field === 'url') return esc(hostOf(value));
    return esc(value);
  };
  return `<div class="change-notice" role="note">
    <span class="badge warn">${icon('triangle-alert', { size: 14 })}Changed since you ${claimStatus === 'purchased' ? 'bought' : 'claimed'} this</span>
    <ul>
      ${item.changes
        .map(
          (ch) => `<li><b>${esc(ch.label)}:</b> <s>${show(ch.field, ch.from)}</s> ${icon('arrow-right', { size: 13 })}
            ${ch.field === 'url' && ch.to ? `<a href="${esc(ch.to)}" target="_blank" rel="noopener noreferrer">${show(ch.field, ch.to)}</a>` : show(ch.field, ch.to)}</li>`
        )
        .join('')}
    </ul>
  </div>`;
}

// ---------- import ----------
const IMPORT_SOURCES = [
  { key: 'wishlist', label: 'Wish list link', icon: 'link' },
  { key: 'links', label: 'Paste links', icon: 'clipboard-paste' },
  { key: 'file', label: 'Upload saved page', icon: 'upload' },
];

function openImporter(source = 'wishlist') {
  const box = document.getElementById('editor');
  const help = {
    wishlist: `<p class="help">On Amazon, open your wish list, choose <b>Send list to others</b>, and copy the link.
      The list needs to be <b>Public</b> or <b>Shared</b>.</p>
      <label>Amazon wish list link<input name="url" inputmode="url" required placeholder="https://www.amazon.com/hz/wishlist/ls/…" /></label>`,
    links: `<p class="help">Paste product links, one per line. They can be from Amazon or any other store.
      You can fix the names and prices before adding them.</p>
      <label>Links<textarea name="text" rows="5" required placeholder="https://www.amazon.com/…/dp/B00006JSUA"></textarea></label>`,
    file: `<p class="help">If the link doesn’t work, open your wish list on Amazon, scroll to the bottom so every item loads,
      then save the page (<b>File › Save Page As</b>) and choose that file here.</p>
      <label>Saved wish list page<input name="file" type="file" accept=".html,.htm,text/html" required /></label>`,
  };
  box.innerHTML = `
    <div class="card editor importer">
      <div class="row-between">
        <h2>Import from Amazon</h2>
        <button type="button" class="btn small ghost" id="close-import">${icon('x', { size: 15 })}Close</button>
      </div>
      <div class="segmented" role="tablist">
        ${IMPORT_SOURCES.map(
          (s) => `<button type="button" role="tab" class="seg ${s.key === source ? 'active' : ''}" aria-selected="${s.key === source}"
            data-source="${s.key}">${icon(s.icon, { size: 15 })}${s.label}</button>`
        ).join('')}
      </div>
      <form id="import-form">
        ${help[source]}
        <div class="row end"><button class="btn primary" id="find">Find items</button></div>
      </form>
      <div id="import-preview"></div>
    </div>`;
  box.querySelector('input, textarea').focus();
  document.getElementById('close-import').onclick = () => (box.innerHTML = '');
  box.querySelectorAll('[data-source]').forEach((b) => (b.onclick = () => openImporter(b.dataset.source)));

  document.getElementById('import-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('find');
    btn.disabled = true;
    btn.innerHTML = `${icon('loader-circle', { size: 16 })}Looking…`;
    btn.classList.add('busy');
    try {
      const f = e.target;
      const body = { source, year };
      if (source === 'wishlist') body.url = f.url.value;
      if (source === 'links') body.text = f.text.value;
      if (source === 'file') {
        const file = f.file.files[0];
        if (!file) throw new Error('Choose the saved wish list page');
        if (file.size > 8 * 1024 * 1024) throw new Error('That file is too large. Save the page as "HTML only" and try again.');
        body.html = await file.text();
      }
      const result = await api('POST', '/api/import/preview', body);
      renderImportPreview(result);
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
      btn.textContent = 'Find items';
    }
  };
}

function renderImportPreview({ listName, items }) {
  const box = document.getElementById('import-preview');
  const fresh = items.filter((i) => !i.alreadyOnList).length;
  box.innerHTML = `
    <form id="import-pick">
      <div class="row-between">
        <p class="help"><b>${items.length} item${items.length === 1 ? '' : 's'}</b> found${listName ? ` in “${esc(listName)}”` : ''}.
          Uncheck anything you don’t want, and fix names if needed.</p>
        <label class="check-all"><input type="checkbox" id="pick-all" ${fresh === items.length ? 'checked' : ''} /> Select all</label>
      </div>
      <ul class="pick-list">
        ${items
          .map(
            (it, n) => `<li class="pick ${it.alreadyOnList ? 'dupe' : ''}">
              <input type="checkbox" data-n="${n}" aria-label="Add ${esc(it.title)}" ${it.alreadyOnList ? '' : 'checked'} />
              <div class="pick-main">
                <input class="pick-title" data-n="${n}" value="${esc(it.title)}" maxlength="200" aria-label="Name" />
                <div class="meta">
                  ${it.price ? `<span class="price">${esc(formatPrice(it.price))}</span>` : ''}
                  ${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${icon('external-link', { size: 14 })}${esc(hostOf(it.url))}</a>` : ''}
                  ${it.priority !== 2 ? `<span class="prio p${it.priority}">${PRIORITY[it.priority]}</span>` : ''}
                  ${it.alreadyOnList ? '<span class="badge warn">Already on your list</span>' : ''}
                </div>
                ${it.notes ? `<p class="notes">${esc(it.notes)}</p>` : ''}
              </div>
            </li>`
          )
          .join('')}
      </ul>
      <div class="row end"><button class="btn primary" id="add-picked"></button></div>
    </form>`;

  const boxes = [...box.querySelectorAll('input[type=checkbox][data-n]')];
  const addBtn = document.getElementById('add-picked');
  const allBox = document.getElementById('pick-all');
  const update = () => {
    const n = boxes.filter((b) => b.checked).length;
    addBtn.disabled = n === 0;
    addBtn.innerHTML = n ? `${icon('plus')}Add ${n} item${n === 1 ? '' : 's'} to my list` : 'Choose items to add';
    allBox.checked = n === boxes.length;
  };
  boxes.forEach((b) => (b.onchange = update));
  allBox.onchange = () => {
    boxes.forEach((b) => (b.checked = allBox.checked));
    update();
  };
  update();
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });

  document.getElementById('import-pick').onsubmit = async (e) => {
    e.preventDefault();
    const titles = box.querySelectorAll('.pick-title');
    const chosen = boxes
      .filter((b) => b.checked)
      .map((b) => {
        const n = Number(b.dataset.n);
        const { title, url, price, notes, priority } = items[n];
        return { title: titles[n].value.trim() || title, url, price, notes, priority };
      });
    addBtn.disabled = true;
    try {
      const { added } = await api('POST', '/api/items/import', { items: chosen, year });
      toast(`Added ${added} item${added === 1 ? '' : 's'} to your list`);
      render();
    } catch (err) {
      toast(err.message, true);
      addBtn.disabled = false;
    }
  };
}

function openEditor(item) {
  const box = document.getElementById('editor');
  box.innerHTML = `
    <form class="card editor" id="item-form">
      <h2>${item ? 'Edit wish' : 'Add a wish'}</h2>
      <label>What is it?<input name="title" required maxlength="200" value="${esc(item?.title)}" placeholder="Wool hiking socks, size M" /></label>
      <label>Where to buy (link)<input name="url" inputmode="url" maxlength="2000" value="${esc(item?.url)}" placeholder="https://…" /></label>
      <div class="row">
        <label>Price
          <span class="money"><span class="money-sign" aria-hidden="true">$</span><input name="price" maxlength="40"
            inputmode="decimal" value="${esc(item?.price?.replace(/^\$\s*/, ''))}" placeholder="25" /></span>
        </label>
        <label>How much do you want it?
          <select name="priority">
            ${[1, 2, 3].map((p) => `<option value="${p}" ${(item?.priority ?? 2) === p ? 'selected' : ''}>${PRIORITY[p]}</option>`).join('')}
          </select>
        </label>
      </div>
      <label>Notes<textarea name="notes" maxlength="1000" rows="2" placeholder="Color, size, any brand is fine…">${esc(item?.notes)}</textarea></label>
      <div class="row end">
        <button type="button" class="btn ghost" id="cancel">Cancel</button>
        <button class="btn primary">${icon(item ? 'check' : 'plus')}${item ? 'Save' : 'Add to my list'}</button>
      </div>
    </form>`;
  box.querySelector('[name=title]').focus();
  document.getElementById('cancel').onclick = () => (box.innerHTML = '');
  document.getElementById('item-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(item ? 'PUT' : 'POST', item ? `/api/items/${item.id}` : '/api/items', { ...formData(e.target), year });
      toast(item ? 'Saved' : 'Added to your list');
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };
}

async function onItemAction(action, id, items, owner) {
  const item = items.find((i) => i.id === id);
  try {
    switch (action) {
      case 'edit':
        return openEditor(item);
      case 'delete':
        if (
          !(await confirmDialog({
            title: `Remove “${item.title}”?`,
            message: 'It will come off your wish list. This can’t be undone.',
            confirmLabel: 'Remove',
          }))
        ) {
          return;
        }
        await api('DELETE', `/api/items/${id}`);
        toast('Removed');
        break;
      case 'claim':
        await api('PUT', `/api/items/${id}/claim`, { status: 'claimed' });
        toast(`Got it — others will know you’re getting this for ${owner.name}`);
        break;
      case 'purchase':
        await api('PUT', `/api/items/${id}/claim`, { status: 'purchased' });
        toast('Marked as bought');
        break;
      case 'release':
        await api('DELETE', `/api/items/${id}/claim`);
        break;
      case 'seen':
        await api('POST', `/api/items/${id}/claim/seen`);
        toast('Got it');
        break;
      case 'copy':
        await api('POST', `/api/items/${id}/copy`, { year: THIS_YEAR });
        toast(`Added “${item.title}” to your ${THIS_YEAR} list`);
        break;
    }
  } catch (err) {
    toast(err.message, true);
  }
  render();
}

// ---------- shopping ----------
async function renderShopping() {
  const { items } = await api('GET', `/api/claims?year=${year}`);
  const groups = new Map();
  for (const i of items) {
    if (!groups.has(i.ownerId)) groups.set(i.ownerId, { name: i.ownerName, items: [] });
    groups.get(i.ownerId).items.push(i);
  }
  const todo = items.filter((i) => i.claim.status === 'claimed' && !i.removed).length;
  app.innerHTML = `
    ${nav('shopping')}
    <section>
      <div class="list-head"><div class="title-row"><h1>My shopping</h1>${yearPicker()}</div></div>
      <p class="hint">${
        items.length
          ? `${year}: ${todo} still to buy, ${items.length - todo} done.`
          : year < THIS_YEAR
          ? `You didn’t claim anything in ${year}.`
          : 'Nothing yet. Open someone’s list and tap <b>I’ll get this</b>.'
      }</p>
      ${[...groups.values()]
        .map(
          (g) => `<h2 class="group">For ${esc(g.name)}</h2>
          <ul class="items">${g.items.map((i) => itemHtml(i, false, year >= THIS_YEAR)).join('')}</ul>`
        )
        .join('')}
    </section>`;
  wireYearPicker();
  app.querySelectorAll('[data-action]').forEach((btn) => {
    const item = items.find((i) => i.id === Number(btn.dataset.id));
    btn.onclick = () => onItemAction(btn.dataset.action, item.id, items, { name: item.ownerName });
  });
}

render().catch((err) => {
  app.innerHTML = `<section class="card narrow"><p>Couldn’t load the app: ${esc(err.message)}</p></section>`;
});
