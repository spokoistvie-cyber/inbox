/* «Входящие» — отправка сообщения и файлов в Dropbox.
 *
 * Архитектура: статическое приложение без своего сервера и без секретов.
 * Токен Dropbox получается прямо в браузере по OAuth 2 + PKCE (публичный клиент,
 * app key не секретен) и хранится только на этом устройстве. Файлы уходят
 * в Dropbox API напрямую.
 *
 * Один раз нужно разрешить доступ («Подключить Dropbox»), дальше — без входа.
 */
'use strict';

/* ───────────── настройки ───────────── */

const APP_KEY = 'lxrjcx9p74ogq04'; // приложение Dropbox «galina-base-dsh» (PKCE, без секрета)
const REDIRECT_URI = location.origin + '/';
const MAX_FILE = 150 * 1024 * 1024; // простой upload в Dropbox — до 150 МБ
const SENDER = 'Галины';

const TARGETS = {
  galina: {
    label: 'Галине',
    path: '/Галина Старченко/Архив Claude/База/99_Входящие',
    home: 'https://www.dropbox.com/home/%D0%93%D0%B0%D0%BB%D0%B8%D0%BD%D0%B0%20%D0%A1%D1%82%D0%B0%D1%80%D1%87%D0%B5%D0%BD%D0%BA%D0%BE/%D0%90%D1%80%D1%85%D0%B8%D0%B2%20Claude/%D0%91%D0%B0%D0%B7%D0%B0/99_%D0%92%D1%85%D0%BE%D0%B4%D1%8F%D1%89%D0%B8%D0%B5'
  },
  artem: {
    label: 'Артёму',
    path: '/Артем Старченко/0. Входящие',
    home: 'https://www.dropbox.com/home/%D0%90%D1%80%D1%82%D0%B5%D0%BC%20%D0%A1%D1%82%D0%B0%D1%80%D1%87%D0%B5%D0%BD%D0%BA%D0%BE/0.%20%D0%92%D1%85%D0%BE%D0%B4%D1%8F%D1%89%D0%B8%D0%B5'
  }
};

const K_AUTH = 'inbox:auth';
const K_VERIFIER = 'inbox:verifier';
const K_RECENT = 'inbox:recent';
const K_TARGET = 'inbox:target';

/* ───────────── состояние ───────────── */

const state = {
  target: localStorage.getItem(K_TARGET) || 'galina',
  files: [],            // [{name, size, blob}]
  sending: false,
  auth: readJSON(K_AUTH, null),
  installPrompt: null
};

