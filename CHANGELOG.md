# Changelog

Формат: “людський”, але практичний.
Кожна зміна повинна мати:
- дату
- короткий заголовок
- що додали/змінили/пофіксили
- якщо є — міграції/зміни в Google Sheets

---

## [Baseline] 2026-01-21
### Added
- Початкова архітектура flow-based Telegram-бота (MENU/FLOW).
- Wizard router (`src/bot/wizard.ts`) з FLOW_MODULES + prefix routing.
- Reply main menu + inline welcome (`src/bot/ui.ts`).
- Session storage in-memory (`src/bot/core/session.ts`).
- Flow core types/helpers/registry (`src/bot/core/*`).
- LogisticsFlow (object pick + employee multi-pick + review + edit + save).
- RoadFlow (wizard stub steps).
- StubFlow для майбутніх модулів.
- Google Sheets integration: читання довідників (Objects/Employees), append у “Журнал робіт”.
- Google Drive integration: uploadPhotoFromBuffer + public link.

### Notes
- Сесії in-memory: після рестарту бота стан губиться.
- Inline UI працює через `messageId` і `upsertInline()`.

---

## [Unreleased]
### Planned
- Ролі та доступи (brigadier/admin).
- День по об’єкту + статуси (Draft/Submitted/Returned/Approved).
- Табель через журнал подій, автоматичні години з округленням до 0.25.
- Роботи пакетами + фото.
- Дорога з одометром, авто, км, виїзд S/M/L/XL.
- Логістика як фікс-сума по людям.
- Матеріали/Інструмент (рух).
- Здача дня + адмін approve/return.
- Зарплатна модель, показ сум тільки після approve.

## [Unreleased]
### Added
- Повна структура Google Sheets (довідники + робочі листи).
- Smoke test для перевірки хедерів та базових upsert-операцій.
- Універсальний data-layer для Google Sheets (`src/google/sheets.ts`).
- Fetch-функції для всіх довідників (users, employees, objects, works, cars).
- Подієва модель через лист `ЖУРНАЛ_ПОДІЙ`.

### Changed
- Запис логістики переведено з “Журнал робіт” на `ЖУРНАЛ_ПОДІЙ`.
- Додано універсальний upsert для статусів дня, одометра, табеля, доплат.

## Stage 1 Status
Проєкт: landscape-bot (Telegram bot для ландшафтних бригад)

ЕТАП 1 — Google Sheets структура + довідники (ФУНДАМЕНТ)

### ✅ ЗРОБЛЕНО

1) Google Sheets — структура листів затверджена і перевірена smoke-test’ом

ДОВІДНИКИ:
- КОРИСТУВАЧІ (TG_ID, USERNAME, ПІБ, РОЛЬ, АКТИВ, КОМЕНТАР)
- ПРАЦІВНИКИ (ID, ІМʼЯ, БРИГАДА_ID, ПОСАДА, АКТИВ)
- ОБЄКТИ (ID, НАЗВА, АДРЕСА, АКТИВ)
- РОБОТИ (ID, НАЗВА, КАТЕГОРІЯ, ОДИНИЦЯ, СТАВКА, АКТИВ)
- АВТО (ID, НАЗВА, НОМЕР, АКТИВ)

РОБОЧІ ЛИСТИ:
- ЗВІТИ
- ТАБЕЛЬ
- ЖУРНАЛ_ПОДІЙ
- ОДОМЕТР_ДЕНЬ
- ДОПЛАТИ
- СТАТУС_ДНЯ
- ЗАКРИТТЯ

Колонки зчитуються по назвам (header-based mapping), не по індексах.

---

2) src/google/sheets.ts — базова інфраструктура

Є:
- loadSheet()
- requireHeaders()
- getCell(), parseNumber(), toBool()
- fetchUsers()
- fetchEmployees()
- fetchObjects()
- fetchWorks()
- fetchCars()

Є універсальний upsert:
- upsertRowByKeys(sheetName, keyCols, updateCols, optionalCols)

Через нього вже працює:
- upsertDayStatus()
- upsertOdometerDay()

---

3) Smoke test

Є окремий скрипт smoke test:
- перевіряє заголовки
- перевіряє fetch для довідників
- робить upsert у СТАТУС_ДНЯ та ОДОМЕТР_ДЕНЬ

Smoke test проходить стабільно.

---

4) Архітектура

- Flow-based Telegram bot (MENU / FLOW)
- In-memory session
- LogisticsFlow працює
- Архітектура зафіксована в ARCHITECTURE.md
- Базові зміни описані в CHANGELOG.md

---

### 🟡 ЧАСТКОВО ЗРОБЛЕНО

- append у ЖУРНАЛ_РОБІТ був раніше
- логіка логістики працює, але:
  - пише не як події, а як “плоскі рядки”
  - НЕ використовує ЖУРНАЛ_ПОДІЙ

---

### ❌ НЕ ЗРОБЛЕНО (АЛЕ ВХОДИТЬ В ЕТАП 1)

1) Немає повноцінного event-based API для Sheets:
- appendEvent()
- updateEvent()
- логічне оновлення подій (approve / return / edit)

2) Немає оновлень рядків для:
- approve / return дня
- доплат
- зміни статусів
- одометра (після підтвердження)

3) LogisticsFlow не пише у ЖУРНАЛ_ПОДІЙ (потрібно переробити save)

---

### 🎯 НАСТУПНИЙ КРОК

Почати ЕТАП 2:
ЛОГІСТИКА → ЖУРНАЛ_ПОДІЙ

Потрібно:
- визначити типи подій
- payload подій
- правила запису та агрегації
- адаптувати LogisticsFlow
