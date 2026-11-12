# «Входящие» — приложение для отправки в Dropbox

Адрес: **https://inbox.app.tridavinci.org** (PWA, ставится на экран телефона).
Репозиторий: `github.com/spokoistvie-cyber/inbox` (публичный, секретов внутри нет).
Сервер: Coolify, проект «Inbox», приложение `inbox`.

## Что умеет

- Отправить текст в папку «Входящие» — себе (Галине) или Артёму.
- Приложить файлы/фото: один файл — один объект в Dropbox, имя начинается с даты
  (`2026-11-12 13-18 — <имя файла>`), чтобы в папке был порядок.
- Текст сохраняется отдельным `.md` — с датой, отправителем и списком файлов.
- Без интернета сообщение встаёт в очередь в телефоне и уходит само, когда сеть появится.
- Вход по логину и паролю: Галина и Артём. Пароли — `База/00_Контекст/Доступы.md`.

## Куда именно падает

| Кому | Папка в Dropbox |
|---|---|
| Галине | `/Галина Старченко/Архив Claude/База/99_Входящие` |
| Артёму | `/Артем Старченко/0. Входящие` |

## Как устроено

Статический интерфейс (PWA) + маленький API на Node (без зависимостей) — один контейнер.

- `server.mjs` — статика + API: `/api/login`, `/api/me`, `/api/send`, `/api/health`.
- `web/` — интерфейс: вход, отправка, офлайн-очередь (IndexedDB), service worker, иконки.
- `tools/` — сборка иконок, проверки, работа с API Coolify, чистка тестовых файлов.

Доступ к Dropbox держит **только сервер**: refresh-токен приложения `galina-base-dsh`
(app id `lxrjcx9p74ogq04`, права `files.content.write` и др.) лежит в env Coolify.
Телефон не знает ни токена, ни пароля Dropbox.

Пароли хранятся хэшами scrypt; вход выдаёт подписанную HMAC куку `inbox_session`
(HttpOnly, Secure, SameSite=Strict) на 30 дней. Подбор пароля — 8 попыток, потом 5 минут паузы.

## Переменные окружения

| Переменная | Что это |
|---|---|
| `USERS_JSON` | пользователи: `{ "galina": {name, gen, hash}, "artem": {...} }` |
| `SESSION_SECRET` | ключ подписи куки (случайная строка) |
| `DROPBOX_APP_KEY` | `lxrjcx9p74ogq04` |
| `DROPBOX_REFRESH_TOKEN` | refresh-токен Dropbox (из `База/_Инструменты/dropbox-mcp/token.json`) |
| `PORT` | `3000` |

Для локального запуска значения собирает `node tools/make_env.mjs` → `.env.local`
(в git не попадает). Пароли задаются в `tools/make_env.mjs`.

## Обновление

```powershell
# в папке приложения
git add -A; git commit -m "…"
git -c http.sslBackend=openssl -c credential.helper= push https://x-access-token:<gh-token>@github.com/spokoistvie-cyber/inbox.git main:main
python tools/coolify.py deploy
```

Токен Coolify скрипт читает сам из `Доступы.md`.
Если менялись пароли — пересобрать `.env.local` (`node tools/make_env.mjs`), затем
`python tools/coolify.py env-set` (дубли удаляются вручную через API: DELETE …/envs/{uuid}).

## Проверка после деплоя

```powershell
curl.exe -s https://inbox.app.tridavinci.org/api/health
node tools/api_test.mjs                       # вход + отправка теста (BASE=адрес)
node tools/cleanup.mjs "2026-11-12"           # удалить тестовые файлы по префиксу
```

## Как поставить на телефон (Android)

1. Открыть `https://inbox.app.tridavinci.org` в Chrome.
2. Выбрать себя, ввести пароль (Галина — как у Пулта; Артём — свой, см. Доступы).
3. Меню Chrome → «Добавить на главный экран» (или кнопка «Установить» в шапке).
4. Дальше открывается с иконки как обычное приложение; вход помнится 30 дней.

Артёму передать адрес + его логин и пароль.

## Грабли (проверено)

- Dropbox `files/upload` принимает только `Content-Type: application/octet-stream` —
  с `image/png` вернёт 400.
- Кириллица в пути ломает заголовок `Dropbox-API-Arg` — в `dropboxArg()` она
  экранируется в `\uXXXX`.
- Git через HTTPS на этом компьютере работает только с `-c http.sslBackend=openssl`
  и токеном в URL (иначе ошибка schannel / запрос пароля).
- На домене `pult.starchenko.ru` уже есть service worker со scope `/`, поэтому
  приложение вынесено на отдельный поддомен: вложенный scope браузер запрещает.
- **В env Coolify нельзя класть значения с символом `$`** — Coolify подставляет `$VAR`
  и съедает кусок (из-за этого у Артёма не подходил пароль). Поэтому хэши паролей
  хранятся в формате `scrypt.16384.8.1.<соль>:<ключ>` (точки, без `$`), а не через `$`.
- Coolify при создании переменных может завести дубль записи (в API видно две с одним
  ключом). Лечится: DELETE лишней по `uuid`, затем передеплой.
