// src/bot/flows/addWork.flow.ts
import type TelegramBot from "node-telegram-bot-api";
import type { FlowModule } from "../core/flowTypes.js";
import { getFlowState, setFlowState, clearFlowState, upsertInline, todayISO } from "../core/helpers.js";
import { TEXTS } from "../texts.js";
import { CB } from "../core/cb.js";
import { getDayStatusRow } from "../../google/sheets/checklist.js";

import {
  fetchObjects,
  fetchWorks,
  appendReports,
  refreshDayChecklist,
  fetchMissingReports, // (date, objectId, foremanTgId) -> ReportRow[]
  updateReportQty,     // (key, patch) -> void
} from "../../google/sheets/index.js";

import type { ObjectRow, WorkRow } from "../../google/sheets/types.js";
import { uploadPhotoFromBuffer } from "../../google/drive.js";

const FLOW = "ADD_WORK" as const;
const PREFIX = "aw:";

const cb = {
  BACK_MENU: `${PREFIX}back_menu`,

  PICK_CATEGORY: `${PREFIX}pick_cat`,
  SET_CATEGORY: `${PREFIX}set_cat:`,      // + id ("c0", "c1", ...) або "none"
  CLEAR_CATEGORY: `${PREFIX}clear_cat`,   // all categories

  PICK_DATE: `${PREFIX}pick_date`,
  SET_DATE: `${PREFIX}set_date:`,        // + YYYY-MM-DD
  DATE_TODAY: `${PREFIX}date_today`,

  PICK_OBJECT: `${PREFIX}pick_object`,
  SET_OBJECT: `${PREFIX}set_object:`,    // + objectId

  PICK_WORKS: `${PREFIX}pick_works`,
  TOGGLE_WORK: `${PREFIX}w:`,            // + workId
  WORKS_DONE: `${PREFIX}works_done`,

  EDIT_VOLUME: `${PREFIX}edit_volume:`,  // + workId
  VOL_SET_EMPTY: `${PREFIX}vol_empty`,   // for currently editing
  VOL_SET_Q: `${PREFIX}vol_q`,
  VOL_MINUS_1: `${PREFIX}vol_m1`,
  VOL_PLUS_1: `${PREFIX}vol_p1`,
  VOL_MINUS_Q: `${PREFIX}vol_mq`,
  VOL_PLUS_Q: `${PREFIX}vol_pq`,
  VOL_SET_NUM: `${PREFIX}vol_num:`,      // + number
  VOL_DONE: `${PREFIX}vol_done`,

  PHOTOS: `${PREFIX}photos`,
  PHOTOS_DONE: `${PREFIX}photos_done`,
  PHOTO_DELETE: `${PREFIX}photo_del:`,   // + idx

  REVIEW: `${PREFIX}review`,
  SAVE: `${PREFIX}save`,
  RESET: `${PREFIX}reset`,
  FILL_QTY: `${PREFIX}fill_qty`,
  FILL_EDIT: `${PREFIX}fill_edit:`,      // + reportKey
  FILL_DONE: `${PREFIX}fill_done`,
} as const;

type VolumeValue = number | "?" | ""; // "" = empty
type WorkPick = { workId: string; workName: string; volume: VolumeValue };

type Step =
  | "MAIN"
  | "PICK_DATE"
  | "PICK_OBJECT"
  | "PICK_WORKS"
  | "EDIT_VOLUME"
  | "PHOTOS"
  | "REVIEW"
  | "PICK_CATEGORY"
  | "FILL_QTY";

import type { FlowBaseState } from "../core/flowTypes.js";

type State = FlowBaseState & {
  step: Step;
  date: string;
  foremanTgId: number;

  editingReportKey?: string;
  workCategory?: string;

  objectId?: string;
  objectName?: string;
  categories?: string[];

  works: WorkPick[];
  editingWorkId?: string;

  photoUrls: string[]; // drive links
};

