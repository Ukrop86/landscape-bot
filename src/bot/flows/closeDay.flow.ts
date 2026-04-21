// src/bot/flows/closeDay.flow.ts
import type TelegramBot from "node-telegram-bot-api";
import { TEXTS } from "../texts.js";

import type { FlowModule, FlowBaseState, Flow } from "../core/flowTypes.js";
import { upsertInline, todayISO, getFlowState, setFlowState } from "../core/helpers.js";
import { CB } from "../core/cb.js";

import { fetchObjects } from "../../google/sheets/dictionaries.js";
import { getDayStatusRow } from "../../google/sheets/checklist.js";
import { refreshDayChecklist, setDayStatus } from "../../google/sheets/working.js";

type Step = "PICK_OBJECT" | "VIEW";

type State = FlowBaseState & {
  step: Step;
  objectId?: string;
  date?: string;
};

const FLOW: Flow = "CLOSE_DAY";
const CBP = "cd:" as const;

const cb = {
  PICK: `${CBP}pick`,
  OBJ: `${CBP}obj:`, // + objectId
  REFRESH: `${CBP}refresh`,
  SUBMIT: `${CBP}submit`,
};

function kb(rows: TelegramBot.InlineKeyboardButton[][]): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: rows };
}

function yn(v: boolean) {
  return v ? "✅" : "❌";
}

function safe(v?: string) {
  const s = String(v ?? "").trim();
return s.length ? s : TEXTS.ui.symbols.emptyDash;
}

