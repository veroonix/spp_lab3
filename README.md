# Лабораторная работа №2

SPA-каталог книг с REST API, SQLite и загрузкой обложек через `multipart/form-data`.

## Структура проекта

```text
backend/
	src/
		auth/
			email.js       # SMTP и ссылки восстановления
			middleware.js  # Bearer-сессии и RBAC
			security.js    # scrypt, хеши токенов и генерация токенов
		config.js        # окружение и TTL/лимиты
		logger.js        # структурированные JSON-логи
	server.js          # composition root и API routes
	server.test.js     # интеграционные HTTP-тесты
	Dockerfile         # backend image
frontend/
	public/             # frontend SPA
	frontend.Dockerfile # nginx image
	nginx.conf          # reverse proxy к backend
docker-compose.yml
```

Backend не раздаёт frontend. Nginx-контейнер обслуживает SPA и проксирует `/api` и
`/uploads` во внутренний backend-контейнер. SQLite и загруженные обложки находятся
только в persistent volume backend.

## Запуск в Docker

```bash
docker compose up --build
```

Docker Compose автоматически загружает настройки из корневого `.env`. Перед первым
запуском задайте там `ADMIN_EMAIL` и `ADMIN_PASSWORD`. Для отправки писем восстановления
заполните SMTP-поля; пока `SMTP_HOST` пустой, отправка почты отключена.

Открыть: http://localhost:3001

## Локальный запуск

Нужен Node.js 20+.

```bash
npm --prefix backend ci
npm --prefix backend start
```

Локальные команды выполняются из `backend/` или с флагом `--prefix backend`:

```bash
npm --prefix backend ci
npm --prefix backend test
```

Для локального входа по умолчанию используется `admin@example.com` и `change-me-now`.
В production обязательно задать `ADMIN_EMAIL` и `ADMIN_PASSWORD`.

Для отправки писем восстановления задаются `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`,
`SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` и `APP_URL`. Без SMTP в development ссылка восстановления
пишется в структурированный лог и возвращается как `resetToken` для локальной проверки.

Сервисы Compose: `frontend` (`nginx:1.27-alpine`) и `backend` (`node:22-bookworm-slim`).
Backend запускается от непривилегированного пользователя `node`, использует healthcheck,
а frontend ожидает его готовности через `depends_on.condition: service_healthy`.

## API

| Метод | URL | Назначение |
|---|---|---|
| GET | `/api/books` | список книг |
| GET | `/api/books/:id` | одна книга |
| POST | `/api/books` | создать книгу, `multipart/form-data` |
| PUT | `/api/books/:id` | изменить книгу, `multipart/form-data` |
| DELETE | `/api/books/:id` | удалить книгу |

### Доступ

| Метод | URL | Назначение |
|---|---|---|
| POST | `/api/auth/login` | вход, возвращает временный Bearer-токен на 8 часов |
| POST | `/api/auth/register` | регистрация читателя `viewer` и вход |
| POST | `/api/admin/users` | создание аккаунта с выбранной ролью; доступно только `admin` |
| GET | `/api/admin/users` | список пользователей и число действующих сессий; доступно только `admin` |
| DELETE | `/api/admin/users/:id/sessions` | завершить сессии выбранного пользователя; доступно только `admin` |
| POST | `/api/auth/logout` | завершить текущую сессию |
| POST | `/api/auth/logout-all` | завершить все сессии текущего пользователя |
| POST | `/api/auth/recover` | запросить ссылку восстановления на email |
| POST | `/api/auth/reset` | установить пароль по одноразовому токену на 30 минут |

Есть три роли: `viewer` читает каталог, `editor` добавляет и изменяет книги, `admin`
также удаляет книги. Публичная регистрация создаёт только `viewer`; назначать роли
`editor` и `admin` через неё нельзя. Администратор создаёт аккаунты с нужной ролью через
форму управления пользователями. После пяти неудачных входов с одной пары email/IP включается
блокировка на 15 минут. Все API-ошибки имеют поля `error`, `code`, `requestId` и
используют семантичные коды HTTP (`401`, `403`, `404`, `409`, `429`, `500`).

Admin видит количество активных сессий пользователей и может отозвать их; сами токены
и их хеши в интерфейсе не показываются. Просроченные сессии, токены восстановления и
неудачные попытки входа автоматически очищаются при старте и далее раз в час.

Сервер валидирует все поля через Zod, ограничивает изображения форматами JPG/PNG/WEBP и размером 5 МБ. Пароли хешируются через scrypt, токены в базе хранятся только в виде SHA-256 хеша. Неиспользованная загруженная обложка удаляется, если создать книгу не удалось. Данные сохраняются в SQLite volume `library-data`. В Docker stdout по умолчанию выводит JSON, который можно форматировать через `jq`; включить читаемый однострочный формат можно через `LOG_PRETTY=true`. Полные структурированные логи также сохраняются в JSON Lines в `DATA_DIR/logs/app.jsonl` того же persistent volume. Путь к файлу можно переопределить переменной `LOG_FILE`. Каждая строка файла содержит отдельную JSON-запись; HTTP-логи не сохраняют query-параметры, а токены восстановления не записываются в лог.

Просмотр stdout с форматированием через `jq` из PowerShell:

```powershell
docker compose logs --no-log-prefix -f backend | jq .
```

Или напрямую через Docker CLI в Bash:

```bash
docker logs -f "$(docker compose ps -q backend)" | jq .
```

Файл внутри контейнера можно смотреть отдельно: `docker compose exec backend tail -f /app/data/logs/app.jsonl`.

## Проверки

```bash
npm run check
npm --prefix backend test
```

GitHub Actions запускает эти команды на каждый push и pull request.