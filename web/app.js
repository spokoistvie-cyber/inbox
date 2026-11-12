/* «Входящие» — клиент.
 * Сервер держит доступ к Dropbox; здесь — вход, отправка и офлайн-очередь.
 */
'use strict';

const TARGETS = {
  galina: { label: 'Галине' },
  artem: { label: 'Артёму' }
};

const K_TARGET = 'inbox:target';
const K_RECENT = 'inbox:recent';
const K_USER = 'inbox:user';

const state = {
  user: null,
  users: [],
  target: localStorage.getItem(K_TARGET) || 'galina',
  files: [],
  sending: false,
  installPrompt: null,
  loginUser: null
};

const $ = (sel) => document.querySelector(sel);
const el = {
  statusLine: $('#status-line'),
  installBtn: $('#install-btn'),
  userBtn: $('#user-btn'),
  loginScreen: $('#login-screen'),
  loginUsers: $('#login-users'),
  loginPass: $('#login-pass'),
  loginBtn: $('#login-btn'),
  loginError: $('#login-error'),
  sendScreen: $('#send-screen'),
  segBtns: [...document.querySelectorAll('.seg-btn')],
  msg: $('#msg'),
  pickBtn: $('#pick-btn'),
  fileInput: $('#file-input'),
  files: $('#files'),
  sendBtn: $('#send-btn'),
  queueBox: $('#queue-box'),
  queue: $('#queue'),
  recentBox: $('#recent-box'),
  recent: $('#recent'),
  toast: $('#toast')
};

/* ─────────── утилиты ─────────── */

function readJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}
function pad2(n) { return String(n).padStart(2, '0'); }
function humanTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    : `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} МБ`;
}
function extOf(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? m[1].toUpperCase().slice(0, 4) : 'FILE';
}
function short(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

let toastTimer = null;
function toast(text, kind = '') {
  el.toast.textContent = text;
  el.toast.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.className = 'toast ' + kind; }, 3600);
}

async function api(path, options = {}) {
  const res = await fetch(path, Object.assign({ credentials: 'same-origin' }, options));
  let data = null;
  try { data = await res.json(); } catch { /* не JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || ('Ошибка ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ─────────── вход ─────────── */

async function loadUsers() {
  try {
    state.users = await api('/api/users');
  } catch {
    state.users = [{ id: 'galina', name: 'Галина' }, { id: 'artem', name: 'Артём' }];
  }
  state.loginUser = state.users[0] ? state.users[0].id : null;
  renderLoginUsers();
}

function renderLoginUsers() {
  el.loginUsers.innerHTML = '';
  for (const u of state.users) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn' + (u.id === state.loginUser ? ' is-active' : '');
    b.dataset.user = u.id;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(u.id === state.loginUser));
    const name = document.createElement('span');
    name.className = 'seg-name';
    name.textContent = u.name;
    b.append(name);
    b.onclick = () => { state.loginUser = u.id; renderLoginUsers(); el.loginPass.focus(); };
    el.loginUsers.append(b);
  }
}

async function doLogin() {
  el.loginError.hidden = true;
  if (!state.loginUser) return;
  const pass = el.loginPass.value;
  if (!pass) { el.loginPass.focus(); return; }
  el.loginBtn.disabled = true;
  el.loginBtn.textContent = 'Проверяю…';
  try {
    const data = await api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: state.loginUser, pass })
    });
    el.loginPass.value = '';
    setUser(data.user);
  } catch (err) {
    el.loginError.textContent = err.status === 401 ? 'Пароль не подошёл. Попробуй ещё раз.' : err.message;
    el.loginError.hidden = false;
    el.loginPass.select();
  } finally {
    el.loginBtn.disabled = false;
    el.loginBtn.textContent = 'Войти';
  }
}

async function logout() {
  if (!confirm('Выйти из приложения на этом телефоне?')) return;
  try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  setUser(null);
}

function setUser(user) {
  state.user = user;
  writeJSON(K_USER, user);
  renderStatus();
  renderRecent();
  renderQueue();
  if (user) flushOutbox();
}