const $ = (sel) => document.querySelector(sel);
const el = {
  statusLine: $('#status-line'),
  installBtn: $('#install-btn'),
  connectScreen: $('#connect-screen'),
  connectBtn: $('#connect-btn'),
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

/* ───────────── мелкие помощники ───────────── */

function readJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* переполнение — не критично */ }
}
function b64url(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
function randomVerifier() {
  const a = new Uint8Array(48);
  crypto.getRandomValues(a);
  return b64url(a);
}
function pad2(n) { return String(n).padStart(2, '0'); }
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}-${pad2(d.getMinutes())}`;
}
function humanTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
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
function cleanFileName(name) {
  let base = String(name || 'файл').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  if (base.length > 150) {
    const m = /(\.[a-z0-9]{1,6})$/i.exec(base);
    const ext = m ? m[1] : '';
    base = base.slice(0, 150 - ext.length) + ext;
  }
  return base || 'файл';
}
let toastTimer = null;
function toast(text, kind = '') {
  el.toast.textContent = text;
  el.toast.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.className = 'toast ' + kind; }, 3600);
}

/* ───────────── OAuth: подключение Dropbox ───────────── */

async function startAuth() {
  const verifier = randomVerifier();
  localStorage.setItem(K_VERIFIER, verifier);
  const challenge = b64url(await sha256(verifier));
  const url = 'https://www.dropbox.com/oauth2/authorize'
    + '?client_id=' + encodeURIComponent(APP_KEY)
    + '&response_type=code'
    + '&code_challenge=' + challenge
    + '&code_challenge_method=S256'
    + '&token_access_type=offline'
    + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI);
  location.href = url;
}

async function finishAuth(code) {
  const verifier = localStorage.getItem(K_VERIFIER);
  if (!verifier) return false;
  const body = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    client_id: APP_KEY,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier
  });
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error('Dropbox не принял вход: ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  saveTokens(data);
  localStorage.removeItem(K_VERIFIER);
  return true;
}

function saveTokens(data) {
  state.auth = {
    refresh: data.refresh_token || (state.auth && state.auth.refresh) || '',
    access: data.access_token,
    expires: Date.now() + (data.expires_in || 14400) * 1000
  };
  writeJSON(K_AUTH, state.auth);
}

async function accessToken(force = false) {
  if (!state.auth) return null;
  if (!force && state.auth.access && state.auth.expires - 60000 > Date.now()) return state.auth.access;
  if (!state.auth.refresh) return null;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: state.auth.refresh,
    client_id: APP_KEY
  });
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) disconnect();
    throw new Error('Не удалось продлить доступ к Dropbox');
  }
  saveTokens(await res.json());
  return state.auth.access;
}

function disconnect() {
  state.auth = null;
  localStorage.removeItem(K_AUTH);
}

/* ───────────── Dropbox API ───────────── */

/** Заголовок Dropbox-API-Arg: JSON с \uXXXX для не-ASCII (кириллица в пути иначе ломает заголовок). */
function dropboxArg(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

async function uploadBlob(path, blob) {
  const token = await accessToken();
  if (!token) throw new AuthError('Dropbox не подключён');

  const send = (tok) => fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + tok,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': dropboxArg({ path, mode: 'add', autorename: true, mute: true })
    },
    body: blob
  });

  let res = await send(token);
  if (res.status === 401) {
    const fresh = await accessToken(true);
    res = await send(fresh);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error_summary || ''; } catch { /* ignore */ }
    throw new Error('Dropbox: ' + (detail || ('ошибка ' + res.status)));
  }
  return res.json();
}

class AuthError extends Error {}

/* ───────────── отправка ───────────── */

function draftFromUi() {
  return {
    id: (crypto.randomUUID ? crypto.randomUUID() : 'd' + Date.now() + Math.random()),
    target: state.target,
    text: el.msg.value.trim(),
    files: state.files.map((f) => ({ name: f.name, blob: f.blob })),
    createdAt: new Date().toISOString()
  };
}

function messageMarkdown(draft) {
  const when = new Date(draft.createdAt || Date.now());
  const lines = [
    '# Сообщение из приложения «Входящие»',
    '',
    `- Когда: ${when.toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' })}`,
    `- Кому: ${TARGETS[draft.target].label}`,
    draft.files.length
      ? '- Файлы: ' + draft.files.map((f) => `${f.name} (${humanSize(f.blob.size)})`).join(', ')
      : '- Файлы: нет',
    '',
    '---',
    '',
    draft.text || '(без текста)',
    ''
  ];
  return lines.join('\n');
}

async function sendDraft(draft, onProgress = () => {}) {
  const dir = TARGETS[draft.target].path;
  const prefix = stamp(new Date(draft.createdAt || Date.now()));
  const total = draft.files.length + (draft.text ? 1 : 0);
  let done = 0;

  for (const f of draft.files) {
    const name = `${prefix} — ${cleanFileName(f.name)}`;
    await uploadBlob(`${dir}/${name}`, f.blob);
    done += 1;
    onProgress(done, total, f.name);
  }

  if (draft.text) {
    const name = `${prefix} — от ${SENDER}.md`;
    const blob = new Blob([messageMarkdown(draft)], { type: 'text/markdown; charset=utf-8' });
    await uploadBlob(`${dir}/${name}`, blob);
    done += 1;
    onProgress(done, total, name);
  }

  rememberRecent(draft);
  return true;
}

function rememberRecent(draft) {
  const list = readJSON(K_RECENT, []);
  const entry = {
    at: new Date().toISOString(),
    target: draft.target,
    text: draft.text.slice(0, 120),
    files: draft.files.map((f) => f.name)
  };
  list.unshift(entry);
  writeJSON(K_RECENT, list.slice(0, 6));
  renderRecent();
}

async function handleSend() {
  if (state.sending) return;
  const draft = draftFromUi();
  if (!draft.text && !draft.files.length) return;
  if (!state.auth) { showConnect(); return; }

  const tooBig = state.files.find((f) => f.size > MAX_FILE);
  if (tooBig) { toast(`«${tooBig.name}» больше 150 МБ — такое пока не отправляется`, 'err'); return; }

  state.sending = true;
  setBusy(true, 'Отправляю…');
  try {
    if (!navigator.onLine) {
      await outboxPut(draft);
      toast('Нет сети — отправлю, когда появится', 'ok');
      clearComposer();
      return;
    }
    await sendDraft(draft, (i, n, name) => setBusy(true, n > 1 ? `Отправляю ${i} из ${n}…` : `Отправляю «${short(name, 18)}»…`));
    toast('Отправлено ✓', 'ok');
    clearComposer();
  } catch (err) {
    if (err instanceof AuthError) {
      showConnect();
      toast('Нужно заново разрешить доступ к Dropbox', 'err');
    } else if (isNetworkError(err)) {
      if (draft.files.length || draft.text) {
        await outboxPut(draft);
        clearComposer();
        toast('Связь пропала — сообщение в очереди', 'ok');
      }
    } else {
      toast(err.message || 'Не отправилось', 'err');
    }
  } finally {
    state.sending = false;
    setBusy(false);
    render();
    flushOutbox();
  }
}

