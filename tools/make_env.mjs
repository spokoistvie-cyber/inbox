/* Готовит пароли, хэши и переменные окружения для «Входящих».
 *
 * Запуск: node tools/make_env.mjs
 * Пишет .env.local (для локального запуска) и печатает значения для Coolify.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const PASSWORDS = {
  galina: { name: 'Галина', gen: 'Галины', pass: 'OucXoacGMBDS' },   // как у Пулта
  artem: { name: 'Артём', gen: 'Артёма', pass: 'artem-inbox-7341' }
};

function hash(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}:${key.toString('base64')}`;
}

const users = {};
for (const [id, u] of Object.entries(PASSWORDS)) {
  users[id] = { name: u.name, gen: u.gen, hash: hash(u.pass) };
}

const token = JSON.parse(fs.readFileSync('../../../../_Инструменты/dropbox-mcp/token.json', 'utf8'));
const secret = crypto.randomBytes(32).toString('base64url');

const env = [
  `USERS_JSON='${JSON.stringify(users)}'`,
  `SESSION_SECRET='${secret}'`,
  `DROPBOX_APP_KEY='${token.appKey}'`,
  `DROPBOX_REFRESH_TOKEN='${token.refreshToken}'`,
  'PORT=3000',
  ''
];
fs.writeFileSync('.env.local', env.join('\n'), 'utf8');

console.log('USERS_JSON=' + JSON.stringify(users));
console.log('SESSION_SECRET=' + secret);
console.log('DROPBOX_APP_KEY=' + token.appKey);
console.log('DROPBOX_REFRESH_TOKEN=' + token.refreshToken);
console.log('--- пароли пользователей:');
for (const [id, u] of Object.entries(PASSWORDS)) console.log(id, u.pass);