export const CloseDayFlow: FlowModule = {
  flow: FLOW,
  menuText: TEXTS.buttons.closeDay,
  cbPrefix: CBP,

  async start(bot, chatId, s) {
    const st: State = { step: "PICK_OBJECT" };
    setFlowState(s, FLOW, st);
    s.mode = "FLOW";
    s.flow = FLOW;
    await this.render(bot, chatId, s);
  },

  async render(bot, chatId, s) {
    const st = (getFlowState(s, FLOW) as State) || { step: "PICK_OBJECT" };

    if (st.step === "PICK_OBJECT") {
      const objects = await fetchObjects();
      const slice = objects.slice(0, 20);

      const rows: TelegramBot.InlineKeyboardButton[][] = slice.map((o) => [
        {
          text: `${o.name} (${o.id})`,
          callback_data: `${cb.OBJ}${o.id}`,
        },
      ]);

      rows.push([{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }]);

const text =
  `${TEXTS.closeDayFlow.title}\n` +
  `${TEXTS.closeDayFlow.pickObject.choose}\n\n` +
  `${TEXTS.closeDayFlow.pickObject.showingPrefix} ${slice.length} ${TEXTS.closeDayFlow.pickObject.showingBetween} ${objects.length}.`;

      await upsertInline(bot, chatId, s, FLOW, text, kb(rows));
      return;
    }

    // VIEW
    const date = st.date || todayISO();
    const objectId = st.objectId;

    if (!objectId) {
      setFlowState(s, FLOW, { step: "PICK_OBJECT" } as State);
      await this.render(bot, chatId, s);
      return;
    }

    const foremanTgId = chatId; // якщо ти далі всюди перейдеш на q.from.id — тоді заміниш

    const row = await getDayStatusRow(date, objectId, foremanTgId);
    const status = row?.status || "ЧЕРНЕТКА";

    // мінімальна валідація (поки так): без табеля+робіт день не здаємо
    const missing: string[] = [];
if (!row?.hasTimesheet) missing.push(TEXTS.closeDayFlow.checklist.timesheet);
if (!row?.hasReports) missing.push(TEXTS.closeDayFlow.checklist.works);


const checklistText =
  `${TEXTS.closeDayFlow.view.checklistTitle}\n` +
  `${TEXTS.closeDayFlow.checklist.timesheet}: ${yn(!!row?.hasTimesheet)}\n` +
  `${TEXTS.closeDayFlow.checklist.works}: ${yn(!!row?.hasReports)}\n` +
  `${TEXTS.closeDayFlow.checklist.road}: ${yn(!!row?.hasRoad)}\n` +
  `${TEXTS.closeDayFlow.checklist.odoStart}: ${yn(!!row?.hasOdoStart)}\n` +
  `${TEXTS.closeDayFlow.checklist.odoEnd}: ${yn(!!row?.hasOdoEnd)}\n` +
  `${TEXTS.closeDayFlow.checklist.logistics}: ${yn(!!row?.hasLogistics)}\n` +
  `${TEXTS.closeDayFlow.checklist.materials}: ${yn(!!row?.hasMaterials)}\n`;

const text =
  `${TEXTS.closeDayFlow.title}\n` +
  `${TEXTS.closeDayFlow.view.date} ${date}\n` +
  `${TEXTS.closeDayFlow.view.object} ${objectId}\n` +
  `${TEXTS.closeDayFlow.view.status} ${status}\n\n` +
  `${checklistText}\n` +
  (missing.length
    ? `${TEXTS.closeDayFlow.view.notReadyTitle}\n${missing.map((x) => `• ${x}`).join("\n")}\n\n`
    : `${TEXTS.closeDayFlow.view.readyOk}\n\n`) +
  `${TEXTS.closeDayFlow.view.returnReason} ${safe(row?.returnReason)}\n` +
  `${TEXTS.closeDayFlow.view.approvedBy} ${safe(row?.approvedBy)}\n` +
  `${TEXTS.closeDayFlow.view.approvedAt} ${safe(row?.approvedAt)}\n` +
  `${TEXTS.closeDayFlow.view.updatedAt} ${safe(row?.updatedAt)}`;


    const rows: TelegramBot.InlineKeyboardButton[][] = [];
rows.push([{ text: TEXTS.closeDayFlow.buttons.refresh, callback_data: cb.REFRESH }]);

    // кнопку здачі ховаємо, якщо вже "ЗДАНО" або "ЗАТВЕРДЖЕНО"
    if (status !== "ЗДАНО" && status !== "ЗАТВЕРДЖЕНО") {
rows.push([{ text: TEXTS.closeDayFlow.buttons.submit, callback_data: cb.SUBMIT }]);
    }

rows.push([{ text: TEXTS.ui.buttons.back, callback_data: cb.PICK }]);
    rows.push([{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }]);

    await upsertInline(bot, chatId, s, FLOW, text, kb(rows));
  },

  async onCallback(bot, q, s, data) {
    if (!data.startsWith(CBP)) return false;

    const chatId = q.message?.chat?.id;
    if (typeof chatId !== "number") return true;

    const st = (getFlowState(s, FLOW) as State) || { step: "PICK_OBJECT" };

    if (data === cb.PICK) {
      setFlowState(s, FLOW, { step: "PICK_OBJECT" } as State);
      await this.render(bot, chatId, s);
      return true;
    }

    if (data.startsWith(cb.OBJ)) {
      const objectId = data.slice(cb.OBJ.length);
      const date = todayISO();

      setFlowState(s, FLOW, { step: "VIEW", objectId, date } as State);

      // одразу підтягнемо прапорці
      await refreshDayChecklist(date, objectId, chatId);

      await this.render(bot, chatId, s);
      return true;
    }

    if (data === cb.REFRESH) {
      if (!st.objectId) {
        setFlowState(s, FLOW, { step: "PICK_OBJECT" } as State);
        await this.render(bot, chatId, s);
        return true;
      }

      const date = st.date || todayISO();
      await refreshDayChecklist(date, st.objectId, chatId);

      await this.render(bot, chatId, s);
      return true;
    }

    if (data === cb.SUBMIT) {
      if (!st.objectId) {
        setFlowState(s, FLOW, { step: "PICK_OBJECT" } as State);
        await this.render(bot, chatId, s);
        return true;
      }

      const date = st.date || todayISO();

      // 1) оновимо прапорці
      await refreshDayChecklist(date, st.objectId, chatId);

      // 2) перечитаємо і мінімально провалідимо
      const row = await getDayStatusRow(date, st.objectId, chatId);

      const missing: string[] = [];
if (!row?.hasTimesheet) missing.push(TEXTS.closeDayFlow.checklist.timesheet);
if (!row?.hasReports) missing.push(TEXTS.closeDayFlow.checklist.works);


      if (missing.length) {
        await upsertInline(
          bot,
          chatId,
          s,
          FLOW,
          `${TEXTS.closeDayFlow.errors.cannotSubmitTitle}\n\n${missing.map((x) => `• ${x}`).join("\n")}\n\n${TEXTS.closeDayFlow.errors.cannotSubmitHint}`,
          kb([
[{ text: TEXTS.closeDayFlow.buttons.refresh, callback_data: cb.REFRESH }],
[{ text: TEXTS.ui.buttons.back, callback_data: cb.PICK }],
            [{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }],
          ])
        );
        return true;
      }

      // 3) ставимо статус "ЗДАНО"
      await setDayStatus({
        date,
        objectId: st.objectId,
        foremanTgId: chatId,
        status: "ЗДАНО",
      });

      await this.render(bot, chatId, s);
      return true;
    }

    // fallback
    await this.render(bot, chatId, s);
    return true;
  },
};