function isNetworkError(err) {
  return err instanceof TypeError || /fetch|network|Failed to fetch/i.test(String(err && err.message));
}
function short(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function setBusy(busy, label) {
  el.sendBtn.classList.toggle('busy', !!busy);
  el.sendBtn.textContent = busy ? (label || 'Отправляю…') : 'Отправить';
}

function clearComposer() {
  el.msg.value = '';
  state.files = [];
  renderFiles();
  renderSendState();
}

/* ───────────── очередь (IndexedDB) ───────────── */

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

let flushing = false;
async function flushOutbox() {
  if (flushing || !navigator.onLine || !state.auth) return;
  flushing = true;
  try {
    const items = await outboxAll();
    for (const it of items) {
      try {
        await sendDraft(it);
        await outboxDel(it.id);
        toast('Очередь отправлена ✓', 'ok');
      } catch (err) {
        if (err instanceof AuthError) break;
        it.tries = (it.tries || 0) + 1;
        await outboxPut(it);
      }
    }
  } finally {
    flushing = false;
    renderQueue();
    renderRecent();
  }
}

/* ───────────── отрисовка ───────────── */

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
    x.className = 'file-x';
    x.type = 'button';
    x.textContent = '×';
    x.setAttribute('aria-label', 'убрать ' + f.name);
    x.onclick = () => { state.files.splice(i, 1); renderFiles(); renderSendState(); };
    li.append(ico, meta, x);
    el.files.append(li);
  }
}

function renderSendState() {
  const ready = (el.msg.value.trim().length > 0 || state.files.length > 0) && !!state.auth && !state.sending;
  el.sendBtn.disabled = !ready;
}

function renderRecent() {
  const list = readJSON(K_RECENT, []);
  el.recentBox.hidden = list.length === 0;
  el.recent.innerHTML = '';
  for (const r of list.slice(0, 4)) {
    const li = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'li-title';
    const what = r.text || r.files.join(', ') || 'файлы';
    title.textContent = `${TARGETS[r.target] ? TARGETS[r.target].label : ''}: ${short(what, 34)}`;
    const sub = document.createElement('span');
    sub.className = 'li-sub';
    sub.textContent = humanTime(r.at);
    const link = document.createElement('a');
    link.className = 'li-link';
    link.href = (TARGETS[r.target] || TARGETS.galina).home;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'открыть';
    li.append(title, sub, link);
    el.recent.append(li);
  }
}

function renderStatus() {
  const connected = !!state.auth;
  el.statusLine.textContent = connected ? 'Dropbox подключён' : 'Dropbox не подключён';
  el.statusLine.className = 'status ' + (connected ? 'ok' : 'bad');
  el.connectScreen.hidden = connected;
  el.sendScreen.hidden = !connected;
  el.segBtns.forEach((b) => {
    const on = b.dataset.target === state.target;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-checked', String(on));
  });
  renderFiles();
  renderSendState();
}

function showConnect() {
  state.auth = null;
  renderStatus();
}

/* ───────────── обработчики ───────────── */

function wire() {
  el.connectBtn.addEventListener('click', startAuth);
  el.pickBtn.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => {
    for (const f of el.fileInput.files || []) {
      if (state.files.some((x) => x.name === f.name && x.size === f.size)) continue;
      if (f.size > MAX_FILE) { toast(`«${f.name}» больше 150 МБ — пропустил`, 'err'); continue; }
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
    renderStatus();
  }));
  window.addEventListener('online', () => { flushOutbox(); renderStatus(); });
  window.addEventListener('offline', () => toast('Нет сети — отправка подождёт', 'err'));
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

/* ───────────── запуск ───────────── */

async function boot() {
  wire();

  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const oauthError = params.get('error');
  if (code) {
    try {
      await finishAuth(code);
      history.replaceState(null, '', REDIRECT_URI);
      toast('Dropbox подключён ✓', 'ok');
    } catch (err) {
      history.replaceState(null, '', REDIRECT_URI);
      toast(err.message || 'Не удалось подключить Dropbox', 'err');
    }
  } else if (oauthError) {
    history.replaceState(null, '', REDIRECT_URI);
    toast('Доступ не выдан: ' + oauthError, 'err');
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  renderStatus();
  renderRecent();
  renderQueue();
  if (state.auth) flushOutbox();
}

boot();