function reportKey(date: string, objectId: string, foremanTgId: number, workId: string) {
  return `${date}||${objectId}||${foremanTgId}||${workId}`;
}
function parseReportKey(key: string) {
  const [date, objectId, foremanStr, workId] = key.split("||");
  return { date, objectId, foremanTgId: Number(foremanStr), workId };
}

function isLocked(status?: string) {
  const s = String(status || "").toUpperCase();
  return s === "ЗДАНО" || s === "ЗАТВЕРДЖЕНО";
}

function kb(rows: TelegramBot.InlineKeyboardButton[][]): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: rows };
}
function btn(text: string, data: string): TelegramBot.InlineKeyboardButton {
  return { text, callback_data: data };
}
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function ensureState(s: any, foremanTgId: number): State {
  const st = getFlowState<State>(s, FLOW);
  if (st) return st;

  const init: State = {
    step: "MAIN",
    date: todayISO(),
    foremanTgId,
    works: [],
    photoUrls: [],
  };
  setFlowState(s, FLOW, init);
  return init;
}

function workLine(w: WorkPick) {
  const U = TEXTS.ui;
  const v =
    w.volume === "" ? U.symbols.emptyDash :
    w.volume === "?" ? U.symbols.unknown :
    String(w.volume);

  return `• ${w.workName}\n  📏 ${v}`;
}

function volumeStatus(v: VolumeValue): "FILLED" | "MISSING" {
  if (v === "" || v === "?") return "MISSING";
  return Number.isFinite(v) && v > 0 ? "FILLED" : "MISSING";
}

