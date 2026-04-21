// src/bot/flows/peopleTimesheet.flow.ts

/* =========================================
 * Imports: Telegram types + тексти UI
 * ========================================= */
import type TelegramBot from "node-telegram-bot-api";
import { TEXTS } from "../texts.js";


/* =========================================
 * Imports: Flow контракт + core helpers (state/UI/utils)
 * ========================================= */
import type { FlowModule } from "../core/flowTypes.js";
import {
  getFlowState,
  setFlowState,
  todayISO,
  upsertInline,
  kb,
  mdEscape,
  clampCoef01,
  parseCoef,
  isLocked,
} from "../core/helpers.js";

/* =========================================
 * Imports: загальні callback-и меню
 * ========================================= */
import { CB } from "../core/cb.js";

/* =========================================
 * Imports: callbacks/типи цього flow
 * ========================================= */
import { cb, PREFIX, FLOW } from "./peopleTimesheet.cb.js";
import type { State, DictWork } from "./peopleTimesheet.types.js";

/* =========================================
 * Imports: Google Sheets (довідники/запис/чекліст)
 * ========================================= */
import { fetchObjects, fetchEmployees, fetchWorks } from "../../google/sheets/dictionaries.js";
import { refreshDayChecklist, upsertTimesheetRow } from "../../google/sheets/working.js";
import { getDayStatusRow } from "../../google/sheets/checklist.js";
import { nowISO } from "../../google/sheets/utils.js";

/* =========================================
 * Imports: TS2 (події + підрахунок)
 * ========================================= */
import { writeTs2Event } from "./peopleTimesheet.events.js";
import { computeFromTs2 } from "./peopleTimesheet.compute.js";

/* =========================================
 * Imports: чисті утиліти логіки стану обʼєкта/сесій
 * ========================================= */
import {
  ensureObject,
  getActive,
  workNameById,
  empNamesLine,
  openKey,
  findOpen,
  closeAllOpenForEmployee,
  closeAllOpen,
  askNextMessage,
} from "./peopleTimesheet.utils.js";

/**
 * ============================================================
 * PEOPLE TIMESHEET (TS2) — структура файлів і логіка
 * ============================================================
 *
 * Ціль: табель по людям на обʼєкті з запуском/зупинкою робіт (сесії),
 * автоматичним підрахунком часу, коефіцієнтами та записом у "ТАБЕЛЬ".
 *
 * -----------------------------
 * 1) peopleTimesheet.flow.ts  (цей файл)
 * -----------------------------
 * Тут тільки UI + стейт + роутинг кроків:
 * - start()        : ініціалізація стейту (date, objects, step) і перший рендер
 * - render()       : малює екрани по st.step (START/PICK_OBJECT/OBJECT_MENU/.../RATE/PREVIEW)
 * - onCallback()   : обробляє всі callback кнопок, змінює state і пише TS2 події
 *
 * Основна ідея: Flow НЕ рахує годин напряму — він пише події (TS2_*),
 * а розрахунок робить computeFromTs2().
 *
 * -----------------------------
 * 2) peopleTimesheet.cb.ts
 * -----------------------------
 * Тут всі callback префікси/константи:
 * - FLOW, PREFIX, cb.*   (PICK_OBJECT, OBJ, PEOPLE, WORKS, START_WORK, STOP_WORK, ...)
 * Щоб у flow не плодити "магічні строки".
 *
 * -----------------------------
 * 3) peopleTimesheet.types.ts
 * -----------------------------
 * Типи структури стейту та словників:
 * - State          : головний стейт flow (step/date/objects/activeObjectId/...)
 * - ObjectTS       : стейт одного обʼєкта (phase, employeeIds, works, assigned, open, coefs...)
 * - DictWork       : елемент довідника робіт (id/name/...)
 *
 * -----------------------------
 * 4) peopleTimesheet.utils.ts
 * -----------------------------
 * Утиліти чистої логіки (без Telegram UI і без Google Sheets запису):
 * - ensureObject(st, objectId)
 * - getActive(st)
 * - workNameById(obj, workId)
 * - empNamesLine(employeeIds, employeesDict)
 * - openKey(openSession)
 * - findOpen(obj, employeeId, workId)
 * - closeAllOpenForEmployee(obj, empId)
 * - closeAllOpen(obj)
 * - askNextMessage(bot, chatId, fromId, prompt, handler)
 *
 * -----------------------------
 * 5) peopleTimesheet.events.ts
 * -----------------------------
 * Один відповідальний писати TS2 події у "подієву" таблицю:
 * - writeTs2Event({type, date, objectId, foremanTgId, employeeIds, payload...})
 *
 * -----------------------------
 * 6) peopleTimesheet.compute.ts
 * -----------------------------
 * Один відповідальний рахувати агрегати табеля з подій:
 * - computeFromTs2({date, foremanTgId, objectId?})
 *
 * ============================================================
 * Ключова схема:
 * 1) Flow (UI) -> writeTs2Event() пише події
 * 2) computeFromTs2() -> читає події і рахує години/коефи
 * 3) SAVE -> upsertTimesheetRow() записує результат у "ТАБЕЛЬ"
 * ============================================================
 */

/* =========================================
 * Export: модуль flow для реєстрації у боті
 * ========================================= */
