# Админка и номера участников

- Админка: https://www.adrenalinefest.uz/admin (логин `admin`)
- Бэкенд: `api/registrations.js` (функция Vercel, деплоится вместе с сайтом)
- Экспорт: кнопка «Скачать Excel» в админке (листы «Заявки» и «Игроки»)

## Один раз: подключить хранилище (бесплатно, ~1 минута)

1. Откройте проект сайта на vercel.com → вкладка **Storage**.
2. **Create Database** → **Upstash for Redis** (Marketplace) → план **Free** → **Create**.
3. **Connect Project** → выберите этот проект → **Connect**.
4. Vercel сам добавит ключи и пересоберёт сайт (если нет — **Deployments → Redeploy**).

Проверка: https://www.adrenalinefest.uz/api/registrations должен показать `"storage":true`.

Пока хранилище не подключено, заявки продолжают приходить в Telegram (без номера), а админка пишет,
что хранилище не подключено.