async function render(bot: TelegramBot, chatId: number, s: any) {
  const st = getFlowState<State>(s, FLOW);
  if (!st) return;

  const T = TEXTS.addWorkFlow;
  const U = TEXTS.ui;

  const worksCount = st.works.length;
  const missingCount = st.works.filter((w) => volumeStatus(w.volume) === "MISSING").length;

  const header =
    `${T.title}\n` +
    `${T.header.date} ${st.date}\n` +
    `${T.header.object} ${st.objectId ? (st.objectName ?? st.objectId) : U.symbols.emptyDash}\n` +
    `${T.header.worksInPack} ${worksCount}\n` +
    `${T.header.missingVolume} ${missingCount}\n` +
    `${T.header.photos} ${st.photoUrls.length}\n`;

  if (st.step === "MAIN") {
    const canReview = Boolean(st.objectId && st.works.length);

    await upsertInline(
      bot,
      chatId,
      s,
      FLOW,
      header +
        `\n${T.main.actionsTitle}\n` +
        `${T.main.bullets.join("\n")}\n`,
      kb([
        [btn(T.buttons.date, cb.PICK_DATE), btn(T.buttons.object, cb.PICK_OBJECT)],
        [btn(T.buttons.worksPack, cb.PICK_CATEGORY)],
        [btn(T.buttons.photosPack, cb.PHOTOS)],
        [btn(canReview ? T.buttons.review : T.buttons.reviewBlocked, cb.REVIEW)],
        [btn(T.buttons.savePack, cb.SAVE)],
        [btn(U.buttons.reset, cb.RESET), btn(U.buttons.menu, cb.BACK_MENU)],
      ])
    );
    return;
  }

  if (st.step === "PICK_DATE") {
    await upsertInline(
      bot,
      chatId,
      s,
      FLOW,
      `${T.pickDate.title}\n\n${U.labels.current} ${st.date}`,
      kb([
        [btn(U.buttons.today, cb.DATE_TODAY)],
        [btn(U.buttons.back, `${PREFIX}main`)],
      ])
    );
    return;
  }

  if (st.step === "FILL_QTY") {
    if (!st.objectId) {
      setFlowState(s, FLOW, { ...st, step: "PICK_OBJECT" });
      await render(bot, chatId, s);
      return;
    }

    const missingReports = await fetchMissingReports({
      date: st.date,
      objectId: st.objectId,
      foremanTgId: st.foremanTgId,
    });

    if (!missingReports.length) {
      await upsertInline(
        bot,
        chatId,
        s,
        FLOW,
        `${T.fillQty.allFilled}\n\n📅 ${st.date}\n🏗 ${st.objectName ?? st.objectId}`,
        kb([[btn(U.buttons.back, `${PREFIX}main`)]])
      );
      return;
    }

    const rows = missingReports.slice(0, 20).map((r: any) => {
      const key = reportKey(r.date, r.objectId, r.foremanTgId, r.workId);
      const v = String(r.volume ?? "").trim() || U.symbols.emptyDash;
      return [btn(`✏️ ${r.workName}  (📏 ${v})`, `${cb.FILL_EDIT}${key}`)];
    });

    await upsertInline(
      bot,
      chatId,
      s,
      FLOW,
      `${T.fillQty.title}\n\n` +
        `📅 ${st.date}\n🏗 ${st.objectName ?? st.objectId}\n\n` +
        `${U.labels.missing} ${missingReports.length}\n\n` +
        `${T.fillQty.hint}`,
      kb([
        ...rows,
        [btn(U.buttons.done, cb.FILL_DONE)],
        [btn(U.buttons.back, `${PREFIX}main`)],
      ])
    );
    return;
  }

  if (st.step === "PICK_OBJECT") {
    const objects = await fetchObjects();
    const rows = objects
      .filter((o: any) => String(o.active ?? "").toLowerCase() !== "ні")
      .map((o: ObjectRow) => btn(`🏗 ${o.name}`, `${cb.SET_OBJECT}${o.id}`));

    const page = chunk(rows, 2).slice(0, 15);

    await upsertInline(
      bot,
      chatId,
      s,
      FLOW,
      T.pickObject.title,
      kb([
        ...page,
        [btn(U.buttons.back, `${PREFIX}main`)],
      ])
    );
    return;
  }

  if (st.step === "PICK_CATEGORY") {
    const works = await fetchWorks();
    const activeWorks = works.filter((w: any) => String(w.active ?? "").toLowerCase() !== "ні");

    const cats = Array.from(
      new Set(
        activeWorks
          .map((w: any) => String(w.category ?? "").trim())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b, "uk"));

    const rows: TelegramBot.InlineKeyboardButton[][] = [];

    rows.push([btn(st.workCategory ? T.pickCategory.allBtnOff : T.pickCategory.allBtnOn, cb.CLEAR_CATEGORY)]);
    rows.push([btn(T.pickCategory.noCatBtn, cb.SET_CATEGORY + "none")]);

    const cleanText = (ss: string) =>
      String(ss ?? "")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const categories = cats.slice(0, 40).map(cleanText);

    setFlowState(s, FLOW, { ...st, categories });

    for (let i = 0; i < categories.length; i++) {
      const c = categories[i];
      const on = st.workCategory === c;
      rows.push([btn(`${on ? "✅" : "▫️"} ${c}`, cb.SET_CATEGORY + `c${i}`)]);
    }

    rows.push([btn(U.buttons.back, `${PREFIX}main`)]);

    const assertKb = (m: TelegramBot.InlineKeyboardMarkup) => {
      for (const row of m.inline_keyboard) {
        for (const b of row) {
          if (!b.callback_data) continue;
          if (/[\r\n]/.test(b.callback_data)) {
            throw new Error("NEWLINE_IN_CALLBACK: " + JSON.stringify(b.callback_data));
          }
          if (b.callback_data.length > 64) {
            throw new Error("CALLBACK_TOO_LONG: " + b.callback_data.length);
          }
        }
      }
    };

    const markup = kb(rows);
    assertKb(markup);

    await upsertInline(
      bot,
      chatId,
      s,
      FLOW,
      `${T.pickCategory.title}\n\n` +
        `${U.labels.current} ${st.workCategory ?? T.pickCategory.all}\n` +
        `${T.pickCategory.next}`,
      markup
    );
    return;
  }

  if (st.step === "PICK_WORKS") {
    const works = await fetchWorks();
    const picked = new Set(st.works.map((w) => w.workId));

    const activeWorks = works.filter((w: any) => String(w.active ?? "").toLowerCase() !== "ні");

    const filtered = st.workCategory
      ? (st.workCategory === "__NO_CAT__"
        ? activeWorks.filter((w: any) => !String(w.category ?? "").trim())
        : activeWorks.filter((w: any) => String(w.category ?? "").trim() === st.workCategory))
      : activeWorks;

    const rows = filtered
      .slice(0, 30)
      .map((w: WorkRow) => {
        const on = picked.has(String(w.id));
        return [btn(`${on ? "✅" : "▫️"} ${w.name}`, `${cb.TOGGLE_WORK}${w.id}`)];
      });

    await upsertInline(
      bot,
      chatId,
      s,
      FLOW,
      `${T.pickWorks.title}\n\n` +
        `${U.labels.category} ${st.workCategory ? (st.workCategory === "__NO_CAT__" ? T.pickWorks.noCat : st.workCategory) : T.pickWorks.all}\n` +
        `${U.labels.picked} ${picked.size}\n\n` +
        `${T.pickWorks.hint}`,
      kb([
        [btn(T.buttons.changeCategory, cb.PICK_CATEGORY)],
        ...rows,
        [btn(U.buttons.done, cb.WORKS_DONE)],
        [btn(U.buttons.back, `${PREFIX}main`)],
      ])
    );
    return;
  }

  if (st.step === "EDIT_VOLUME") {
    const wid = st.editingWorkId;
    const w = st.works.find((x) => x.workId === wid);
    if (!wid || !w) {
      setFlowState(s, FLOW, { ...st, step: "REVIEW", editingWorkId: undefined });
      await render(bot, chatId, s);
      return;
    }

    const cur =
      w.volume === "" ? U.symbols.emptyDash :
      w.volume === "?" ? U.symbols.unknown :
      String(w.volume);

    await upsertInline(
      bot,
      chatId,
      s,
      FLOW,
      `${T.editVolume.title}\n${w.workName}\n\n` +
        `${T.editVolume.current} ${cur}\n\n` +
        `${T.editVolume.hint}`,
      kb([
        [btn(U.buttons.volumeEmpty, cb.VOL_SET_EMPTY), btn(U.symbols.unknown, cb.VOL_SET_Q)],
        [btn("−1", cb.VOL_MINUS_1), btn("−0.25", cb.VOL_MINUS_Q), btn("+0.25", cb.VOL_PLUS_Q), btn("+1", cb.VOL_PLUS_1)],
        [btn("1", `${cb.VOL_SET_NUM}1`), btn("5", `${cb.VOL_SET_NUM}5`), btn("10", `${cb.VOL_SET_NUM}10`)],
        [btn(U.buttons.done, cb.VOL_DONE)],
        [btn(U.buttons.back, st.editingReportKey ? cb.FILL_QTY : cb.REVIEW)],
      ])
    );
    return;
  }

  if (st.step === "PHOTOS") {
    const lines =
      st.photoUrls.length
        ? st.photoUrls.map((u, i) => `${i + 1}) ${u}`).join("\n")
        : U.symbols.emptyDash;

    await upsertInline(
      bot,
      chatId,
      s,
      FLOW,
      `${T.photos.title}\n\n${T.photos.sendHint}\n` +
        `${T.photos.current} (${st.photoUrls.length}):\n${lines}\n\n` +
        `${T.photos.after}`,
      kb([
        ...(st.photoUrls.length
          ? st.photoUrls.slice(0, 10).map((_, i) => [btn(`${T.photos.deletePrefix}${i + 1}`, `${cb.PHOTO_DELETE}${i}`)])
          : []),
        [btn(U.buttons.done, cb.PHOTOS_DONE)],
        [btn(U.buttons.back, `${PREFIX}main`)],
      ])
    );
    return;
  }

  if (st.step === "REVIEW") {
    const worksText = st.works.length ? st.works.map(workLine).join("\n\n") : U.symbols.emptyDash;

    await upsertInline(
      bot,
      chatId,
      s,
      FLOW,
      `${T.review.title}\n\n` +
        `📅 ${st.date}\n` +
        `🏗 ${st.objectName ?? st.objectId ?? U.symbols.emptyDash}\n` +
        `📷 ${U.labels.photos} ${st.photoUrls.length}\n\n` +
        `${U.labels.works}\n${worksText}\n\n` +
        `${T.review.hint}`,
      kb([
        ...(st.works.slice(0, 15).map((w2) => [
          btn(`${T.review.editPrefix} ${w2.workName}`, `${cb.EDIT_VOLUME}${w2.workId}`)
        ])),
        [btn(T.buttons.savePack, cb.SAVE)],
        [btn(U.buttons.back, `${PREFIX}main`)],
      ])
    );
    return;
  }
}

