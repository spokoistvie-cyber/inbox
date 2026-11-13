/* «Входящие» — приложение для отправки сообщения и файлов в Dropbox.
 *
 * Один контейнер: статика (PWA) + API.
 *   GET  /api/health   — живость
 *   GET  /api/users    — список пользователей (без секретов)
 *   GET  /api/me       — кто вошёл
 *   POST /api/login    — {user, pass} → cookie-сессия
 *   POST /api/logout
 *   POST /api/send     — multipart: target, text, files[] → грузит в Dropbox
 *
 * Доступ к Dropbox держит только сервер (refresh-токен в env), телефон ничего
 * не знает о Dropbox. Пользователи — Галина и Артём: у каждого свой пароль.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFile } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(here, 'web');
const PORT = Number(process.env.PORT || 3000);

const APP_KEY = process.env.DROPBOX_APP_KEY || 'lxrjcx9p74ogq04';
const REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const MAX_BODY = 120 * 1024 * 1024;   // 120 МБ на запрос
const MAX_FILE = 100 * 1024 * 1024;   // 100 МБ на файл
const SESSION_DAYS = 30;

const USERS = safeJson(process.env.USERS_JSON, {});
if (!SESSION_SECRET || !REFRESH_TOKEN || Object.keys(USERS).length === 0) {
  console.error('Не заданы переменные окружения: SESSION_SECRET, DROPBOX_REFRESH_TOKEN, USERS_JSON');
}

const TARGETS = {
  galina: {
    title: 'Галине',
    path: '/Галина Старченко/Архив Claude/База/99_Входящие',
    home: 'https://www.dropbox.com/home' + encodeURIComponentPath('/Галина Старченко/Архив Claude/База/99_Входящие')
  },
  artem: {
    title: 'Артёму',
    path: '/Артем Старченко/0. Входящие',
    home: 'https://www.dropbox.com/home' + encodeURIComponentPath('/Артем Старченко/0. Входящие')
  }
};

/* ───────────── утилиты ───────────── */

function safeJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}
function encodeURIComponentPath(p) {
  return p.split('/').map((s) => encodeURIComponent(s)).join('/');
}
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function pad2(n) { return String(n).padStart(2, '0'); }
const MSK = { timeZone: 'Europe/Moscow' };
const STAMP_PARTS = new Intl.DateTimeFormat('ru-RU', {
  ...MSK, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
});
/** Время по Москве, а не по UTC контейнера. */
function stamp(d = new Date()) {
  const parts = STAMP_PARTS.formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}-${get('minute')}`;
}
function cleanFileName(name) {
  let base = String(name || 'файл').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  if (!base) base = 'файл';
  if (base.length > 150) {
    const m = /(\.[a-z0-9]{1,6})$/i.exec(base);
    const ext = m ? m[1] : '';
    base = base.slice(0, 150 - ext.length) + ext;
  }
  return base;
}
function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} МБ`;
}

/* ───────────── пароли и сессии ───────────── */

function scryptHash(password, salt, N = 16384, r = 8, p = 1) {
  return crypto.scryptSync(password, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
}
function checkPassword(password, stored) {
  // Формат: scrypt.<N>.<r>.<p>.<saltB64>:<hashB64>.
  // Доллар не используем: Coolify подставляет $VAR и портит значение (проверено 12.11.2026).
  const parts = String(stored || '').split('.');
  if (parts.length !== 5 || parts[0] !== 'scrypt') return false;
  const [, n, rr, pp, rest] = parts;
  const [saltB64, hashB64] = rest.split(':');
  if (!saltB64 || !hashB64) return false;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expect = Buffer.from(hashB64, 'base64');
    const got = scryptHash(password, salt, Number(n), Number(rr), Number(pp));
    return got.length === expect.length && crypto.timingSafeEqual(got, expect);
  } catch { return false; }
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function readSession(cookieHeader) {
  const m = /(?:^|;\s*)inbox_session=([^;]+)/.exec(cookieHeader || '');
  if (!m) return null;
  const [body, mac] = m[1].split('.');
  if (!body || !mac) return null;
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const data = safeJson(Buffer.from(body, 'base64url').toString('utf8'), null);
  if (!data || !data.u || !data.exp || data.exp < Date.now()) return null;
  return USERS[data.u] ? data : null;
}
function cookieHeader(token, secure, maxAgeSec) {
  return `inbox_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}` + (secure ? '; Secure' : '');
}

const loginFails = new Map(); // ip → {count, until}
function tooManyFails(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return false;
  if (rec.until && rec.until > Date.now()) return true;
  if (rec.until && rec.until <= Date.now()) loginFails.delete(ip);
  return false;
}
function noteFail(ip) {
  const rec = loginFails.get(ip) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= 8) { rec.until = Date.now() + 5 * 60 * 1000; rec.count = 0; }
  loginFails.set(ip, rec);
}