/* ─────────── отправка ─────────── */

function draftFromUi() {
  return {
    id: (crypto.randomUUID ? crypto.randomUUID() : 'd' + Date.now() + Math.random()),
    target: state.target,
    text: el.msg.value.trim(),
    files: state.files.map((f) => ({ name: f.name, blob: f.blob })),
    createdAt: new Date().toISOString()
  };
}

async function postDraft(draft) {
  const fd = new FormData();
  fd.append('target', draft.target);
  fd.append('text', draft.text || '');
  for (const f of draft.files) {
    fd.append('files', f.blob, f.name);
  }
  return api('/api/send', { method: 'POST', body: fd });
}

async function handleSend() {
  if (state.sending) return;
  const draft = draftFromUi();
  if (!draft.text && !draft.files.length) return;

  state.sending = true;
  el.sendBtn.classList.add('busy');
  el.sendBtn.textContent = 'Отправляю…';
  el.sendBtn.disabled = true;

  try {
    if (!navigator.onLine) {
      await outboxPut(draft);
      toast('Нет сети — отправлю, когда появится', 'ok');
      clearComposer();
      return;
    }
    const result = await postDraft(draft);
    rememberRecent(draft);
    toast(`Отправлено ✓ ${result.uploaded.length} шт.`, 'ok');
    clearComposer();
  } catch (err) {
    if (err.status === 401) {
      setUser(null);
      toast('Сессия закончилась — войди снова', 'err');
    } else if (!err.status) {
      await outboxPut(draft).catch(() => {});
      clearComposer();
      toast('Связь пропала — сообщение в очереди', 'ok');
    } else {
      toast(err.message || 'Не отправилось', 'err');
    }
  } finally {
    state.sending = false;
    el.sendBtn.classList.remove('busy');
    el.sendBtn.textContent = 'Отправить';
    renderSendState();
    flushOutbox();
  }
}

function rememberRecent(draft) {
  const list = readJSON(K_RECENT, []);
  list.unshift({
    at: new Date().toISOString(),
    target: draft.target,
    userId: state.user ? state.user.id : '',
    text: draft.text.slice(0, 120),
    files: draft.files.map((f) => f.name)
  });
  writeJSON(K_RECENT, list.slice(0, 6));
  renderRecent();
}

function clearComposer() {
  el.msg.value = '';
  state.files = [];
  renderFiles();
  renderSendState();
}

/* ─────────── очередь (IndexedDB) ─────────── */

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('inbox-app', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('outbox', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function outboxAll() {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readonly').objectStore('outbox').getAll();
      tx.onsuccess = () => resolve(tx.result || []);
      tx.onerror = () => reject(tx.error);
    });
  } catch { return []; }
}
async function outboxPut(item) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outbox', 'readwrite').objectStore('outbox').put(item);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function outboxDel(id) {
  const db = await idb();
  return new Promise((resolve) => {
    const tx = db.transaction('outbox', 'readwrite').objectStore('outbox').delete(id);
    tx.onsuccess = () => resolve();
    tx.onerror = () => resolve();
  });
}
async function renderQueue() {
  const items = await outboxAll();
  el.queueBox.hidden = items.length === 0;
  el.queue.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'li-title';
    title.textContent = (it.text ? short(it.text, 40) : it.files.map((f) => f.name).join(', ')) || 'сообщение';
    const sub = document.createElement('span');
    sub.className = 'li-sub ' + (it.tries ? 'li-warn' : '');
    sub.textContent = it.tries ? `жду ${it.tries}×` : 'в очереди';
    li.append(title, sub);
    el.queue.append(li);
  }
}
async function flushOutbox() {
  if (!navigator.onLine || !state.user) return;
  const items = await outboxAll();
  for (const it of items) {
    try {
      await postDraft(it);
      await outboxDel(it.id);
      toast('Очередь отправлена ✓', 'ok');
    } catch (err) {
      if (err.status === 401) break;
      it.tries = (it.tries || 0) + 1;
      await outboxPut(it);
    }
  }
  renderQueue();
}