export const AddWorkFlow: FlowModule = {
  flow: FLOW,
  menuText: TEXTS.buttons.addWork,
  cbPrefix: PREFIX,

  async start(bot: TelegramBot, chatId: number, s: any) {
    const foremanTgId = (s as any).actorTgId ?? (s as any).userTgId ?? chatId;
    const st = ensureState(s, foremanTgId);
    setFlowState(s, FLOW, { ...st, step: "MAIN", foremanTgId });
    await render(bot, chatId, s);
  },

  async render(bot: TelegramBot, chatId: number, s: any) {
    await render(bot, chatId, s);
  },

  async onCallback(bot: TelegramBot, q: TelegramBot.CallbackQuery, s: any, data: string) {
    const chatId = q.message?.chat.id;
    if (!chatId) return false;

    const T = TEXTS.addWorkFlow;
    const U = TEXTS.ui;

    const foremanTgId = q.from.id;
    const st = ensureState(s, foremanTgId);

    if (data === `${PREFIX}main`) {
      setFlowState(s, FLOW, { ...st, step: "MAIN", foremanTgId });
      await render(bot, chatId, s);
      return true;
    }

    if (data === cb.PICK_CATEGORY) {
      if (!st.objectId) {
        setFlowState(s, FLOW, { ...st, foremanTgId, step: "PICK_OBJECT" });
        await render(bot, chatId, s);
        return true;
      }
      setFlowState(s, FLOW, { ...st, foremanTgId, step: "PICK_CATEGORY" });
      await render(bot, chatId, s);
      return true;
    }

    if (data === cb.CLEAR_CATEGORY) {
      setFlowState(s, FLOW, { ...st, foremanTgId, workCategory: undefined, step: "PICK_WORKS" });
      await render(bot, chatId, s);
      return true;
    }

    if (data.startsWith(cb.SET_CATEGORY)) {
      const id = data.slice(cb.SET_CATEGORY.length);
      let cat: string | undefined;

      if (id === "none") cat = "__NO_CAT__";
      else if (id.startsWith("c")) {
        const idx = Number(id.slice(1));
        cat = st.categories?.[idx];
      }

      if (!cat) {
        await upsertInline(bot, chatId, s, FLOW, T.pickCategory.notFound);
        return true;
      }

      setFlowState(s, FLOW, { ...st, foremanTgId, workCategory: cat, step: "PICK_WORKS" });
      await render(bot, chatId, s);
      return true;
    }

    if (data === cb.BACK_MENU) {
      clearFlowState(s, FLOW);
      await upsertInline(bot, chatId, s, FLOW, U.errors.backMenu);
      return true;
    }

    if (data.startsWith(cb.FILL_EDIT)) {
      const key = data.slice(cb.FILL_EDIT.length);
      const p = parseReportKey(key);

      const worksDict = await fetchWorks();
      const ww = worksDict.find((x: any) => String(x.id) === String(p.workId));

      const exists = st.works.some((x) => x.workId === p.workId);
      const nextWorks = exists
        ? st.works
        : [...st.works, { workId: p.workId, workName: ww?.name ?? p.workId, volume: "" }];

      setFlowState(s, FLOW, {
        ...st,
        foremanTgId,
        works: nextWorks,
        step: "EDIT_VOLUME",
        editingWorkId: p.workId,
        editingReportKey: key,
      });

      await render(bot, chatId, s);
      return true;
    }

    if (data === cb.RESET) {
      setFlowState(s, FLOW, {
        step: "MAIN",
        messageId: st.messageId,
        date: todayISO(),
        foremanTgId,
        works: [],
        photoUrls: [],
      } as State);

      await render(bot, chatId, s);
      return true;
    }

    // date
    if (data === cb.PICK_DATE) {
      setFlowState(s, FLOW, { ...st, foremanTgId, step: "PICK_DATE" });
      await render(bot, chatId, s);
      return true;
    }
    if (data === cb.DATE_TODAY) {
      setFlowState(s, FLOW, { ...st, foremanTgId, date: todayISO(), step: "MAIN" });
      await render(bot, chatId, s);
      return true;
    }

    // object
    if (data === cb.PICK_OBJECT) {
      setFlowState(s, FLOW, { ...st, foremanTgId, step: "PICK_OBJECT" });
      await render(bot, chatId, s);
      return true;
    }
    if (data.startsWith(cb.SET_OBJECT)) {
      const objectId = data.slice(cb.SET_OBJECT.length);
      const objects = await fetchObjects();
      const o = objects.find((x: any) => String(x.id) === String(objectId));

      setFlowState(s, FLOW, {
        ...st,
        foremanTgId,
        step: "MAIN",
        objectId,
        objectName: o?.name ?? objectId,
      });
      await render(bot, chatId, s);
      return true;
    }

    // works package
    if (data === cb.PICK_WORKS) {
      if (!st.objectId) {
        setFlowState(s, FLOW, { ...st, foremanTgId, step: "PICK_CATEGORY" });
        await render(bot, chatId, s);
        return true;
      }
      setFlowState(s, FLOW, { ...st, foremanTgId, step: "PICK_WORKS" });
      await render(bot, chatId, s);
      return true;
    }

    // ✅ TOGGLE WORK (мультивибір робіт)
    if (data.startsWith(cb.TOGGLE_WORK)) {
      const workId = data.slice(cb.TOGGLE_WORK.length);

      const worksDict = await fetchWorks();
      const w = worksDict.find((x: any) => String(x.id) === String(workId));
      if (!w) return true;

      const exists = st.works.some((x) => x.workId === workId);

      const nextWorks = exists
        ? st.works.filter((x) => x.workId !== workId)
        : [...st.works, { workId, workName: w.name, volume: "" }];

      setFlowState(s, FLOW, { ...st, foremanTgId, works: nextWorks, step: "PICK_WORKS" });
      await render(bot, chatId, s);
      return true;
    }

    if (data === cb.WORKS_DONE) {
      setFlowState(s, FLOW, { ...st, foremanTgId, step: "REVIEW" });
      await render(bot, chatId, s);
      return true;
    }

    // edit volume
    if (data.startsWith(cb.EDIT_VOLUME)) {
      const wid = data.slice(cb.EDIT_VOLUME.length);
      setFlowState(s, FLOW, { ...st, foremanTgId, step: "EDIT_VOLUME", editingWorkId: wid });
      await render(bot, chatId, s);
      return true;
    }

    const patchEditingVolume = (next: VolumeValue) => {
      const wid = st.editingWorkId;
      if (!wid) return st.works;
      return st.works.map((w) => (w.workId === wid ? { ...w, volume: next } : w));
    };

    if (data === cb.VOL_SET_EMPTY) {
      setFlowState(s, FLOW, { ...st, foremanTgId, works: patchEditingVolume(""), step: "EDIT_VOLUME" });
      await render(bot, chatId, s);
      return true;
    }
    if (data === cb.VOL_SET_Q) {
      setFlowState(s, FLOW, { ...st, foremanTgId, works: patchEditingVolume("?"), step: "EDIT_VOLUME" });
      await render(bot, chatId, s);
      return true;
    }

    const readCurNum = (): number => {
      const wid = st.editingWorkId;
      const w = st.works.find((x) => x.workId === wid);
      const v = w?.volume;
      return typeof v === "number" && Number.isFinite(v) ? v : 0;
    };

    if (data === cb.VOL_MINUS_1) {
      const n = Math.max(0, +(readCurNum() - 1).toFixed(2));
      setFlowState(s, FLOW, { ...st, foremanTgId, works: patchEditingVolume(n), step: "EDIT_VOLUME" });
      await render(bot, chatId, s);
      return true;
    }
    if (data === cb.VOL_PLUS_1) {
      const n = +(readCurNum() + 1).toFixed(2);
      setFlowState(s, FLOW, { ...st, foremanTgId, works: patchEditingVolume(n), step: "EDIT_VOLUME" });
      await render(bot, chatId, s);
      return true;
    }
    if (data === cb.VOL_MINUS_Q) {
      const n = Math.max(0, +(readCurNum() - 0.25).toFixed(2));
      setFlowState(s, FLOW, { ...st, foremanTgId, works: patchEditingVolume(n), step: "EDIT_VOLUME" });
      await render(bot, chatId, s);
      return true;
    }
    if (data === cb.VOL_PLUS_Q) {
      const n = +(readCurNum() + 0.25).toFixed(2);
      setFlowState(s, FLOW, { ...st, foremanTgId, works: patchEditingVolume(n), step: "EDIT_VOLUME" });
      await render(bot, chatId, s);
      return true;
    }
    if (data.startsWith(cb.VOL_SET_NUM)) {
      const n = Number(data.slice(cb.VOL_SET_NUM.length));
      setFlowState(
        s,
        FLOW,
        { ...st, foremanTgId, works: patchEditingVolume(Number.isFinite(n) ? n : readCurNum()), step: "EDIT_VOLUME" }
      );
      await render(bot, chatId, s);
      return true;
    }

    if (data === cb.VOL_DONE) {
      if (st.editingReportKey) {
        const wid = st.editingWorkId!;
        const w = st.works.find((x) => x.workId === wid);
        const v: VolumeValue = w?.volume ?? "";

        await updateReportQty({
          key: st.editingReportKey,
          volume: typeof v === "number" ? v : "",
          volumeStatus: volumeStatus(v) === "FILLED" ? "ЗАПОВНЕНО" : "НЕ_ЗАПОВНЕНО",
        });

        await refreshDayChecklist(st.date, st.objectId!, st.foremanTgId);

        setFlowState(s, FLOW, {
          ...st,
          foremanTgId,
          step: "FILL_QTY",
          editingWorkId: undefined,
          editingReportKey: undefined,
        });

        await render(bot, chatId, s);
        return true;
      }

      setFlowState(s, FLOW, { ...st, foremanTgId, step: "REVIEW", editingWorkId: undefined });
      await render(bot, chatId, s);
      return true;
    }

    if (data === cb.FILL_DONE) {
      setFlowState(s, FLOW, { ...st, foremanTgId, step: "MAIN" });
      await render(bot, chatId, s);
      return true;
    }

    if (data === cb.FILL_QTY) {
      if (!st.objectId) setFlowState(s, FLOW, { ...st, foremanTgId, step: "PICK_OBJECT" });
      else setFlowState(s, FLOW, { ...st, foremanTgId, step: "FILL_QTY" });

      await render(bot, chatId, s);
      return true;
    }

    // photos
    if (data === cb.PHOTOS) {
      if (!st.objectId) {
        setFlowState(s, FLOW, { ...st, foremanTgId, step: "PICK_OBJECT" });
        await render(bot, chatId, s);
        return true;
      }
      setFlowState(s, FLOW, { ...st, foremanTgId, step: "PHOTOS" });
      await render(bot, chatId, s);
      return true;
    }
    if (data.startsWith(cb.PHOTO_DELETE)) {
      const idx = Number(data.slice(cb.PHOTO_DELETE.length));
      const next = st.photoUrls.filter((_, i) => i !== idx);
      setFlowState(s, FLOW, { ...st, foremanTgId, photoUrls: next, step: "PHOTOS" });
      await render(bot, chatId, s);
      return true;
    }
    if (data === cb.PHOTOS_DONE) {
      setFlowState(s, FLOW, { ...st, foremanTgId, step: "REVIEW" });
      await render(bot, chatId, s);
      return true;
    }

    // review
    if (data === cb.REVIEW) {
      setFlowState(s, FLOW, { ...st, foremanTgId, step: "REVIEW" });
      await render(bot, chatId, s);
      return true;
    }

    // save пакет
    if (data === cb.SAVE) {
      if (!st.objectId) {
        await upsertInline(
          bot,
          chatId,
          s,
          FLOW,
          T.errors.needObject,
          kb([
            [btn(T.buttons.object, cb.PICK_OBJECT)],
            [btn(U.buttons.back, `${PREFIX}main`)],
          ])
        );
        return true;
      }

      if (!st.works.length) {
        await upsertInline(
          bot,
          chatId,
          s,
          FLOW,
          T.errors.needWork,
          kb([
            [btn(T.buttons.worksPack, cb.PICK_WORKS)],
            [btn(U.buttons.back, `${PREFIX}main`)],
          ])
        );
        return true;
      }

      const photosJson = JSON.stringify(st.photoUrls);

      const ds = await getDayStatusRow(st.date, st.objectId!, foremanTgId);
      if (isLocked(ds?.status)) {
        await bot.sendMessage(
          chatId,
          `${T.locked.prefix} ${ds?.status} (обʼєкт ${st.objectId}). ${T.locked.tail}`
        );
        return true;
      }

      await appendReports(
        st.works.map((w) => ({
          date: st.date,
          objectId: st.objectId!,
          foremanTgId,
          workId: w.workId,
          workName: w.workName,
          volume: typeof w.volume === "number" ? w.volume : "",
          volumeStatus: volumeStatus(w.volume) === "FILLED" ? "ЗАПОВНЕНО" : "НЕ_ЗАПОВНЕНО",
          photos: photosJson,
          dayStatus: "ЧЕРНЕТКА",
        }))
      );

      await refreshDayChecklist(st.date, st.objectId!, foremanTgId);

      const missing = st.works.filter((w) => volumeStatus(w.volume) === "MISSING").length;

      setFlowState(s, FLOW, {
        ...st,
        foremanTgId,
        step: "MAIN",
        works: [],
        photoUrls: [],
        editingWorkId: undefined,
      });

      await upsertInline(
        bot,
        chatId,
        s,
        FLOW,
        `${T.saved.ok}\n\n` +
          `🏗 ${st.objectName ?? st.objectId}\n` +
          `${T.saved.works} ${st.works.length}\n` +
          `${T.saved.photos} ${JSON.parse(photosJson).length}\n` +
          (missing ? `\n${T.saved.missingWarnTitle} ${missing}\n${T.saved.missingWarnTail}` : ``),
        kb([
          ...(missing ? [[btn(T.buttons.fillQty, cb.FILL_QTY)]] : []),
          [btn(T.buttons.addMorePack, `${PREFIX}main`)],
          [btn(TEXTS.common.backToMenu, CB.MENU)],
        ])
      );

      return true;
    }

    return false;
  },

  async onMessage(bot: TelegramBot, msg: TelegramBot.Message, s: any) {
    const st = getFlowState<State>(s, FLOW);
    if (!st) return false;

    if (st.step !== "PHOTOS") return false;

    const chatId = msg.chat.id;
    const foremanTgId = msg.from?.id;
    if (!foremanTgId) return true;

    const photos = msg.photo;
    if (!photos || photos.length === 0) return false;

    const best = photos.at(-1);
    if (!best) return false;

    const fileId = best.file_id;

    const fileLink = await bot.getFileLink(fileId);
    const res = await fetch(fileLink);
    const buf = Buffer.from(await res.arrayBuffer());

    const filename = `work_${st.date}_${st.objectId ?? "noobj"}_${msg.message_id}.jpg`;
    const url = await uploadPhotoFromBuffer(filename, buf);

    setFlowState(s, FLOW, {
      ...st,
      foremanTgId,
      photoUrls: [...st.photoUrls, url],
      step: "PHOTOS",
    });

    await render(bot, chatId, s);
    return true;
  },
};
