/* Удаление тестовых файлов из «Входящих» по началу имени.
 * node tools/cleanup.mjs "2026-11-12"            — удалить всё, что начинается с даты
 * node tools/cleanup.mjs                          — режим «только показать»
 */
import fs from 'node:fs';

const prefix = process.argv[2] || '';
const token = JSON.parse(fs.readFileSync('../../../../_Инструменты/dropbox-mcp/token.json', 'utf8'));

const form = new URLSearchParams({
  grant_type: 'refresh_token', refresh_token: token.refreshToken, client_id: token.appKey
});
const tr = await fetch('https://api.dropboxapi.com/oauth2/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form
});
const { access_token: at } = await tr.json();

const DIRS = ['/Галина Старченко/Архив Claude/База/99_Входящие', '/Артем Старченко/0. Входящие'];
for (const dir of DIRS) {
  const list = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dir, limit: 200 })
  });
  const data = await list.json();
  const hit = (data.entries || []).filter((e) => e.name.startsWith(prefix));
  console.log(`${dir}: найдено ${hit.length}`);
  for (const e of hit) {
    if (!prefix) { console.log('  ', e.name); continue; }
    const del = await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: e.path_display })
    });
    console.log('  удалено' , e.name, del.status);
  }
}