/* ─────────── отрисовка ─────────── */

function renderFiles() {
  el.files.innerHTML = '';
  for (const [i, f] of state.files.entries()) {
    const li = document.createElement('li');
    li.className = 'file-chip';
    const ico = document.createElement('span');
    ico.className = 'file-ico';
    ico.textContent = extOf(f.name);
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = f.name;
    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = humanSize(f.size);
    meta.append(name, size);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'file-x';
    x.textContent = '×';
    x.setAttribute('aria-label', 'убрать ' + f.name);
    x.onclick = () => { state.files.splice(i, 1); renderFiles(); renderSendState(); };
    li.append(ico, meta, x);
    el.files.append(li);
  }
}

function renderSendState() {
  const hasContent = el.msg.value.trim().length > 0 || state.files.length > 0;
  el.sendBtn.disabled = !(hasContent && !!state.user) || state.sending;
  el.segBtns.forEach((b) => {
    const on = b.dataset.target === state.target;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-checked', String(on));
  });
}

function renderRecent() {
  const list = readJSON(K_RECENT, []);
  el.recentBox.hidden = list.length === 0;
  el.recent.innerHTML = '';
  for (const r of list.slice(0, 4)) {
    const li = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'li-title';
    title.textContent = `${TARGETS[r.target] ? TARGETS[r.target].label : ''}: ${short(r.text || r.files.join(', ') || 'файлы', 32)}`;
    const sub = document.createElement('span');
    sub.className = 'li-sub';
    sub.textContent = humanTime(r.at);
    li.append(title, sub);
    el.recent.append(li);
  }
}

function renderStatus() {
  const user = state.user;
  el.loginScreen.hidden = !!user;
  el.sendScreen.hidden = !user;
  el.userBtn.hidden = !user;
  el.userBtn.textContent = user ? user.name + ' · выйти' : '';
  el.statusLine.textContent = user
    ? (navigator.onLine ? 'Вошёл: ' + user.name : 'Нет сети')
    : 'Нужен вход';
  el.statusLine.className = 'status ' + (user ? 'ok' : 'bad');
  renderFiles();
  renderSendState();
}

/* ─────────── события ─────────── */

function wire() {
  el.loginBtn.addEventListener('click', doLogin);
  el.loginPass.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  el.userBtn.addEventListener('click', logout);

  el.pickBtn.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => {
    for (const f of el.fileInput.files || []) {
      if (state.files.some((x) => x.name === f.name && x.size === f.size)) continue;
      state.files.push({ name: f.name, size: f.size, blob: f });
    }
    el.fileInput.value = '';
    renderFiles();
    renderSendState();
  });

  el.msg.addEventListener('input', renderSendState);
  el.sendBtn.addEventListener('click', handleSend);
  el.segBtns.forEach((b) => b.addEventListener('click', () => {
    state.target = b.dataset.target;
    localStorage.setItem(K_TARGET, state.target);
    renderSendState();
  }));

  window.addEventListener('online', () => { renderStatus(); flushOutbox(); });
  window.addEventListener('offline', () => { renderStatus(); toast('Нет сети — отправка подождёт', 'err'); });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    el.installBtn.hidden = false;
  });
  el.installBtn.addEventListener('click', async () => {
    if (!state.installPrompt) {
      toast('Открой меню браузера → «Добавить на главный экран»');
      return;
    }
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    el.installBtn.hidden = true;
  });
  window.addEventListener('appinstalled', () => { el.installBtn.hidden = true; });
  if (matchMedia('(display-mode: standalone)').matches) el.installBtn.hidden = true;
}

/* ─────────── запуск ─────────── */

async function boot() {
  wire();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  try {
    const me = await api('/api/me');
    setUser(me.user);
  } catch {
    setUser(null);
  }
  await loadUsers();
  renderStatus();
  renderRecent();
  renderQueue();
}

boot();
