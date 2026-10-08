# Лабораторная работа №2. SPA + REST API + PostgreSQL + Docker

Приложение «Список задач» (продолжение ЛР1): клиент — одностраничное приложение
на **React (Vite)**, сервер — **Node.js + Express** с REST API, данные в **PostgreSQL**,
файлы — на диске (volume). Всё запускается в Docker одной командой.

## Запуск

```bash
docker compose up --build
```

Откройте **http://localhost:8080**. Остановить: `Ctrl+C`, удалить вместе с данными:
`docker compose down -v`. Порт и пароли БД меняются через переменные окружения
(`APP_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`) или файл `.env`.

Контейнеры: `db` (PostgreSQL 16) → `server` (API, порт 4000 внутри сети) →
`client` (nginx: раздаёт собранную SPA и проксирует `/api` на `server`).

## Запуск без Docker (для разработки)

```bash
# 1) PostgreSQL, например:
docker run -d --name spp-pg -e POSTGRES_USER=spp -e POSTGRES_PASSWORD=spp -e POSTGRES_DB=spp -p 5432:5432 postgres:16-alpine
# 2) сервер
cd server && npm install && npm start          # http://localhost:4000
# 3) клиент (в другом терминале)
cd client && npm install && npm run dev        # http://localhost:5173 (/api проксируется на :4000)
```

Тесты API (нужна БД из шага 1): `cd server && npm test`.

## REST API

| Метод | URL | Успех | Описание |
|---|---|---|---|
| GET | `/api/tasks?status=&q=` | 200 | список; фильтр по статусу, поиск по тексту |
| POST | `/api/tasks` | 201 | создать (JSON) |
| GET | `/api/tasks/:id` | 200 | одна задача с вложениями |
| PUT | `/api/tasks/:id` | 200 | полное обновление (JSON) |
| PATCH | `/api/tasks/:id` | 200 | частичное обновление, напр. `{"status":"done"}` |
| DELETE | `/api/tasks/:id` | 204 | удалить задачу и её файлы |
| POST | `/api/tasks/:id/attachments` | 201 | загрузить файлы (`multipart/form-data`, поле `files`) |
| GET | `/api/tasks/:id/attachments/:aid` | 200 | скачать файл |
| DELETE | `/api/tasks/:id/attachments/:aid` | 204 | удалить файл |

Коды ошибок: **400** — данные не прошли проверку / плохой id / битый JSON,
**404** — задача, файл или маршрут не найдены, **413** — файл > 10 МБ,
**415** — файлы не в `multipart/form-data`, **500** — внутренняя ошибка.
Формат ошибки:

```json
{ "error": { "message": "Данные не прошли проверку.",
             "details": [{ "field": "title", "message": "Название обязательно…" }] } }
```

Пример:

```bash
curl -X POST localhost:8080/api/tasks -H 'Content-Type: application/json' \
     -d '{"title":"Сдать ЛР2","dueDate":"2026-11-01"}'
curl -F files=@report.pdf localhost:8080/api/tasks/1/attachments
```

### Проверка входных данных (сервер)
`title` — строка 1–200 символов; `description` — строка до 5000; `status` — `todo|in_progress|done`;
`dueDate` — реальная дата `ГГГГ-ММ-ДД` или `null`; `id` в URL — положительное целое;
файлы — до 10 МБ каждый, до 10 за запрос, до 20 на задачу; параметры фильтра тоже проверяются.
Клиент дублирует простые проверки и показывает серверные ошибки у соответствующих полей и во всплывающих уведомлениях.

## Структура

```
lab2/
├── docker-compose.yml
├── server/   src/{index,app,db,validate,errors}.js, test/api.test.js, Dockerfile
└── client/   src/{App.jsx,api.js,components/*}, nginx.conf, Dockerfile
```
