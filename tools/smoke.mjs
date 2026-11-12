/* Проверка «опасного места»: загрузка в Dropbox по пути с кириллицей.
 * Повторяет ровно то, что делает app.js: refresh grant → files/upload с
 * заголовком Dropbox-API-Arg, экранированным в \uXXXX. Пишет тестовый файл
 * во «Входящие» Галины и по флагу --cleanup удаляет его.
 */
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = path.resolve(process.argv[2] || '../../../../_Инструменты/dropbox-mcp/token.json');
const CLEANUP = process.argv.includes('--cleanup');
const DIR = '/Галина Старченко/Архив Claude/База/99_Входящие';
const NAME = '2026-11-12 — тест отправки из приложения (DSH).md';

const t = JSON.parse(fs.readFileSync(TOKEN, 'utf8'));

function arg(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

const form = new URLSearchParams({
  grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: t.appKey
});
const tr = await fetch('https://api.dropboxapi.com/oauth2/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form
});
if (!tr.ok) { console.error('refresh FAIL', tr.status, (await tr.text()).slice(0, 300)); process.exit(1); }
const { access_token } = await tr.json();
console.log('refresh OK, scope:', t.scope);

if (CLEANUP) {
  const r = await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: `${DIR}/${NAME}` })
  });
  console.log('delete:', r.status, (await r.text()).slice(0, 300));
  process.exit(0);
}

const body = Buffer.from('# Тест приложения «Входящие»\n\nФайл создан автоматически для проверки пути с кириллицей.\n', 'utf8');
const up = await fetch('https://content.dropboxapi.com/2/files/upload', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ' + access_token,
    'Content-Type': 'application/octet-stream',
    'Dropbox-API-Arg': arg({ path: `${DIR}/${NAME}`, mode: 'add', autorename: true, mute: true })
  },
  body
});
const text = await up.text();
console.log('upload:', up.status, text.slice(0, 400));
