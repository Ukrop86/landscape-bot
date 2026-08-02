# Landscape — карта проєкту

Telegram Mini App для бригадирів садово-ландшафтної компанії: облік «дорожнього
табеля» (виїзд → об'єкти → роботи → повернення), зарплата, доплати, логістика,
матеріали. Google Sheets — джерело правди для довідників і фінальний звіт для
бухгалтера; Postgres — швидка робоча копія для застосунку.

> Мова інтерфейсу і повідомлень — українська. Комітимо/пушимо лише коли просять.

## Структура (npm workspaces monorepo)

```
landscape-bot/
├── packages/core/            Спільне ядро (БД, Sheets, зарплата, синк)
│   └── src/
│       ├── schema.ts         Drizzle-схема = дзеркало аркушів Sheets
│       ├── db.ts             Підключення до Postgres
│       ├── writers.ts        Запис: Sheets ПЕРШИЙ (джерело правди) → потім Postgres
│       ├── payroll.ts        Формула зарплати (див. «Інваріанти»)
│       ├── accounting.ts     Експорт у аркуш БУХЗВІТ (largest-remainder розподіл)
│       ├── sync/             syncWorker.ts (цикл Sheets→Postgres), mappers, upsert
│       ├── google/           sheets.ts (клієнт), names.ts (назви аркушів+колонок),
│       │                     drive.ts (фото), client.ts, utils.ts
│       ├── telegramAuth.ts   Перевірка Mini App initData (HMAC по BOT_TOKEN)
│       ├── telegramNotify.ts Надсилання повідомлень через Bot API (без процесу бота)
│       ├── lock.ts           withLock() — Postgres advisory locks
│       └── config.ts         Читання env
│
├── apps/miniapp-server/      API + роздача фронтенду (Express + Drizzle)
│   └── src/
│       ├── index.ts          express, /api/*, віддає miniapp-web/dist, /internal/sync-now
│       ├── authMiddleware.ts requireTelegramAuth (initData → роль з КОРИСТУВАЧІ)
│       ├── telegramWebhook.ts /start самореєстрація + кнопки затвердження адміном
│       └── routes/
│           ├── roadTimesheet.ts  ★ ОСНОВНИЙ: preview / save / pending / approve / статуси
│           ├── dictionaries.ts   employees, objects, works, cars
│           ├── stats.ts          статистика для адміна
│           ├── logistics.ts      логістика
│           └── materials.ts      матеріали/інструменти
│
└── apps/miniapp-web/         Фронтенд (React 19 + Vite)
    └── src/
        ├── screens/
        │   ├── RoadTimesheet.tsx  ★ ВЕСЬ день бригадира (~4000 рядків, найбільший файл)
        │   ├── Approval.tsx       затвердження звітів адміном
        │   ├── Stats.tsx, Logistics.tsx, Materials.tsx, Menu.tsx
        │   └── ComingSoon.tsx
        └── lib/
            ├── api.ts        HTTP-клієнт + типи відповідей + автоповтор
            ├── draft.ts      автозбереження чернетки дня в localStorage
            ├── telegram.ts   confirmDialog, haptic, back-button, initData
            ├── employee.ts   роль/ініціали
            └── date.ts

apps/bot/ — ВИДАЛЕНО (старий Telegram-бот). Його єдину потрібну функцію
(/start-реєстрацію) перенесено у apps/miniapp-server/src/telegramWebhook.ts.
Сам бот-акаунт у BotFather лишається — його токен використовує міні-апп.
```

## Потік даних

1. **Довідники** (люди, об'єкти, роботи, авто) ведуться у Google Sheets.
   `syncWorker` копіює Sheets → Postgres кожні ~45с (`SYNC_INTERVAL_MS`).
   Застосунок читає їх із Postgres (швидко).
2. **Бригадир** веде день у міні-апп → `POST /api/road-timesheet` пише
   у Sheets і Postgres **атомарно під advisory-локом** (`reserve:${date}`).
3. **Адмін** бачить звіт (сповіщення через Bot API) і затверджує в Approval →
   експорт у аркуш **БУХЗВІТ** (`accounting.ts`).
4. **Реєстрація**: `/start` боту → рядок у КОРИСТУВАЧІ («Очікує/Ні») → адміну
   кнопки → затвердження оновлює аркуш + миттєвий синк → доступ у застосунок.

## Ключові інваріанти (не зламати — це гроші)

- **Зарплата за об'єкт** (`packages/core/src/payroll.ts` — і дзеркально в
  розрахунку сервера): бригадир **20%** і старший садівник **10%** — фіксовано;
  **решта (70%, або 90% якщо бригадира немає)** ділиться між робітниками
  **пропорційно відпрацьованим годинам**. Якщо старшого немає — його 10%
  лишаються фірмі (companyPay), не робітникам.
- **Години** беруться ВИКЛЮЧНО з робочих сесій (таймери старт/стоп на людину).
  Клієнт шле `startedAt/endedAt` → сервер читає як `droppedAt/pickedUpAt`.
  Немає сесії = 0 годин = 0 виплати за об'єкт → тому є попередження перед
  відправкою і **ручний ввід годин** («🕒 Ввести години вручну»).
- **Роз'їзди** («🚗 Машина вибула по справам»): км виключаються з класу
  поїздки та доплати за виїзд, але НЕ з реального пробігу одометра.
- **Доплата за виїзд**: одна сумарна на день (не по-об'єктно), клас від
  сумарних км усіх поїздок дня мінус роз'їзди. Хто «приїхав сам»
  (self-transport) — доплати не отримує, але зарплату за роботу отримує.
- **Кілька поїздок за день** (tripSeq): у reports/timesheet/allowances немає
  виміру «поїздка», тож туди пишуться ОБ'ЄДНАНІ по дню значення (mergeObjects).
- **Ідемпотентність**: `idempotencyKey` (один на тап «Відправити», стабільний
  через мережеві повтори) → стабільний eventId, без дублів у журналі.
- **Затверджений день заблокований** для редагування (і на клієнті, і на
  сервері) — без запиту на редагування.
- **Ролі/доступ**: initData перевіряється по `BOT_TOKEN`; роль береться з
  аркуша КОРИСТУВАЧІ (дзеркало в Postgres), ніколи не з клієнта.

## Env-змінні (сервіс miniapp на Railway)

`BOT_TOKEN` · `GOOGLE_SHEET_ID` · `GOOGLE_SERVICE_ACCOUNT_EMAIL` ·
`GOOGLE_PRIVATE_KEY` · `GOOGLE_FOLDER_ID` · `DATABASE_URL` · `PUBLIC_APP_URL`
(обов'язковий для webhook /start) · `SYNC_INTERVAL_MS` (необов'язк.) ·
`PORT` (дає Railway).

## Команди

```bash
# з кореня
npm run build          # збірка фронтенду (apps/miniapp-web)
npm run start          # запуск сервера (apps/miniapp-server)

# перевірка типів (роби перед комітом)
cd apps/miniapp-web    && npx tsc -b
cd apps/miniapp-server && npx tsc --noEmit
cd packages/core       && npx tsc --noEmit
```

Тестів майже немає — покладаємось на typecheck + збірку. Автотестів для
грошової логіки поки нема (перевіряй ручним прогоном дня).

## Деплой

Railway (проєкт `landspace-bot`): сервіси **landscape-miniapp** + **Postgres**.
Пуш у гілку `main` на GitHub → авто-деплой miniapp. Веб-фронтенд віддається
тим самим сервісом (`miniapp-server` роздає `miniapp-web/dist`).

## Робочі гілки

Розробка — у гілці `claude/landscape-bot-analysis-nb2aax`, потім
fast-forward у `main`. У проєкт також комітить колега (Ukrop86) — перед
пушем у main завжди `git fetch origin main` і за потреби rebase.

## Поради для дешевших сесій

- **Нова сесія (/clear) під кожну окрему задачу** — головний важіль економії
  (контекст не накопичується між задачами).
- Читай потрібні діапазони великих файлів (`RoadTimesheet.tsx` ~4000 рядків),
  а не файл цілком; не тягни повні дампи логів Railway.
