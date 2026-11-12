/* РџСЂРѕРІРµСЂРєР° В«РѕРїР°СЃРЅРѕРіРѕ РјРµСЃС‚Р°В»: Р·Р°РіСЂСѓР·РєР° РІ Dropbox РїРѕ РїСѓС‚Рё СЃ РєРёСЂРёР»Р»РёС†РµР№.
 * РџРѕРІС‚РѕСЂСЏРµС‚ СЂРѕРІРЅРѕ С‚Рѕ, С‡С‚Рѕ РґРµР»Р°РµС‚ app.js: refresh grant в†’ files/upload СЃ
 * Р·Р°РіРѕР»РѕРІРєРѕРј Dropbox-API-Arg, СЌРєСЂР°РЅРёСЂРѕРІР°РЅРЅС‹Рј РІ \uXXXX. РџРёС€РµС‚ С‚РµСЃС‚РѕРІС‹Р№ С„Р°Р№Р»
 * РІРѕ В«Р’С…РѕРґСЏС‰РёРµВ» Р“Р°Р»РёРЅС‹ Рё РїРѕ С„Р»Р°РіСѓ --cleanup СѓРґР°Р»СЏРµС‚ РµРіРѕ.
 */
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = path.resolve(process.argv[2] || '../../../../_РРЅСЃС‚СЂСѓРјРµРЅС‚С‹/dropbox-mcp/token.json');
const CLEANUP = process.argv.includes('--cleanup');
const DIR = '/Р“Р°Р»РёРЅР° РЎС‚Р°СЂС‡РµРЅРєРѕ/РђСЂС…РёРІ Claude/Р‘Р°Р·Р°/99_Р’С…РѕРґСЏС‰РёРµ';
const NAME = '2026-11-12 вЂ” С‚РµСЃС‚ РѕС‚РїСЂР°РІРєРё РёР· РїСЂРёР»РѕР¶РµРЅРёСЏ (DSH).md';

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

const body = Buffer.from('# РўРµСЃС‚ РїСЂРёР»РѕР¶РµРЅРёСЏ В«Р’С…РѕРґСЏС‰РёРµВ»\n\nР¤Р°Р№Р» СЃРѕР·РґР°РЅ Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё РґР»СЏ РїСЂРѕРІРµСЂРєРё РїСѓС‚Рё СЃ РєРёСЂРёР»Р»РёС†РµР№.\n', 'utf8');
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