/* ───────────── Dropbox ───────────── */

let accessCache = { token: '', expires: 0 };

async function dropboxToken(force = false) {
  if (!force && accessCache.token && accessCache.expires - 60_000 > Date.now()) return accessCache.token;
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: REFRESH_TOKEN,
    client_id: APP_KEY
  });
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error('Dropbox auth: ' + res.status + ' ' + text);
  }
  const data = await res.json();
  accessCache = {
    token: data.access_token,
    expires: Date.now() + (data.expires_in || 14400) * 1000
  };
  return accessCache.token;
}

/** Заголовок Dropbox-API-Arg: JSON с \\uXXXX для не-ASCII — кириллица в заголовке иначе ломается. */
function dropboxArg(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

async function dropboxUpload(dropboxPath, buffer, contentType = 'application/octet-stream') {
  const put = async (token) => fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': contentType,
      'Dropbox-API-Arg': dropboxArg({ path: dropboxPath, mode: 'add', autorename: true, mute: true })
    },
    body: buffer
  });
  let res = await put(await dropboxToken());
  if (res.status === 401) res = await put(await dropboxToken(true));
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error('Dropbox upload: ' + res.status + ' ' + text);
  }
  return res.json();
}

/* ───────────── голосовые ───────────── */

const AUDIO_EXT = new Set(['webm', 'ogg', 'oga', 'm4a', 'mp3', 'wav', 'aac', 'flac', 'm4r', 'wma', 'aif', 'aiff', 'mp4']);

function isAudioFile(name, type) {
  if (type && String(type).startsWith('audio/')) return true;
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return Boolean(m && AUDIO_EXT.has(m[1].toLowerCase()));
}

function fmtSec(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 180000 }, (err, _out, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).slice(-300)));
      else resolve();
    });
  });
}

