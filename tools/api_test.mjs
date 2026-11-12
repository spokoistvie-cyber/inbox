/* Проверка API «Входящих» как из браузера: вход → отправка (текст + картинка). */
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8099';
const USER = process.env.USER_ID || 'galina';
const PASS = process.env.USER_PASS || 'OucXoacGMBDS';

const login = await fetch(BASE + '/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user: USER, pass: PASS })
});
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
console.log('login:', login.status, cookie ? 'cookie ok' : 'нет cookie');
if (!login.ok) process.exit(1);

const png = fs.readFileSync('web/icons/icon-192.png');
const fd = new FormData();
fd.append('target', process.env.TARGET || 'galina');
fd.append('text', 'Проверка отправки из приложения «Входящие» — тестовое сообщение, можно удалить.');
fd.append('files', new Blob([png], { type: 'image/png' }), 'проверка-входящих.png');

const res = await fetch(BASE + '/api/send', { method: 'POST', headers: { cookie }, body: fd });
console.log('send:', res.status, (await res.text()).slice(0, 500));
