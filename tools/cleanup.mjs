/* Удаление ТОЛЬКО тех файлов, что перечислены явно (полными путями Dropbox).
 *
 *   node tools/cleanup.mjs "/Галина Старченко/…/99_Входящие/2026-11-13 14-09 — голосовое 11с.wav" …
 *
 * Никаких «по префиксу/дате»: однажды такая чистка удалила живую заметку в папке Артёма
 * (13.11.2026, файл восстановлен из удалённых).
 */
import fs from 'node:fs';

const paths = process.argv.slice(2).filter((p) => p.startsWith('/'));
if (!paths.length) {
  console.log('укажи полные пути файлов в Dropbox, которые нужно удалить');
  process.exit(0);
}

const token = JSON.parse(fs.readFileSync('../../../../_Инструменты/dropbox-mcp/token.json', 'utf8'));
const form = new URLSearchParams({
  grant_type: 'refresh_token', refresh_token: token.refreshToken, client_id: token.appKey
});
const tr = await fetch('https://api.dropboxapi.com/oauth2/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form
});
const { access_token: at } = await tr.json();

for (const p of paths) {
  const res = await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p })
  });
  console.log(res.status === 200 ? 'удалён' : 'НЕ удалён (' + res.status + ')', p);
}