export const PeopleTimesheetFlow: FlowModule = {
  flow: FLOW,
  menuText: TEXTS.buttons.peopleTimesheet ?? "👥 Люди / Табель",
  cbPrefix: PREFIX,

  /* -----------------------------------------
   * start(): ініціалізація state і перший render
   * ----------------------------------------- */
  async start(bot, chatId, s) {
    const existing = getFlowState(s, FLOW) as State | undefined;
    if (existing) {
      existing.date = existing.date || todayISO();
      existing.objects = existing.objects || {};
      existing.step = existing.step || "START";
      setFlowState(s, FLOW, existing);
    } else {
      const st: State = { step: "START", date: todayISO(), objects: {} };
      setFlowState(s, FLOW, st);
    }

    s.mode = "FLOW";
    s.flow = FLOW;
    await this.render(bot, chatId, s);
  },

  /* -----------------------------------------
   * render(): UI екрани по st.step (тільки малювання)
   * ----------------------------------------- */
  async render(bot, chatId, s) {
    const st =
      (getFlowState(s, FLOW) as State) || ({ step: "START", date: todayISO(), objects: {} } as State);
    st.date = st.date || todayISO();
    st.objects = st.objects || {};
    const date = st.date;

    const objectsDict = await fetchObjects();
    const emps = await fetchEmployees();

    const active = getActive(st);
    const activeLine = active
      ? `${TEXTS.peopleTimesheetFlow.labels.activeObjectOk} ${active.objectId}`
      : TEXTS.peopleTimesheetFlow.labels.activeObjectNone;

    /* ===== Screen: START (головний екран flow) ===== */
    if (st.step === "START") {
      const activeCount = Object.values(st.objects).filter((o) => o.phase === "RUN").length;

      const text =
        `${TEXTS.peopleTimesheetFlow.title}\n` +
        `📅 ${date}\n` +
        `${activeLine}\n` +
        `${TEXTS.peopleTimesheetFlow.labels.activeObjectsCount} ${activeCount}\n\n` +
        TEXTS.peopleTimesheetFlow.screens.startHint;

      const rows: TelegramBot.InlineKeyboardButton[][] = [
        [{ text: TEXTS.peopleTimesheetFlow.buttons.pickActiveObject, callback_data: cb.PICK_OBJECT }],
        ...(active ? [[{ text: "📌 Відкрити меню активного обʼєкта", callback_data: `${cb.OBJ}${active.objectId}` }]] : []),
        [{ text: "📋 Preview (усі обʼєкти)", callback_data: cb.PREVIEW }],
        [{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }],
      ];

      await upsertInline(bot, chatId, s, FLOW, text, kb(rows));
      return;
    }

    /* ===== Screen: PICK_OBJECT (вибір активного обʼєкта) ===== */
    if (st.step === "PICK_OBJECT") {
      const slice = objectsDict.slice(0, 24);
      const rows: TelegramBot.InlineKeyboardButton[][] = slice.map((o) => {
        const selected = st.activeObjectId === o.id;
        return [{ text: `${selected ? "☑️ " : ""}${o.name} (${o.id})`, callback_data: `${cb.OBJ}${o.id}` }];
      });

      rows.push([{ text: "⬅️ Назад", callback_data: `${cb.BACK}start` }]);
      rows.push([{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }]);

      const text =
        `${TEXTS.peopleTimesheetFlow.screens.pickObjectTitle}\n` +
        `📅 ${date}\n\n` +
        `Оберіть активний обʼєкт.\n` +
        `Показую перші ${slice.length} з ${objectsDict.length}.`;

      await upsertInline(bot, chatId, s, FLOW, text, kb(rows));
      return;
    }

    /* ===== Guard: нижче потрібен активний обʼєкт ===== */
    if (!active) {
      st.step = "START";
      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return;
    }

    const { objectId, obj } = active;
    const objName = objectsDict.find((x) => x.id === objectId)?.name ?? objectId;

    /* ===== Screen: OBJECT_MENU (меню обʼєкта) ===== */
    if (st.step === "OBJECT_MENU") {
      const rosterLine = `👥 Люди: ${empNamesLine(obj.employeeIds, emps)}`;
      const worksLine = `🧱 Роботи: ${obj.works.length ? obj.works.map((w) => w.name).join(", ") : "—"}`;
      const openLine = `⏱ Людей працює: ${obj.open.length}`;

      const phaseLine =
        obj.phase === "SETUP"
          ? TEXTS.peopleTimesheetFlow.phase.setup
          : obj.phase === "RUN"
            ? TEXTS.peopleTimesheetFlow.phase.run
            : TEXTS.peopleTimesheetFlow.phase.finished;

      const rows: TelegramBot.InlineKeyboardButton[][] = [
        [{ text: "👥 Обрати людей (склад)", callback_data: cb.PEOPLE }],
        [{ text: "🧱 Роботи (зі списку)", callback_data: cb.WORKS }],
        [{ text: "🧩 Призначити роботи людям", callback_data: cb.ASSIGN_MENU }],
        ...(obj.phase !== "RUN" ? [[{ text: "▶️ Почати роботи", callback_data: cb.START_OBJ }]] : []),
        ...(obj.phase === "RUN" ? [[{ text: "🟢 Перейти в RUN екран", callback_data: cb.RUN }]] : []),
        ...(obj.phase === "RUN" ? [[{ text: "⏹ Завершити роботи", callback_data: cb.STOP_OBJ }]] : []),
        ...(obj.phase === "FINISHED" ? [[{ text: "⭐ Оцінка коефіцієнтів", callback_data: cb.RATE }]] : []),
        ...(obj.phase === "FINISHED" ? [[{ text: "💾 Зберегти табель", callback_data: cb.SAVE }]] : []),
        [{ text: "📋 Preview (усі обʼєкти)", callback_data: cb.PREVIEW }],
        [{ text: "⬅️ Назад", callback_data: `${cb.BACK}start` }],
        [{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }],
      ];

      const safeObjName = mdEscape(objName);
      const safeObjectId = mdEscape(objectId);

      const text =
        `🏗 Табель — ${safeObjName} (${safeObjectId})\n` +
        `📅 ${date}\n` +
        `${phaseLine}\n\n` +
        `${rosterLine}\n` +
        `${worksLine}\n` +
        `${openLine}\n\n` +
        `Меню обʼєкта.`;

      await upsertInline(bot, chatId, s, FLOW, text, kb(rows));
      return;
    }

    /* ===== Screen: PICK_PEOPLE (вибір складу людей) ===== */
    if (st.step === "PICK_PEOPLE") {
      const selected = new Set(obj.employeeIds);
      const slice = emps.slice(0, 40);

      const rows: TelegramBot.InlineKeyboardButton[][] = slice.map((e) => [
        { text: `${selected.has(e.id) ? "✅" : "▫️"} ${e.name} (${e.id})`, callback_data: `${cb.TOGGLE_EMP}${e.id}` },
      ]);

      rows.push([{ text: "✅ Готово", callback_data: cb.DONE }]);
      rows.push([{ text: "⬅️ Назад", callback_data: `${cb.BACK}obj` }]);
      rows.push([{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }]);

      const text =
        `👥 Люди — ${objName}\n` +
        `📅 ${date}\n\n` +
        `Обери склад людей для цього обʼєкта:\n` +
        `Обрано: ${selected.size}`;

      await upsertInline(bot, chatId, s, FLOW, text, kb(rows));
      return;
    }

    /* ===== Screen: WORKS_MENU (список обраних робіт) ===== */
    if (st.step === "WORKS_MENU") {
      const rows: TelegramBot.InlineKeyboardButton[][] = [
        [{ text: "➕ Додати роботу зі списку", callback_data: cb.PICK_WORK }],
        ...(obj.works.length
          ? obj.works.slice(0, 20).map((w) => [
              { text: `🧱 ${w.name}`.slice(0, 55), callback_data: `${cb.WORK}${w.workId}` },
            ])
          : [[{ text: "— Немає обраних робіт —", callback_data: `${cb.BACK}obj` }]]),
        [{ text: "⬅️ Назад", callback_data: `${cb.BACK}obj` }],
        [{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }],
      ];

      const text =
        `🧱 Роботи — ${objName}\n` +
        `📅 ${date}\n\n` +
        `Тут ти обираєш роботи з довідника (таблиці).\n` +
        `Всього обрано: ${obj.works.length}`;

      await upsertInline(bot, chatId, s, FLOW, text, kb(rows));
      return;
    }

    /* ===== Screen: PICK_WORK (довідник робіт, multi-toggle) ===== */
    if (st.step === "PICK_WORK") {
      const worksDict: DictWork[] = await fetchWorks();
      const slice = (worksDict ?? []).slice(0, 40);

      const picked = new Set(obj.works.map((w) => w.workId));
      const rows: TelegramBot.InlineKeyboardButton[][] = slice.map((w) => {
        const id = String(w.id);
        const name = String(w.name ?? id);
        const on = picked.has(id);
        return [{ text: `${on ? "✅ " : "▫️ "}${name} (${id})`.slice(0, 60), callback_data: `${cb.WORK}${id}` }];
      });

      rows.push([{ text: "✅ Готово", callback_data: cb.WORKS_DONE }]);
      rows.push([{ text: "⬅️ Назад", callback_data: `${cb.BACK}works` }]);
      rows.push([{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }]);

      const text =
        `📚 Довідник робіт — ${objName}\n` +
        `📅 ${date}\n\n` +
        `Натисни на роботу, щоб додати її в обʼєкт.\n` +
        `Показую перші ${slice.length} з ${worksDict.length}.`;

      await upsertInline(bot, chatId, s, FLOW, text, kb(rows));
      return;
    }

    /* ===== Screen: WORK_ASSIGN (вибір людини для призначення робіт) ===== */
    if (st.step === "WORK_ASSIGN") {
      const rows: TelegramBot.InlineKeyboardButton[][] = obj.employeeIds.length
        ? obj.employeeIds.map((empId) => {
            const name = emps.find((e) => e.id === empId)?.name ?? empId;
            const cnt = (obj.assigned[empId] ?? []).length;
            return [{ text: `👤 ${name} (${empId}) — 🧱 ${cnt}`, callback_data: `${cb.ASSIGN_EMP}${empId}` }];
          })
        : [[{ text: "⚠️ Спочатку обери людей", callback_data: cb.PEOPLE }]];

      rows.push([{ text: "✅ Готово", callback_data: cb.ASSIGN_DONE }]);
      rows.push([{ text: "⬅️ Назад", callback_data: `${cb.BACK}obj` }]);
      rows.push([{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }]);

      const text =
        `🧩 Призначення робіт — ${objName}\n` +
        `📅 ${date}\n\n` +
        `Обери людину, щоб призначити/зняти їй роботи.`;

      await upsertInline(bot, chatId, s, FLOW, text, kb(rows));
      return;
    }

    /* ===== Screen: RUN (запуск/зупинка сесій робіт) ===== */
    if (st.step === "RUN") {
      const rosterLine = `👥 ${empNamesLine(obj.employeeIds, emps)}`;
      const openLine = `⏱ Людей працює: ${obj.open.length}`;

      const rows: TelegramBot.InlineKeyboardButton[][] = [];

      if (!obj.employeeIds.length) {
        rows.push([{ text: "⚠️ Спочатку обери людей", callback_data: cb.PEOPLE }]);
      } else if (!obj.works.length) {
        rows.push([{ text: "⚠️ Спочатку обери роботи", callback_data: cb.WORKS }]);
      } else {
        rows.push([{ text: "🔁 Перенести людину між обʼєктами", callback_data: cb.MOVE_EMP }]);
        rows.push([{ text: "🧩 Призначити роботи людям", callback_data: cb.ASSIGN_MENU }]);

        for (const empId of obj.employeeIds.slice(0, 8)) {
          const name = emps.find((e) => e.id === empId)?.name ?? empId;
          const assigned = obj.assigned[empId] ?? [];
          if (!assigned.length) continue;

          const wids = assigned;
          const btns: TelegramBot.InlineKeyboardButton[] = [];
          for (const wid of wids) {
            const isOpen = !!findOpen(obj, empId, wid);
            const label = `${isOpen ? "⏹" : "▶️"} ${workNameById(obj, wid)}`;
            btns.push({
              text: `${name}: ${label}`.slice(0, 60),
              callback_data: isOpen ? `${cb.STOP_WORK}${empId}||${wid}` : `${cb.START_WORK}${empId}||${wid}`,
            });
          }
          rows.push(btns);
        }
      }

      rows.push([{ text: "⏹ Завершити роботи на обʼєкті", callback_data: cb.STOP_OBJ }]);
      rows.push([{ text: "⬅️ Назад", callback_data: `${cb.BACK}obj` }]);
      rows.push([{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }]);

      const text =
        `🟢 RUN — ${objName}\n` +
        `📅 ${date}\n\n` +
        `${rosterLine}\n` +
        `${openLine}\n\n` +
        `Під час RUN:\n` +
        `• запускай/зупиняй роботу (сесії)\n` +
        `• призначай/знімай роботи\n` +
        `• перенось людей між обʼєктами`;

      await upsertInline(bot, chatId, s, FLOW, text, kb(rows));
      return;
    }

    /* ===== Screen: MOVE_EMP_PICK (вибір людини для переносу) ===== */
    if (st.step === "MOVE_EMP_PICK") {
      const rows: TelegramBot.InlineKeyboardButton[][] = obj.employeeIds.map((empId) => {
        const name = emps.find((e) => e.id === empId)?.name ?? empId;
        return [{ text: `👤 ${name} (${empId})`, callback_data: `${cb.MOVE_PICK}${empId}` }];
      });

      rows.push([{ text: "⬅️ Назад", callback_data: `${cb.BACK}run` }]);
      rows.push([{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }]);

      const text = `🔁 Перенести людину\nЗвідки: ${objName} (${objectId})\n\nОберіть людину:`;
      await upsertInline(bot, chatId, s, FLOW, text, kb(rows));
      return;
    }

    /* ===== Screen: MOVE_EMP_TO_OBJ (вибір цільового обʼєкта) ===== */
    if (st.step === "MOVE_EMP_TO_OBJ") {
      const empId = st.moveEmployeeId;
      const empName = emps.find((e) => e.id === empId)?.name ?? empId ?? "—";

      const slice = objectsDict.slice(0, 24);
      const rows: TelegramBot.InlineKeyboardButton[][] = slice.map((o) => [
        { text: `${o.name} (${o.id})`, callback_data: `${cb.MOVE_TO}${o.id}` },
      ]);

      rows.push([{ text: "⬅️ Назад", callback_data: `${cb.BACK}move_pick` }]);
      rows.push([{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }]);

      const text =
        `🔁 Перенести людину\n` +
        `Людина: ${empName} (${empId})\n` +
        `Звідки: ${objName} (${objectId})\n\n` +
        `Куди переносимо?`;

      await upsertInline(bot, chatId, s, FLOW, text, kb(rows));
      return;
    }

    /* ===== Screen: RATE (оцінка 2 коефіцієнтів) ===== */
    if (st.step === "RATE") {
      const ids = obj.employeeIds;
      const rows: TelegramBot.InlineKeyboardButton[][] = [];

      for (const empId of ids.slice(0, 40)) {
        const name = emps.find((e) => e.id === empId)?.name ?? empId;

        const disc = obj.coefDiscipline[empId] ?? 1.0;
        const prod = obj.coefProductivity[empId] ?? 1.0;

        rows.push([{ text: `👤 ${name}`, callback_data: `${cb.COEF_CUSTOM_DISC}${empId}` }]);

        rows.push([
          { text: "−", callback_data: `${cb.DISC_DEC}${empId}` },
          { text: `Дисц ${disc.toFixed(1)}`, callback_data: `${cb.COEF_CUSTOM_DISC}${empId}` },
          { text: "+", callback_data: `${cb.DISC_INC}${empId}` },

          { text: "−", callback_data: `${cb.PROD_DEC}${empId}` },
          { text: `Прод ${prod.toFixed(1)}`, callback_data: `${cb.COEF_CUSTOM_PROD}${empId}` },
          { text: "+", callback_data: `${cb.PROD_INC}${empId}` },
        ]);
      }

      rows.push([{ text: "💾 Зберегти табель", callback_data: cb.SAVE }]);
      rows.push([{ text: "⬅️ Назад", callback_data: `${cb.BACK}obj` }]);
      rows.push([{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }]);

      const text =
        `⭐ Оцінка — ${objName}\n` +
        `📅 ${date}\n\n` +
        `Крок: 0.1 (кнопки −/+).\n` +
        `Натисни на значення, щоб ввести вручну.`;

      await upsertInline(bot, chatId, s, FLOW, text, kb(rows));
      return;
    }

    /* ===== Screen: PREVIEW (агрегація по всіх обʼєктах) ===== */
    if (st.step === "PREVIEW") {
      const foreman = Number((s as any).actorTgId ?? 0);
      const all = await computeFromTs2({ date, foremanTgId: foreman });

      const objAgg = new Map<string, { sec: number; people: Set<string> }>();

      for (const r of all) {
        const a = objAgg.get(r.objectId) ?? { sec: 0, people: new Set<string>() };
        a.sec += r.sec;
        a.people.add(String(r.employeeId));
        objAgg.set(r.objectId, a);
      }

      const totalSec = [...objAgg.values()].reduce((sum, x) => sum + x.sec, 0);
      const totalPeople = new Set<string>();
      for (const a of objAgg.values()) for (const p of a.people) totalPeople.add(p);

      const lines: string[] = [];
      lines.push(`📋 Preview табеля`);
      lines.push(`📅 ${date}`);
      lines.push("");
      lines.push(`🏗 Всього обʼєктів: ${objAgg.size}`);
      lines.push(`👥 Всього людей: ${totalPeople.size}`);
      lines.push(`⏱ Всього годин: ${Math.round((totalSec / 3600) * 100) / 100}`);
      lines.push("");

      for (const [oid, a] of [...objAgg.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
        const oname = objectsDict.find((x) => x.id === oid)?.name ?? oid;
        const h = Math.round((a.sec / 3600) * 100) / 100;
        lines.push(`🏗 ${oname} (${oid}) — 👥 ${a.people.size} | ⏱ ${h} год`);
      }

      const text = lines.join("\n");

      await upsertInline(
        bot,
        chatId,
        s,
        FLOW,
        text,
        kb([
          [{ text: "⬅️ Назад", callback_data: `${cb.BACK}start` }],
          [{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }],
        ]),
      );
      return;
    }

    /* ===== Fallback: якщо step невідомий — повертаємось в меню обʼєкта ===== */
    st.step = "OBJECT_MENU";
    setFlowState(s, FLOW, st);
    await this.render(bot, chatId, s);
  },

  /* -----------------------------------------
   * onCallback(): обробка кнопок (state + TS2 events)
   * ----------------------------------------- */
  async onCallback(bot, q, s, data) {
    if (!data.startsWith(PREFIX)) return false;

    const chatId = q.message?.chat?.id;
    const msgId = q.message?.message_id;
    if (typeof chatId !== "number" || typeof msgId !== "number") return true;

    const foremanTgId = q.from?.id ?? 0;

    const st =
      (getFlowState(s, FLOW) as State) || ({ step: "START", date: todayISO(), objects: {} } as State);
    st.date = st.date || todayISO();
    st.objects = st.objects || {};
    const date = st.date;

    /* ===== Helper: показати alert на callback ===== */
    const gate = async (text: string) => {
      await bot.answerCallbackQuery(q.id, { text: `⛔ ${text}`, show_alert: true });
    };

    /* ===== Navigation: MENU (повернення в START) ===== */
    if (data === cb.MENU) {
      st.step = "START";
      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }

    /* ===== Navigation: BACK (router назад по тегу) ===== */
    if (data.startsWith(cb.BACK)) {
      const tag = data.slice(cb.BACK.length);
      if (tag === "start") st.step = "START";
      else if (tag === "obj") st.step = "OBJECT_MENU";
      else if (tag === "run") st.step = "RUN";
      else if (tag === "works") st.step = "WORKS_MENU";
      else if (tag === "assign") st.step = "WORK_ASSIGN";
      else if (tag === "move_pick") st.step = "MOVE_EMP_PICK";
      else st.step = "START";

      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }

    /* ===== Navigation: PICK_OBJECT (перейти у список обʼєктів) ===== */
    if (data === cb.PICK_OBJECT) {
      st.step = "PICK_OBJECT";
      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }

    /* ===== Guard: далі потрібен активний обʼєкт ===== */
    const active = getActive(st);
    if (!active) {
      st.step = "START";
      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }
    const { objectId, obj } = active;

    // ✅ Автоперехід: якщо щось не заповнено — ведемо на наступний крок
    const autoAdvance = async () => {
      // якщо обʼєкт ще не вибраний — список обʼєктів
      if (!st.activeObjectId) {
        st.step = "PICK_OBJECT";
        setFlowState(s, FLOW, st);
        await this.render(bot, chatId, s);
        return;
      }

    /* ===== Action: select object (встановити activeObjectId) ===== */
    if (data.startsWith(cb.OBJ)) {
      const objectId = data.slice(cb.OBJ.length);
      st.activeObjectId = objectId;
      ensureObject(st, objectId);
      st.step = "OBJECT_MENU";
      setFlowState(s, FLOW, st);
      await autoAdvance();
      return true;
    }

    // 1) SETUP: люди -> роботи -> призначення
      if (obj.phase === "SETUP") {
        if (!obj.employeeIds?.length) {
          st.step = "PICK_PEOPLE";
          setFlowState(s, FLOW, st);
          await this.render(bot, chatId, s);
          return;
        }

        if (!obj.works?.length) {
          st.step = "WORKS_MENU";
          setFlowState(s, FLOW, st);
          await this.render(bot, chatId, s);
          return;
        }

        const needAssign = (obj.employeeIds ?? []).some((empId) => !(obj.assigned?.[empId]?.length));
        if (needAssign) {
          st.step = "WORK_ASSIGN";
          setFlowState(s, FLOW, st);
          await this.render(bot, chatId, s);
          return;
        }

        // все заповнено для старту — показуємо меню обʼєкта (там кнопка ▶️ Почати)
        st.step = "OBJECT_MENU";
        setFlowState(s, FLOW, st);
        await this.render(bot, chatId, s);
        return;
      }

      // 2) RUN
      if (obj.phase === "RUN") {
        st.step = "RUN";
        setFlowState(s, FLOW, st);
        await this.render(bot, chatId, s);
        return;
      }

      // 3) FINISHED -> RATE (поки не SAVE)
      if (obj.phase === "FINISHED") {
        st.step = "RATE";
        setFlowState(s, FLOW, st);
        await this.render(bot, chatId, s);
        return;
      }

      // fallback
      st.step = "OBJECT_MENU";
      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
    };
    
    /* ===== Shortcuts: переходи по меню обʼєкта ===== */
    if (data === cb.PEOPLE) {
      st.step = "PICK_PEOPLE";
      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }
    if (data === cb.WORKS) {
      st.step = "WORKS_MENU";
      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }
    if (data === cb.PICK_WORK) {
      if (obj.phase === "FINISHED") {
        await gate("Обʼєкт уже завершено. Додавати роботи не можна.");
        return true;
      }
      st.step = "PICK_WORK";
      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }
    if (data === cb.ASSIGN_MENU) {
      st.step = "WORK_ASSIGN";
      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }
    if (data === cb.RUN) {
      if (obj.phase !== "RUN") {
        await gate("Спочатку натисни “Почати роботи”.");
        return true;
      }
      st.step = "RUN";
      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }
    if (data === cb.PREVIEW) {
      st.step = "PREVIEW";
      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }

    /* ===== Action: TOGGLE_EMP (додати/прибрати людину зі складу) ===== */
    if (data.startsWith(cb.TOGGLE_EMP)) {
      if (obj.phase === "FINISHED") {
        await gate("Обʼєкт уже завершено. Змінювати склад не можна.");
        return true;
      }

      const empId = data.slice(cb.TOGGLE_EMP.length);
      const has = obj.employeeIds.includes(empId);
      obj.employeeIds = has ? obj.employeeIds.filter((x) => x !== empId) : [...obj.employeeIds, empId];

      obj.coefDiscipline[empId] ??= 1.0;
      obj.coefProductivity[empId] ??= 1.0;
      obj.assigned[empId] ??= [];

      if (has && obj.phase === "RUN") {
        const closed = closeAllOpenForEmployee(obj, empId);
        const ts = nowISO();
        for (const s0 of closed) {
          await writeTs2Event({
            bot,
            chatId,
            msgId,
            date,
            foremanTgId,
            objectId,
            type: "TS2_WORK_STOP",
            employeeIds: [empId],
            payload: { employeeId: empId, workId: s0.workId, auto: true, closedAt: ts },
          });
        }
      }

      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }

    /* ===== Navigation: WORKS_DONE (закрити PICK_WORK) ===== */
    if (data === cb.WORKS_DONE) {
      st.step = "WORKS_MENU";
      setFlowState(s, FLOW, st);
      await autoAdvance();
      return true;
    }

    /* ===== Navigation: DONE (закрити PICK_PEOPLE) ===== */
    if (data === cb.DONE) {
      st.step = "OBJECT_MENU";
      setFlowState(s, FLOW, st);
      await autoAdvance();
      return true;
    }

    /* ===== Action: WORK toggle (додати/зняти роботу з обʼєкта) ===== */
    if (data.startsWith(cb.WORK)) {
      if (obj.phase === "FINISHED") {
        await gate("Обʼєкт уже завершено. Змінювати роботи не можна.");
        return true;
      }

      const workId = data.slice(cb.WORK.length);
      if (!workId) return true;

      const dict = (await fetchWorks()) as DictWork[];
      const found = dict.find((w) => String(w.id) === String(workId));
      const name = found?.name ? String(found.name) : String(workId);

      const has = obj.works.some((w) => w.workId === workId);

      if (has && obj.phase === "RUN") {
        const now = nowISO();
        const toClose = obj.open.filter((x) => x.workId === workId);
        obj.open = obj.open.filter((x) => x.workId !== workId);

        for (const s0 of toClose) {
          await writeTs2Event({
            bot,
            chatId,
            msgId,
            date,
            foremanTgId,
            objectId,
            type: "TS2_WORK_STOP",
            employeeIds: [s0.employeeId],
            payload: {
              employeeId: s0.employeeId,
              workId: s0.workId,
              auto: true,
              closedAt: now,
              reason: "WORK_TOGGLED_OFF",
            },
          });
        }
      }

      if (has) {
        obj.works = obj.works.filter((w) => w.workId !== workId);

        for (const empId of Object.keys(obj.assigned)) {
          obj.assigned[empId] = (obj.assigned[empId] ?? []).filter((x) => x !== workId);
        }

        await writeTs2Event({
          bot,
          chatId,
          msgId,
          date,
          foremanTgId,
          objectId,
          type: "TS2_WORK_REMOVE",
          payload: { workId, name, source: "DICT_TOGGLE" },
        });
      } else {
        obj.works.push({ workId, name });

        await writeTs2Event({
          bot,
          chatId,
          msgId,
          date,
          foremanTgId,
          objectId,
          type: "TS2_WORK_ADD",
          payload: { workId, name, source: "DICT_TOGGLE" },
        });
      }

      st.step = "PICK_WORK";
      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }

    /** 
        if (data.startsWith(cb.WORKS_REMOVE)) {
          if (obj.phase === "FINISHED") {
            await gate("Обʼєкт уже завершено. Видаляти роботи не можна.");
            return true;
          }

          const workId = data.slice(cb.WORKS_REMOVE.length);
          if (!workId) return true;

          if (obj.phase === "RUN") {
            const now = nowISO();
            const toClose = obj.open.filter((x) => x.workId === workId);
            obj.open = obj.open.filter((x) => x.workId !== workId);
            for (const s0 of toClose) {
              await writeTs2Event({
                bot,
                chatId,
                msgId,
                date,
                foremanTgId,
                objectId,
                type: "TS2_WORK_STOP",
                employeeIds: [s0.employeeId],
                payload: { employeeId: s0.employeeId, workId: s0.workId, auto: true, closedAt: now, reason: "WORK_REMOVED" },
              });
            }
          }

          obj.works = obj.works.filter((w) => w.workId !== workId);
          for (const empId of Object.keys(obj.assigned))
            obj.assigned[empId] = (obj.assigned[empId] ?? []).filter((x) => x !== workId);

          await writeTs2Event({ bot, chatId, msgId, date, foremanTgId, objectId, type: "TS2_WORK_REMOVE", payload: { workId } });

          setFlowState(s, FLOW, st);
          await this.render(bot, chatId, s);
          return true;
        }
    */

    /* ===== Action: START_OBJ (перевести обʼєкт у RUN) ===== */
    if (data === cb.START_OBJ) {
      if (obj.phase === "RUN") return gate("Вже запущено."), true;
      if (!obj.employeeIds.length) return gate("Спочатку обери людей."), true;
      if (!obj.works.length) return gate("Спочатку обери роботи."), true;

      obj.phase = "RUN";
      obj.startedAt = nowISO();

      await writeTs2Event({
        bot,
        chatId,
        msgId,
        date,
        foremanTgId,
        objectId,
        type: "TS2_OBJ_START",
        employeeIds: obj.employeeIds,
        payload: { startedAt: obj.startedAt, employeeIds: obj.employeeIds.join(",") },
      });

      st.step = "RUN";
      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }

    /* ===== Action: STOP_OBJ (зупинка RUN + закриття всіх сесій) ===== */
    if (data === cb.STOP_OBJ) {
      if (obj.phase !== "RUN") return gate("Роботи не запущені."), true;

      const endedAt = nowISO();
      obj.endedAt = endedAt;
      obj.phase = "FINISHED";

      const closed = closeAllOpen(obj);
      for (const s0 of closed) {
        await writeTs2Event({
          bot,
          chatId,
          msgId,
          date,
          foremanTgId,
          objectId,
          type: "TS2_WORK_STOP",
          employeeIds: [s0.employeeId],
          payload: { employeeId: s0.employeeId, workId: s0.workId, auto: true, closedAt: endedAt },
        });
      }

      await writeTs2Event({
        bot,
        chatId,
        msgId,
        date,
        foremanTgId,
        objectId,
        type: "TS2_OBJ_STOP",
        employeeIds: obj.employeeIds,
        payload: { endedAt, employeeIds: obj.employeeIds.join(",") },
      });

      st.step = "RATE";
      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }

    /* ===== Action: START_WORK (старт сесії роботи) ===== */
    if (data.startsWith(cb.START_WORK)) {
      if (obj.phase !== "RUN") return gate("Спочатку запусти роботи на обʼєкті."), true;

      const [employeeId, workId] = data.slice(cb.START_WORK.length).split("||");
      if (!employeeId || !workId) return true;

      if (!obj.employeeIds.includes(employeeId)) return gate("Цієї людини немає в складі обʼєкта."), true;

      const assigned = obj.assigned[employeeId] ?? [];
      if (!assigned.includes(workId)) return gate("Спочатку признач цю роботу людині."), true;

      if (findOpen(obj, employeeId, workId)) return gate("Вже запущено."), true;

      const startedAt = nowISO();
      obj.open.push({ objectId, employeeId, workId, startedAt });

      await writeTs2Event({
        bot,
        chatId,
        msgId,
        date,
        foremanTgId,
        objectId,
        type: "TS2_WORK_START",
        employeeIds: [employeeId],
        payload: { employeeId, workId, startedAt },
      });

      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }

    /* ===== Action: STOP_WORK (стоп сесії роботи) ===== */
    if (data.startsWith(cb.STOP_WORK)) {
      if (obj.phase !== "RUN") return gate("Роботи не активні."), true;

      const [employeeId, workId] = data.slice(cb.STOP_WORK.length).split("||");
      if (!employeeId || !workId) return true;

      const opened = findOpen(obj, employeeId, workId);
      if (!opened) return gate("Сесія не запущена."), true;

      obj.open = obj.open.filter((x) => openKey(x) !== openKey(opened));
      const endedAt = nowISO();

      await writeTs2Event({
        bot,
        chatId,
        msgId,
        date,
        foremanTgId,
        objectId,
        type: "TS2_WORK_STOP",
        employeeIds: [employeeId],
        payload: { employeeId, workId, endedAt },
      });

      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }

    /* ===== Navigation/Action: MOVE (перенос людей між обʼєктами) ===== */
    if (data === cb.MOVE_EMP) {
      if (obj.phase !== "RUN") return gate("Переносити людей можна під час RUN."), true;
      st.step = "MOVE_EMP_PICK";
      delete st.moveEmployeeId;
      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }

    if (data.startsWith(cb.MOVE_PICK)) {
      const empId = data.slice(cb.MOVE_PICK.length);
      if (!empId) return true;
      st.moveEmployeeId = empId;
      st.step = "MOVE_EMP_TO_OBJ";
      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }

    if (data.startsWith(cb.MOVE_TO)) {
      if (obj.phase !== "RUN") return gate("Переносити людей можна під час RUN."), true;
      const toObjectId = data.slice(cb.MOVE_TO.length);
      const empId = st.moveEmployeeId;
      if (!toObjectId || !empId) return true;

      const closed = closeAllOpenForEmployee(obj, empId);
      const ts = nowISO();
      for (const s0 of closed) {
        await writeTs2Event({
          bot,
          chatId,
          msgId,
          date,
          foremanTgId,
          objectId,
          type: "TS2_WORK_STOP",
          employeeIds: [empId],
          payload: { employeeId: empId, workId: s0.workId, auto: true, closedAt: ts, reason: "MOVE" },
        });
      }

      obj.employeeIds = obj.employeeIds.filter((x) => x !== empId);

      const toObj = ensureObject(st, toObjectId);
      if (!toObj.employeeIds.includes(empId)) toObj.employeeIds.push(empId);

      toObj.coefDiscipline[empId] ??= 1.0;
      toObj.coefProductivity[empId] ??= 1.0;

      toObj.assigned[empId] ??= [];

      await writeTs2Event({
        bot,
        chatId,
        msgId,
        date,
        foremanTgId,
        objectId,
        type: "TS2_EMP_MOVE",
        employeeIds: [empId],
        payload: { employeeId: empId, toObjectId, at: ts },
      });

      st.activeObjectId = toObjectId;
      st.step = "OBJECT_MENU";
      delete st.moveEmployeeId;

      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }

    /* ===== Navigation: RATE (вхід на екран оцінки) ===== */
    if (data === cb.RATE) {
      if (obj.phase !== "FINISHED") return gate("Оцінка доступна після завершення робіт."), true;
      st.step = "RATE";
      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }

    /* ===== Action: +/- для 2 коефів (крок 0.1) ===== */
    if (
      data.startsWith(cb.DISC_DEC) ||
      data.startsWith(cb.DISC_INC) ||
      data.startsWith(cb.PROD_DEC) ||
      data.startsWith(cb.PROD_INC)
    ) {
      if (obj.phase !== "FINISHED") return gate("Оцінка доступна після завершення."), true;

      const isDisc = data.startsWith(cb.DISC_DEC) || data.startsWith(cb.DISC_INC);
      const isInc = data.startsWith(cb.DISC_INC) || data.startsWith(cb.PROD_INC);

      const prefix = isDisc
        ? (isInc ? cb.DISC_INC : cb.DISC_DEC)
        : (isInc ? cb.PROD_INC : cb.PROD_DEC);

      const empId = data.slice(prefix.length);
      if (!empId) return true;

      const cur = isDisc ? (obj.coefDiscipline[empId] ?? 1.0) : (obj.coefProductivity[empId] ?? 1.0);
      const next = clampCoef01(cur + (isInc ? 0.1 : -0.1));

      if (isDisc) obj.coefDiscipline[empId] = next;
      else obj.coefProductivity[empId] = next;

      await writeTs2Event({
        bot,
        chatId,
        msgId,
        date,
        foremanTgId,
        objectId,
        type: "TS2_COEF_SET",
        employeeIds: [empId],
        payload: {
          employeeId: empId,
          value: next,
          kind: isDisc ? "discipline" : "productivity",
          step: 0.1,
        },
      });

      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }

    /* ===== Action: SET_COEF_* (швидке встановлення коефів з кнопок) ===== */
    if (data.startsWith(cb.SET_COEF_DISC) || data.startsWith(cb.SET_COEF_PROD)) {
      if (obj.phase !== "FINISHED") return gate("Оцінка доступна після завершення."), true;

      const isDisc = data.startsWith(cb.SET_COEF_DISC);
      const rest = data.slice((isDisc ? cb.SET_COEF_DISC : cb.SET_COEF_PROD).length);
      const [empId, valStr] = rest.split("||");
      const v = Number(valStr);
      if (!empId || !Number.isFinite(v)) return true;

      if (isDisc) obj.coefDiscipline[empId] = v;
      else obj.coefProductivity[empId] = v;

      await writeTs2Event({
        bot,
        chatId,
        msgId,
        date,
        foremanTgId,
        objectId,
        type: "TS2_COEF_SET",
        employeeIds: [empId],
        payload: { employeeId: empId, value: v, kind: isDisc ? "discipline" : "productivity" },
      });

      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }

    /* ===== Action: COEF_CUSTOM_* (ручний ввід коефів через наступне повідомлення) ===== */
    if (data.startsWith(cb.COEF_CUSTOM_DISC) || data.startsWith(cb.COEF_CUSTOM_PROD)) {
      if (obj.phase !== "FINISHED") return gate("Оцінка доступна після завершення."), true;

      const isDisc = data.startsWith(cb.COEF_CUSTOM_DISC);
      const empId = data.slice((isDisc ? cb.COEF_CUSTOM_DISC : cb.COEF_CUSTOM_PROD).length);
      if (!empId) return true;

      await askNextMessage(
        bot,
        chatId,
        foremanTgId,
        `✍️ Введи ${isDisc ? "коеф. дисципліни" : "коеф. продуктивності"} для ${empId} (наприклад 1 або 1.15):`,
        async (msg) => {
          const raw = (msg.text ?? "").toString();
          const v = parseCoef(raw);
          if (v === undefined) {
            await bot.sendMessage(chatId, "❌ Не схоже на число. Діапазон: 0.1..3. Приклад: 1.15");
            return;
          }

          if (isDisc) obj.coefDiscipline[empId] = v;
          else obj.coefProductivity[empId] = v;

          await writeTs2Event({
            bot,
            chatId,
            msgId,
            date,
            foremanTgId,
            objectId,
            type: "TS2_COEF_SET",
            employeeIds: [empId],
            payload: { employeeId: empId, value: v, kind: isDisc ? "discipline" : "productivity", custom: true },
          });

          await bot.sendMessage(chatId, TEXTS.ui.ok.saved);
          st.step = "RATE";
          setFlowState(s, FLOW, st);
          await this.render(bot, chatId, s);
        },
      );

      return true;
    }

    /* ===== Action: SAVE (агрегація + запис у "ТАБЕЛЬ" + refresh checklist) ===== */
    if (data === cb.SAVE) {
      if (obj.phase !== "FINISHED") return gate("Спочатку заверши роботи (STOP)."), true;

      const ds = await getDayStatusRow(date, objectId, foremanTgId);
      if (isLocked(ds?.status)) {
        await bot.sendMessage(chatId, `🔒 День уже ${ds?.status}. Збереження табеля недоступне.`);
        return true;
      }

      const agg = await computeFromTs2({ date, foremanTgId, objectId });
      const nameById = new Map((await fetchEmployees()).map((e: any) => [String(e.id), String(e.name)]));

      for (const r of agg) {
        const hours = Math.round((r.sec / 3600) * 100) / 100;
        await upsertTimesheetRow({
          date,
          objectId: r.objectId,
          employeeId: r.employeeId,
          employeeName: nameById.get(String(r.employeeId)) ?? r.employeeId,
          hours,
          source: "TS2_EVENTS",
          productivityCoef: r.productivityCoef,
          disciplineCoef: r.disciplineCoef,
          updatedAt: nowISO(),
        } as any);
      }

      await refreshDayChecklist(date, objectId, foremanTgId);

      await bot.sendMessage(
        chatId,
        `✅ Табель збережено: ${objectId}\n` +
          `Рядків: ${agg.length}\n` +
          `Preview рахується по TS2_OBJ_START/STOP та TS2_WORK_START/STOP.`,
      );

      st.objects[objectId] = {
        phase: "SETUP",
        objectId,
        employeeIds: [],
        works: [],
        assigned: {},
        open: [],
        coefDiscipline: {},
        coefProductivity: {},
      };

      st.step = "START";
      setFlowState(s, FLOW, st);
      await this.render(bot, chatId, s);
      return true;
    }

    /* ===== Action: ASSIGN_EMP (відкрити екран призначення робіт конкретній людині) ===== */
    if (data.startsWith(cb.ASSIGN_EMP)) {
      const empId = data.slice(cb.ASSIGN_EMP.length);
      if (!empId) return true;

      if (!obj.works.length) return gate("Спочатку обери роботи."), true;

      const assigned = new Set(obj.assigned[empId] ?? []);
      const rows: TelegramBot.InlineKeyboardButton[][] = obj.works.slice(0, 30).map((w) => {
        const on = assigned.has(w.workId);
        return [
          {
            text: `${on ? "✅" : "▫️"} ${w.name}`.slice(0, 60),
            callback_data: `${cb.ASSIGN_TOGGLE}${empId}||${w.workId}`,
          },
        ];
      });

      rows.push([{ text: "✅ Готово", callback_data: `${cb.BACK}assign` }]);
      rows.push([{ text: "⬅️ Назад", callback_data: `${cb.BACK}assign` }]);
      rows.push([{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }]);

      await upsertInline(
        bot,
        chatId,
        s,
        FLOW,
        `🧩 Призначити роботи\nОбʼєкт: ${objectId}\nЛюдина: ${empId}\n\nНатискай щоб призначити/зняти:`,
        kb(rows),
      );
      return true;
    }

    /* ===== Action: ASSIGN_TOGGLE (призначити/зняти роботу людині) ===== */
    if (data.startsWith(cb.ASSIGN_TOGGLE)) {
      const rest = data.slice(cb.ASSIGN_TOGGLE.length);
      const [empId, workId] = rest.split("||");
      if (!empId || !workId) return true;

      obj.assigned[empId] ??= [];
      const has = obj.assigned[empId].includes(workId);
      obj.assigned[empId] = has ? obj.assigned[empId].filter((x) => x !== workId) : [...obj.assigned[empId], workId];

      await writeTs2Event({
        bot,
        chatId,
        msgId,
        date,
        foremanTgId,
        objectId,
        type: has ? "TS2_UNASSIGN" : "TS2_ASSIGN",
        employeeIds: [empId],
        payload: { employeeId: empId, workId, workName: workNameById(obj, workId) },
      });

      const fake = `${cb.ASSIGN_EMP}${empId}`;
      return this.onCallback(bot, q, s, fake);
    }

    /* ===== Navigation: ASSIGN_DONE (закрити призначення робіт) ===== */
    if (data === cb.ASSIGN_DONE) {
      st.step = "OBJECT_MENU";
      setFlowState(s, FLOW, st);
      await autoAdvance();
      return true;
    }

    /* ===== Default: якщо нічого не підійшло — назад в меню обʼєкта ===== */
    st.step = "OBJECT_MENU";
    setFlowState(s, FLOW, st);
    await this.render(bot, chatId, s);
    return true;
  },
};