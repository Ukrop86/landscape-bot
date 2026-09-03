# Робота з базою напряму

Готові запити для Postgres на Railway. Кожен блок перевірений по коду —
назви таблиць і колонок точні.

> **Спершу бекап.** Railway → сервіс **Postgres** → **Settings → Backups**.
> Жодна команда нижче не відкочується.

## Куди заходити

Railway → проєкт `landspace-bot` → сервіс **Postgres** → вкладка **Data**.
Там є браузер таблиць і поле для SQL. Альтернатива — консоль контейнера
Postgres: `psql $DATABASE_URL`.

## Головне: що в базі є джерелом правди

Один рядок у `events` з `type='RTS_SAVE'` — **це і є зданий день**. Уся
фактура (об'єкти, роботи, обсяги, робочі сесії людей) лежить у його колонці
`payload` як JSON. Затвердження і експорт у БУХЗВІТ читають **тільки його**.

Решта — похідні копії для показу:

| Таблиця | Що в ній | Впливає на гроші |
|---|---|---|
| `events` (RTS_SAVE) | день цілком, JSON у `payload` | **так, це джерело** |
| `timesheet_entries` | години по людях | ні, копія для статистики |
| `reports` | обсяги робіт | ні, копія |
| `allowances` | доплати | ні, копія |
| `day_statuses` | галочки готовності дня | ні |
| `odometer_days` | показники спідометра | ні (км беруться з payload) |
| `accounting_exports` | ключі експорту в БУХЗВІТ | так — блокує повторний експорт |

**Наслідок:** правка `timesheet_entries.hours` НЕ змінить зарплату. Вона змінить
лише те, що показує статистика. Щоб змінилися гроші — треба міняти `payload`
або (краще) повернути день бригадиру на редагування.

**БУХЗВІТ база не чіпає ніколи.** Що б ти не зробив тут, рядки в аркуші
лишаться як були — їх правиш руками окремо.

## Знайти TG_ID бригадира

Він потрібен майже всюди нижче.

```sql
SELECT tg_id, pib, role, active FROM users ORDER BY pib;
```

## Подивитися останні здані дні

```sql
SELECT e.date,
       u.pib AS бригадир,
       e.foreman_tg_id,
       e.status,
       e.ts AS здано,
       (e.payload::jsonb ->> 'tripSeq') AS поїздка
FROM events e
LEFT JOIN users u ON u.tg_id = e.foreman_tg_id
WHERE e.type = 'RTS_SAVE'
ORDER BY e.date DESC, e.ts DESC
LIMIT 30;
```

Статуси: `АКТИВНА` — чекає затвердження, `ЗАТВЕРДЖЕНО` — заблокований і
експортований, `ПОВЕРНУТО` — відправлений бригадиру на виправлення.

## Подивитися день у деталях

```sql
SELECT jsonb_pretty(payload::jsonb)
FROM events
WHERE type = 'RTS_SAVE'
  AND date = '2026-09-02'
  AND foreman_tg_id = 123456789
ORDER BY ts DESC
LIMIT 1;
```

Години людини рахуються з `objects[].sessions[]`: різниця між `droppedAt` і
`pickedUpAt`.

## Години по людях за день (швидкий огляд)

```sql
SELECT employee_name, object_id, hours, source
FROM timesheet_entries
WHERE date = '2026-09-02'
ORDER BY employee_name;
```

Нагадування: це копія. Правити її для зміни зарплати немає сенсу.

## ★ Зняти затвердження з дня

Найпотрібніша операція: день затверджено, а цифри неправильні.

```sql
-- 1. Спершу ПОДИВИТИСЯ, що саме зачепить
SELECT event_id, date, foreman_tg_id, status
FROM events
WHERE type = 'RTS_SAVE' AND date = '2026-09-02' AND foreman_tg_id = 123456789;

-- 2. Розблокувати день
UPDATE events
SET status = 'АКТИВНА'
WHERE type = 'RTS_SAVE' AND date = '2026-09-02' AND foreman_tg_id = 123456789;

-- 3. Прибрати ключ експорту, інакше виправлений день мовчки НЕ піде в БУХЗВІТ
DELETE FROM accounting_exports
WHERE date = '2026-09-02' AND foreman_tg_id = 123456789;
```

Далі **вручну**: видали рядки цього дня з аркуша БУХЗВІТ (шукай за датою +
ПІБ бригадира в колонці «Примітки»). Інакше після повторного затвердження
там буде подвійна зарплата.

Далі **в застосунку**: день знову з'явиться в «Затвердження». Натисни
«Повернути на редагування» — бригадир отримає повідомлення, виправить години
через «🕒 Ввести години вручну» і надішле повторно.

## Видалити день повністю

У застосунку для цього є «Видалити звіт» — надійніше, бо не забуде жодної
таблиці. Якщо все ж руками:

```sql
DELETE FROM events            WHERE date='2026-09-02' AND foreman_tg_id=123456789;
DELETE FROM reports           WHERE date='2026-09-02' AND foreman_tg_id=123456789;
DELETE FROM allowances        WHERE date='2026-09-02' AND foreman_tg_id=123456789;
DELETE FROM day_statuses      WHERE date='2026-09-02' AND foreman_tg_id=123456789;
DELETE FROM odometer_days     WHERE date='2026-09-02' AND foreman_tg_id=123456789;
DELETE FROM accounting_exports WHERE date='2026-09-02' AND foreman_tg_id=123456789;
-- ТАБЕЛЬ не має колонки бригадира — тільки за датою й людьми цього дня
DELETE FROM timesheet_entries WHERE date='2026-09-02' AND employee_id IN ('E001','E002');
```

## Звільнити авто або людину, що «зависли» в резерві

Резерв виводиться з подій дня, окремої таблиці немає. Тобто авто звільняється
разом з видаленням або скасуванням дня:

```sql
-- побачити, хто що тримає сьогодні
SELECT e.date, u.pib, e.car_id, e.employee_ids, e.status
FROM events e LEFT JOIN users u ON u.tg_id = e.foreman_tg_id
WHERE e.type = 'RTS_SAVE' AND e.date = '2026-09-03';
```

## Плани наступних виїздів

```sql
SELECT * FROM trip_plans ORDER BY created_at DESC;
DELETE FROM trip_plans WHERE id = '...';
```

## Що перевірити після будь-якої правки

1. Відкрити день у «Затвердження» — цифри мають збігатися з очікуваними.
2. Якщо чіпав `accounting_exports` — переконатися, що рядки в БУХЗВІТі
   прибрані, інакше буде задвоєння.
3. `timesheet_entries` / `reports` після правки `payload` лишаються старими —
   вони перезаписуються лише при повторній здачі дня бригадиром.

## Правила, які рятують

- **Завжди спершу `SELECT` з тим самим `WHERE`.** Подивився, що зачепить —
  потім міняй.
- `date` — це текст `'YYYY-MM-DD'`, у лапках. `foreman_tg_id` — число, без лапок.
- Ніколи не `TRUNCATE` і не `DELETE` без `WHERE`.
- Не чіпай довідники (`users`, `employees`, `objects`, `works`, `cars`,
  `settings`) — їх веде Google Sheets, синк перезапише все за ~45 секунд.
  Правити треба в аркуші.
