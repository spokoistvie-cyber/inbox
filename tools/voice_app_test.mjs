/* Проверка «голосового» пути: вход → отправка аудиофайла с полями voice.
 * usage: node tools/voice_app_test.mjs <путь-к-аудио> [target]
 */
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const USER = process.env.USER_ID || 'galina';
const PASS = process.env.USER_PASS || 'OucXoacGMBDS';
const FILE = process.argv[2] || 'tools/_samples/jfk.wav';
const TARGET = process.argv[3] || 'galina';

const login = await fetch(BASE + '/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user: USER, pass: PASS })
});
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
console.log('login:', login.status);

const audio = fs.readFileSync(FILE);
const fd = new FormData();
fd.append('target', TARGET);
fd.append('text', 'Проверка голосового из приложения — тест, можно удалить.');
fd.append('voice', '1');
fd.append('voice_duration', '11');
fd.append('files', new Blob([audio], { type: 'audio/wav' }), 'голосовое 11с.wav');

const res = await fetch(BASE + '/api/send', { method: 'POST', headers: { cookie }, body: fd });
console.log('send:', res.status, (await res.text()).slice(0, 400));