/** Перекодировать в m4a (AAC, моно): такой файл проигрывается в Dropbox на любом телефоне. */
async function toM4a(buffer, ext) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'inbox-'));
  const src = path.join(dir, 'in.' + (ext || 'webm'));
  const dst = path.join(dir, 'out.m4a');
  try {
    await fs.promises.writeFile(src, buffer);
    await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', src,
      '-vn', '-ac', '1', '-ar', '22050', '-c:a', 'aac', '-b:a', '48k', dst]);
    return await fs.promises.readFile(dst);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function dropboxRpc(route, body, attempt = 0) {
  const send = (token) => fetch('https://api.dropboxapi.com/2/' + route, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let res = await send(await dropboxToken());
  if (res.status === 401) res = await send(await dropboxToken(true));
  if (res.status === 429 && attempt < 5) {
    const wait = Math.min(60, Number(res.headers.get('retry-after') || 5));
    await new Promise((r) => setTimeout(r, wait * 1000 + 500));
    return dropboxRpc(route, body, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Dropbox ${route}: ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/** Расшифровка средствами Dropbox (riviera/get_transcript_async): кладём рядом .md с текстом. */
async function transcribeVoice(target, voice, prefix) {
  const started = await dropboxRpc('riviera/get_transcript_async', {
    file_id_or_url: { '.tag': 'path', path: voice.path },
    audio_language: 'ru',
    timestamp_level: { '.tag': 'sentence' }
  });
  const job = started.async_job_id;
  if (!job) return;
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await dropboxRpc('riviera/get_transcript_async/check', { async_job_id: job });
    if (st['.tag'] === 'failed') {
      console.error('[voice] не расшифровалось:', JSON.stringify(st.failed || {}).slice(0, 200));
      return;
    }
    if (st['.tag'] === 'complete') {
      const segments = (st.structured_transcript && st.structured_transcript.segments) || [];
      const text = segments.map((x) => x.text || '').join(' ').trim();
      if (!text) return;
      const lines = [
        '# Расшифровка голосового',
        '',
        `- Файл: ${voice.name}`,
        '- Расшифровано: Dropbox, автоматически',
        '',
        '---',
        '',
        text,
        ''
      ];
      await dropboxUpload(`${target.path}/${prefix} — расшифровка голосового.md`,
        Buffer.from(lines.join('\n'), 'utf8'));
      console.log('[voice] расшифровка загружена:', text.slice(0, 60));
      return;
    }
  }
  console.error('[voice] расшифровка не завершилась за отведённое время');
}

/* ───────────── точки входа API ───────────── */

async function handleSend(req, res, user) {
  let raw;
  try {
    raw = await readBody(req, MAX_BODY);
  } catch {
    return json(res, 413, { error: 'Слишком большие файлы: за один раз не больше 120 МБ' });
  }
  let form;
  try {
    form = await new Request('http://local/upload', {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] || '' },
      body: raw
    }).formData();
  } catch {
    return json(res, 400, { error: 'Не разобрать вложение (слишком большой файл или другой формат)' });
  }

  const target = TARGETS[String(form.get('target') || '')];
  if (!target) return json(res, 400, { error: 'Не выбран адресат' });
  const text = String(form.get('text') || '').trim();
  const files = form.getAll('files').filter((f) => typeof f === 'object' && f && f.name);
  const voiceFlag = String(form.get('voice') || '') === '1';
  const voiceDuration = Number(form.get('voice_duration') || 0) || 0;

  if (!text && files.length === 0) return json(res, 400, { error: 'Пустое сообщение' });

  const sender = user.name;
  const senderGen = user.gen || user.name;
  const prefix = stamp();
  const uploaded = [];
  let voice = null;

  for (const f of files) {
    if (f.size > MAX_FILE) return json(res, 413, { error: `«${f.name}» больше 100 МБ` });
    let buf = Buffer.from(await f.arrayBuffer());
    let name = `${prefix} — ${cleanFileName(f.name)}`;
    const audio = isAudioFile(f.name, f.type);
    if (audio && !/\.(m4a|mp3)$/i.test(name)) {
      const ext = (/\.([a-z0-9]+)$/i.exec(f.name) || [])[1] || 'webm';
      try {
        buf = await toM4a(buf, ext);
        name = name.replace(/\.[a-z0-9]+$/i, '') + '.m4a';
      } catch (err) {
        console.error('[voice] конвертация не удалась, отправляю как есть:', err.message);
      }
    }
    const info = await dropboxUpload(`${target.path}/${name}`, buf, 'application/octet-stream');
    uploaded.push({ name: info.name, size: buf.length, path: info.path_display });
    if (audio) voice = { path: info.path_display, name: info.name };
  }

  if (text) {
    const when = new Date().toLocaleString('ru-RU', { ...MSK, dateStyle: 'long', timeStyle: 'short' });
    const lines = [
      '# Сообщение из приложения «Входящие»',
      '',
      `- Когда: ${when}`,
      `- От: ${sender}`,
      `- Кому: ${target.title}`,
      files.length
        ? '- Файлы: ' + files.map((f) => `${cleanFileName(f.name)} (${humanSize(f.size)})`).join(', ')
        : '- Файлы: нет',
      voiceFlag && voiceDuration ? `- Голосовое: ${fmtSec(voiceDuration)}` : '',
      '',
      '---',
      '',
      text,
      ''
    ];
    const info = await dropboxUpload(
      `${target.path}/${prefix} — от ${senderGen}.md`,
      Buffer.from(lines.join('\n'), 'utf8'),
      'application/octet-stream'
    );
    uploaded.push({ name: info.name, size: Buffer.byteLength(lines.join('\n')), path: info.path_display });
  }

  if (voice) transcribeVoice(target, voice, prefix).catch((err) => console.error('[voice]', err.message));

  console.log(`[send] ${sender} → ${target.title}: ${uploaded.length} объектов`);
  return json(res, 200, { ok: true, uploaded, target: target.title, home: target.home, voice: Boolean(voice) });
}

function requireUser(req, res) {
  const session = readSession(req.headers.cookie);
  if (!session) { json(res, 401, { error: 'Нужен вход' }); return null; }
  return { id: session.u, ...USERS[session.u] };
}

async function handleApi(req, res, url) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const isSecure = String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, dropbox: Boolean(REFRESH_TOKEN), users: Object.keys(USERS).length });
  }

  if (req.method === 'GET' && url.pathname === '/api/users') {
    return json(res, 200, Object.entries(USERS).map(([id, u]) => ({ id, name: u.name })));
  }

  if (req.method === 'GET' && url.pathname === '/api/me') {
    const user = requireUser(req, res);
    if (!user) return;
    return json(res, 200, { user: { id: user.id, name: user.name } });
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    if (tooManyFails(ip)) return json(res, 429, { error: 'Слишком много попыток. Подожди пять минут.' });
    let body;
    try {
      body = safeJson((await readBody(req, 16 * 1024)).toString('utf8'), {});
    } catch {
      return json(res, 400, { error: 'Плохой запрос' });
    }
    const id = String(body.user || '');
    const user = USERS[id];
    if (!user || !checkPassword(String(body.pass || ''), user.hash)) {
      noteFail(ip);
      return json(res, 401, { error: 'Неверный пароль' });
    }
    const token = signSession({ u: id, exp: Date.now() + SESSION_DAYS * 864e5 });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': cookieHeader(token, isSecure, SESSION_DAYS * 86400),
      'Cache-Control': 'no-store'
    });
    return res.end(JSON.stringify({ user: { id, name: user.name } }));
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': 'inbox_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + (isSecure ? '; Secure' : ''),
      'Cache-Control': 'no-store'
    });
    return res.end('{"ok":true}');
  }

  if (req.method === 'POST' && url.pathname === '/api/send') {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      return await handleSend(req, res, user);
    } catch (err) {
      console.error('[send] ошибка:', err.message);
      return json(res, 502, { error: 'Dropbox не принял файл: ' + err.message });
    }
  }

  return json(res, 404, { error: 'Нет такого метода' });
}

/* ───────────── статика ───────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(WEB, rel));
  if (!file.startsWith(WEB + path.sep) && file !== path.join(WEB, 'index.html')) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('не найдено');
    }
    const ext = path.extname(file).toLowerCase();
    const noCache = ext === '.html' || file.endsWith('sw.js') || ext === '.webmanifest';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=604800',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    fs.createReadStream(file).pipe(res);
  });
}

/* ───────────── сервер ───────────── */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  if (req.method === 'POST' && url.pathname === '/share') {
    // «Поделиться» без service worker: вернуть в приложение с понятным сообщением.
    res.writeHead(303, { Location: '/?share_failed=1' });
    return res.end();
  }
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      console.error('[api]', err);
      if (!res.headersSent) json(res, 500, { error: 'Внутренняя ошибка' });
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end('method not allowed');
  }
  serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log(`Входящие: http://0.0.0.0:${PORT} | пользователи: ${Object.keys(USERS).join(', ') || '—'}`);
});
