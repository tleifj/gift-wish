// Gift Wish — a tiny single-page app with hash routing. No build step.
import { icon } from './icons.js';
const app = document.getElementById('app');
const account = document.getElementById('account');
const toastEl = document.getElementById('toast');

let me = null; // { user, family, members }

// ---------- helpers ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

const PRIORITY = { 1: 'Most wanted', 2: 'Would like', 3: 'Nice to have' };

// ---------- routing ----------
window.addEventListener('hashchange', render);

async function loadMe() {
  try {
    me = await api('GET', '/api/me');
  } catch (e) {
    if (e.status !== 401) throw e;
    me = null;
  }
}

async function render() {
  await loadMe();
  renderAccount();
  const hash = location.hash.replace(/^#/, '') || '/';

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
            (m) => `<li><a href="${m.id === me.user.id ? '#/' : `#/list/${m.id}`}">${esc(m.name)}${
              m.id === me.user.id ? ' <span class="muted">(you)</span>' : ''
            }</a><span class="muted">${m.itemCount} item${m.itemCount === 1 ? '' : 's'}</span></li>`
          )
          .join('')}
      </ul>
    </section>`;
  document.getElementById('copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied!');
    } catch {
      toast('Copy failed — select the link and copy it manually', true);
    }
  };
}

// ---------- lists ----------
async function renderList(userId) {
  let data;
  try {
    data = await api('GET', `/api/lists/${userId}`);
  } catch (err) {
    app.innerHTML = `${nav('')}<section class="card"><p>${esc(err.message)}</p></section>`;
    return;
  }
  const { owner, isMine, items } = data;
  app.innerHTML = `
    ${nav(`list-${owner.id}`)}
    <section>
      <div class="list-head">
        <h1>${isMine ? 'My wish list' : `${esc(owner.name)}’s wish list`}</h1>
        ${isMine ? `<button class="btn primary" id="add">${icon('plus')}Add a wish</button>` : ''}
      </div>
      ${
        isMine
          ? `<p class="hint">${icon('eye-off')}<span>No peeking: you won’t see who is buying what from your list. Everyone else will, so nobody doubles up.</span></p>`
          : `<p class="hint">${icon('gift')}<span>Tap <b>I’ll get this</b> so others know, then <b>Mark bought</b> once you have it. ${esc(owner.name)} can’t see any of this.</span></p>`
      }
      <div id="editor"></div>
      <ul class="items">
        ${items.length ? items.map((i) => itemHtml(i, isMine)).join('') : emptyHtml(isMine, owner)}
      </ul>
    </section>`;

  if (isMine) {
    document.getElementById('add').onclick = () => openEditor(null);
  }
  app.querySelectorAll('[data-action]').forEach((btn) => {
    btn.onclick = () => onItemAction(btn.dataset.action, Number(btn.dataset.id), items, owner);
  });
}

function emptyHtml(isMine, owner) {
  return `<li class="empty">${icon('package-open', { size: 28 })}<span>${
    isMine ? 'Your list is empty. Add the first thing you’d love to get!' : `${esc(owner.name)} hasn’t added anything yet.`
  }</span></li>`;
}

function itemHtml(item, isMine) {
  const c = item.claim;
  let status = '';
  let actions = '';
  let cls = '';

  if (isMine) {
    actions = `<button class="btn small" data-action="edit" data-id="${item.id}">${icon('pencil', { size: 15 })}Edit</button>
               <button class="btn small ghost" data-action="delete" data-id="${item.id}">${icon('trash-2', { size: 15 })}Remove</button>`;
  } else if (item.removed) {
    cls = 'removed';
    status = `<span class="badge warn">${icon('triangle-alert', { size: 14 })}Removed from the list</span>`;
    actions = `<button class="btn small" data-action="release" data-id="${item.id}">${icon('x', { size: 15 })}Got it, dismiss</button>`;
  } else if (!c) {
    actions = `<button class="btn small primary" data-action="claim" data-id="${item.id}">${icon('bookmark-plus', { size: 15 })}I’ll get this</button>
               <button class="btn small" data-action="purchase" data-id="${item.id}">${icon('check', { size: 15 })}I already bought it</button>`;
  } else if (c.byMe) {
    cls = c.status === 'purchased' ? 'bought' : 'mine';
    status =
      c.status === 'purchased'
        ? `<span class="badge done">${icon('circle-check', { size: 14 })}You bought this</span>`
        : `<span class="badge mine">${icon('bookmark-plus', { size: 14 })}You’re getting this</span>`;
    actions =
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
        ${item.price ? `<span>${esc(item.price)}</span>` : ''}
        ${item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${icon('external-link', { size: 14 })}${esc(hostOf(item.url))}</a>` : ''}
      </div>
      ${item.notes ? `<p class="notes">${esc(item.notes)}</p>` : ''}
      ${status}
    </div>
    <div class="actions">${actions}</div>
  </li>`;
}

function openEditor(item) {
  const box = document.getElementById('editor');
  box.innerHTML = `
    <form class="card editor" id="item-form">
      <h2>${item ? 'Edit wish' : 'Add a wish'}</h2>
      <label>What is it?<input name="title" required maxlength="200" value="${esc(item?.title)}" placeholder="Wool hiking socks, size M" /></label>
      <label>Where to buy (link)<input name="url" inputmode="url" maxlength="2000" value="${esc(item?.url)}" placeholder="https://…" /></label>
      <div class="row">
        <label>Price<input name="price" maxlength="40" value="${esc(item?.price)}" placeholder="$25" /></label>
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
      await api(item ? 'PUT' : 'POST', item ? `/api/items/${item.id}` : '/api/items', formData(e.target));
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
        if (!confirm(`Remove “${item.title}” from your list?`)) return;
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
    }
  } catch (err) {
    toast(err.message, true);
  }
  render();
}

// ---------- shopping ----------
async function renderShopping() {
  const { items } = await api('GET', '/api/claims');
  const groups = new Map();
  for (const i of items) {
    if (!groups.has(i.ownerId)) groups.set(i.ownerId, { name: i.ownerName, items: [] });
    groups.get(i.ownerId).items.push(i);
  }
  const todo = items.filter((i) => i.claim.status === 'claimed' && !i.removed).length;
  app.innerHTML = `
    ${nav('shopping')}
    <section>
      <div class="list-head"><h1>My shopping</h1></div>
      <p class="hint">${
        items.length
          ? `${todo} still to buy, ${items.length - todo} done.`
          : 'Nothing yet. Open someone’s list and tap <b>I’ll get this</b>.'
      }</p>
      ${[...groups.values()]
        .map(
          (g) => `<h2 class="group">For ${esc(g.name)}</h2>
          <ul class="items">${g.items.map((i) => itemHtml(i, false)).join('')}</ul>`
        )
        .join('')}
    </section>`;
  app.querySelectorAll('[data-action]').forEach((btn) => {
    const item = items.find((i) => i.id === Number(btn.dataset.id));
    btn.onclick = () => onItemAction(btn.dataset.action, item.id, items, { name: item.ownerName });
  });
}

render().catch((err) => {
  app.innerHTML = `<section class="card narrow"><p>Couldn’t load the app: ${esc(err.message)}</p></section>`;
});
