// src/bot/flows/road.flow.ts
import type TelegramBot from "node-telegram-bot-api";
import { TEXTS } from "../texts.js";
import type { FlowModule, FlowBaseState } from "../core/flowTypes.js";
import { CB } from "../core/cb.js";
import { getFlowState, setFlowState } from "../core/helpers.js";
import { renderFlow } from "../core/renderFlow.js";
import { upsertAllowanceRows } from "../../google/sheets/working.js";
import { classifyTripByKm } from "../../google/sheets/utils.js";
import { getSettingNumber } from "../../google/sheets/dictionaries.js";
import { fetchCars, fetchEmployees, upsertOdometerDay, appendEvents } from "../../google/sheets/index.js";

/**
 * STEPS (твій сценарій) — UI кроки.
 * ВАЖЛИВО: тепер стан дороги зберігається ПЕР-АВТО, а UI показує активне авто.
 */
type RoadStep =
  | "START"
  | "PICK_CAR"
  | "ODO_START"
  | "PICK_PEOPLE_DAY"
  | "PICK_OBJECTS_COUNT"
  | "RUN_DAY"
  | "AFTER_STOP_DAY"
  | "RETURN_MENU"
  | "PICK_PEOPLE_RETURN"
  | "RUN_RETURN"
  | "ODO_END"
  | "MANAGE_PEOPLE"
  | "SAVE";

type RoadPhase = "SETUP" | "DAY" | "WAIT_RETURN" | "RETURN" | "FINISHED";

type RoadMember = {
  employeeId: string;
  joinedAt: string; // ISO
  leftAt?: string; // ISO
};

type CarRoad = {
  phase: RoadPhase;
  roadActive?: boolean;

  // ODO
  odoStartKm?: number;
  odoEndKm?: number;
  odoStartPhotoFileId?: string;
  odoEndPhotoFileId?: string;

  // setup
  dayPeopleIds: string[];
  returnPeopleIds: string[];
  objectsCount?: number;

  // runtime
  inCarIds: string[];
  members: RoadMember[];

  dayStartedAt?: string;
  dayEndedAt?: string;
  returnStartedAt?: string;
  returnEndedAt?: string;

  // internal: odo substep
  odoStartNeedPhoto?: boolean;
  odoEndNeedPhoto?: boolean;
};

type RoadState = FlowBaseState & {
  step: RoadStep;

  employees?: { id: string; name: string }[];
  carsMeta?: { id: string; name: string }[];

  uiMsgId?: number;
  // активне авто в UI
  activeCarId?: string;

  // стан по кожному авто
  cars: Record<string, CarRoad>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _legacy?: any;
};

const FLOW = "ROAD" as const;
const PREFIX = "rd:";

const cb = {
  MENU: `${PREFIX}menu`,
  BACK: `${PREFIX}back:`,

  RESET: `${PREFIX}reset`,
  RESET_YES: `${PREFIX}reset_yes`,
  RESET_NO: `${PREFIX}reset_no`,

  STATS: `${PREFIX}stats`,

  PICK_CAR: `${PREFIX}pick_car`,
  CAR: `${PREFIX}car:`,
  CAR_BUSY: `${PREFIX}car_busy:`,
  DONE: `${PREFIX}done`,

  ODO_START: `${PREFIX}odo_start`,
  ASK_ODO_START_KM: `${PREFIX}ask_odo_start_km`,
  ASK_ODO_START_PHOTO: `${PREFIX}ask_odo_start_photo`,
  SKIP_ODO_START_PHOTO: `${PREFIX}skip_odo_start_photo`,

  PICK_PEOPLE_DAY: `${PREFIX}pick_people_day`,
  EMP_DAY: `${PREFIX}emp_day:`,

  PICK_OBJECTS: `${PREFIX}pick_objects`,
  OBJ_MINUS: `${PREFIX}obj_m`,
  OBJ_PLUS: `${PREFIX}obj_p`,
  OBJ_SET: `${PREFIX}obj_set:`,
  OBJECTS_DONE: `${PREFIX}objects_done`,

  START_DAY: `${PREFIX}start_day`,
  STOP_DAY: `${PREFIX}stop_day`,

  GO_RETURN_MENU: `${PREFIX}go_return_menu`,

  RETURN_MENU: `${PREFIX}return_menu`,
  PICK_PEOPLE_RETURN: `${PREFIX}pick_people_return`,
  EMP_RETURN: `${PREFIX}emp_return:`,
  START_RETURN: `${PREFIX}start_return`,
  STOP_RETURN: `${PREFIX}stop_return`,

  ODO_END: `${PREFIX}odo_end`,
  ASK_ODO_END_KM: `${PREFIX}ask_odo_end_km`,
  ASK_ODO_END_PHOTO: `${PREFIX}ask_odo_end_photo`,
  SKIP_ODO_END_PHOTO: `${PREFIX}skip_odo_end_photo`,

  MANAGE_PEOPLE: `${PREFIX}manage_people`,
  ROAD_TOGGLE_EMP: `${PREFIX}road_toggle_emp:`,
  MANAGE_OBJECTS: `${PREFIX}manage_objects`,

  SAVE_SCREEN: `${PREFIX}save_screen`,
  SAVE: `${PREFIX}save`,
} as const;

const DEFAULT_ROAD_ALLOWANCE_BY_CLASS: Record<"S" | "M" | "L" | "XL", number> = {
  S: 50,
  M: 100,
  L: 150,
  XL: 200,
};

// -------------------- INPUT WITHOUT REPLY --------------------
type PendingInput = {
  chatId: number;
  fromId: number;
  createdAt: number;
  timer: NodeJS.Timeout;
  listener: (msg: TelegramBot.Message) => Promise<void>;
};
const pendingInputs = new Map<string, PendingInput>(); // key = `${chatId}:${fromId}`

function carName(rd: RoadState, id?: string) {
  if (!id) return TEXTS.ui.symbols.emptyDash;
  return rd.carsMeta?.find((c) => c.id === id)?.name ?? id;
}

async function ensureCarsMeta(rd: RoadState) {
  if (rd.carsMeta?.length) return;

  const cars = await fetchCars();
  rd.carsMeta = (cars ?? []).slice(0, 60).map((c: any) => ({
    id: String(c.id ?? c.ID ?? c.carId ?? c["ID"] ?? "").trim(),
    name: String(c.name ?? c.NAME ?? c.title ?? c["НАЗВА"] ?? c["НАЗВАНИЕ"] ?? "").trim(),
  })).filter((x: any) => x.id);
}







function forceNewUiMessage(rd: any) {
  delete rd.uiMsgId;     // <-- головне (ймовірно саме це використовує renderFlow)
  delete rd.messageId;   // <-- на всяк випадок
}
function empName(rd: RoadState, id: string) {
  return rd.employees?.find((e) => e.id === id)?.name ?? id;
}

function joinEmpNames(rd: RoadState, ids?: string[]) {
  const list = (ids ?? []).map((id) => empName(rd, id)).filter(Boolean);
  return list.length ? list.join(", ") : TEXTS.ui.symbols.emptyDash;
}

function clearPending(chatId: number, fromId: number, bot?: TelegramBot) {
  const key = `${chatId}:${fromId}`;
  const p = pendingInputs.get(key);
  if (!p) return;
  clearTimeout(p.timer);
  if (bot) bot.removeListener("message", p.listener as any);
  pendingInputs.delete(key);
}

function fmtAgo(iso?: string) {
  if (!iso) return TEXTS.ui.symbols.emptyDash;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return TEXTS.ui.symbols.emptyDash;
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} хв`;
  const h = Math.floor(m / 60);
  return `${h} год ${m % 60} хв`;
}

type CarLock = {
  foremanTgId: number;
  chatId: number;
  since: string;
  status: "ACTIVE" | "WAITING" | "FINISHED_PENDING_SAVE";
};
type EmpLock = { carId: string; foremanTgId: number; chatId: number; since: string };

const carLocks = new Map<string, CarLock>();
const empLocks = new Map<string, EmpLock>();

function lockCar(carId: string, foremanTgId: number, chatId: number, status: CarLock["status"]) {
  carLocks.set(carId, { foremanTgId, chatId, since: nowISO(), status });
}
function setCarLockStatus(carId: string, status: CarLock["status"]) {
  const l = carLocks.get(carId);
  if (!l) return;
  carLocks.set(carId, { ...l, status });
}
function unlockCar(carId?: string) {
  if (!carId) return;
  carLocks.delete(carId);
}
function lockEmp(empId: string, carId: string, foremanTgId: number, chatId: number) {
  empLocks.set(empId, { carId, foremanTgId, chatId, since: nowISO() });
}
function unlockEmp(empId: string) {
  empLocks.delete(empId);
}
function unlockAllEmp(ids: string[]) {
  for (const id of ids) unlockEmp(id);
}

function fmtNum(n?: number) {
  if (n === undefined || Number.isNaN(n)) return TEXTS.ui.symbols.emptyDash;
  return String(n);
}
function nowISO() {
  return new Date().toISOString();
}
function uniq(arr: string[]) {
  return Array.from(new Set(arr));
}
function parseKm(text: string): number | undefined {
  const cleaned = text.trim().replace(",", ".");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return undefined;
  if (n < 0) return undefined;
  return Math.round(n);
}
function fileIdFromPhoto(msg: TelegramBot.Message): string | undefined {
  const photos = (msg as any)?.photo as Array<{ file_id: string }> | undefined;
  if (!photos?.length) return undefined;
  return photos[photos.length - 1]?.file_id;
}

async function askNextMessage(
  bot: TelegramBot,
  chatId: number,
  fromId: number,
  prompt: string,
  onNext: (msg: TelegramBot.Message) => Promise<void>,
  timeoutMs = 2 * 60 * 1000,
) {
  clearPending(chatId, fromId, bot);
  await bot.sendMessage(chatId, prompt);

  const key = `${chatId}:${fromId}`;

  const listener = async (msg: TelegramBot.Message) => {
    try {
      if (msg.chat?.id !== chatId) return;
      if (msg.from?.id !== fromId) return;

      const raw = (msg.text ?? (msg as any)?.caption ?? "").toString().trim();
      if (!raw) return;
      if (raw.startsWith("/")) return;

      clearPending(chatId, fromId, bot);
      await onNext(msg);
    } catch (e) {
      clearPending(chatId, fromId, bot);
      await bot.sendMessage(chatId, `⚠️ Помилка: ${(e as Error)?.message ?? String(e)}`);
    }
  };

  const timer = setTimeout(() => {
    clearPending(chatId, fromId, bot);
    bot.sendMessage(chatId, TEXTS.ui.errors.timeout);
  }, timeoutMs);

  pendingInputs.set(key, { chatId, fromId, createdAt: Date.now(), timer, listener });
  bot.on("message", listener);
}

async function askReply(
  bot: TelegramBot,
  chatId: number,
  prompt: string,
  onReply: (msg: TelegramBot.Message) => Promise<void>,
) {
  const sent = await bot.sendMessage(chatId, prompt, { reply_markup: { force_reply: true } });
  bot.onReplyToMessage(chatId, sent.message_id, async (msg) => {
    try {
      await onReply(msg);
    } catch (e) {
      await bot.sendMessage(chatId, `⚠️ Помилка: ${(e as Error)?.message ?? String(e)}`);
    }
  });
}

function ridersFromMembers(members: RoadMember[]) {
  return uniq(members.map((m) => m.employeeId));
}

function calcSecondsByEmployee(members: RoadMember[]) {
  const out: Record<string, number> = {};
  for (const m of members) {
    if (!m.leftAt) continue;
    const a = Date.parse(m.joinedAt);
    const b = Date.parse(m.leftAt);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
    const sec = Math.floor((b - a) / 1000);
    out[m.employeeId] = (out[m.employeeId] ?? 0) + sec;
  }
  return out;
}

function closeEveryoneInCar(car: CarRoad, ts: string) {
  for (const empId of car.inCarIds) {
    const lastOpen = [...car.members].reverse().find((m) => m.employeeId === empId && !m.leftAt);
    if (lastOpen) lastOpen.leftAt = ts;
  }
  car.inCarIds = [];
}

function makeNewCarState(): CarRoad {
  return {
    phase: "SETUP",
    roadActive: false,
    dayPeopleIds: [],
    returnPeopleIds: [],
    objectsCount: 1,
    inCarIds: [],
    members: [],
    odoStartNeedPhoto: false,
    odoEndNeedPhoto: false,
  };
}

async function ensureEmployees(rd: RoadState) {
  if (rd.employees?.length) return;

  const emps = await fetchEmployees();
  rd.employees = (emps ?? []).slice(0, 60).map((e: any) => ({
    id: String(e.id ?? e.ID ?? e.employeeId ?? e["ID"] ?? "").trim(),
    name: String(e.name ?? e.NAME ?? e["ІМʼЯ"] ?? e["ІМ'Я"] ?? "").trim(),
  })).filter((x: any) => x.id);
}


function ensureCar(rd: RoadState, carId: string): CarRoad {
  rd.cars ??= {};
  if (!rd.cars[carId]) rd.cars[carId] = makeNewCarState();
  return rd.cars[carId];
}
function getActiveCar(rd: RoadState): { carId: string; car: CarRoad } | null {
  if (!rd.activeCarId) return null;
  const carId = rd.activeCarId;
  return { carId, car: ensureCar(rd, carId) };
}

function missingForDaySetup(activeCarId: string | undefined, car: CarRoad): string | null {
  const R = TEXTS.roadFlow;
  if (!activeCarId) return R.guards.needCar;
  if (car.odoStartKm === undefined) return R.guards.needOdoStart;
  if (car.dayPeopleIds.length < 1) return R.guards.needPeopleDay;
  if (!car.objectsCount || car.objectsCount < 1) return R.guards.needObjects;
  return null;
}
function canStartDay(activeCarId: string | undefined, car: CarRoad) {
  return car.phase === "SETUP" && !car.roadActive && !missingForDaySetup(activeCarId, car);
}
function canStopDay(car: CarRoad) {
  return car.phase === "DAY" && !!car.roadActive;
}
function canGoReturn(car: CarRoad) {
  return car.phase === "WAIT_RETURN" && !car.roadActive;
}
function canStartReturn(car: CarRoad) {
  return car.phase === "WAIT_RETURN" && !car.roadActive && car.returnPeopleIds.length >= 1;
}
function canStopReturn(car: CarRoad) {
  return car.phase === "RETURN" && !!car.roadActive;
}
function canEnterOdoEnd(car: CarRoad) {
  return car.phase === "FINISHED" && !car.roadActive;
}
function canSave(activeCarId: string | undefined, car: CarRoad) {
  const riders = ridersFromMembers(car.members);
  return (
    !!activeCarId &&
    car.odoStartKm !== undefined &&
    car.odoEndKm !== undefined &&
    car.phase === "FINISHED" &&
    riders.length >= 1
  );
}

function backToStep(tag: string): RoadStep {
  switch (tag) {
    case "start":
    default:
      return "START";
  }
}

function carShortLine(carId: string, lock: CarLock | undefined, car: CarRoad | undefined) {
  const phase = car?.phase ?? TEXTS.ui.symbols.emptyDash;
  const active = car?.roadActive ? "🟢 active" : "⚪ idle";
  const odo = `ODO ${fmtNum(car?.odoStartKm)} → ${fmtNum(car?.odoEndKm)}`;
  const peopleNow = car?.inCarIds?.length ?? 0;
  const peopleDay = car?.dayPeopleIds?.length ?? 0;
  const peopleRet = car?.returnPeopleIds?.length ?? 0;

  const lockBy = lock ? `🔒 tg:${lock.foremanTgId}` : "";
  const since = lock ? `⏱ ${fmtAgo(lock.since)}` : "";

  return `🚗 ${carId} | ${phase} | ${active} | 👥in:${peopleNow} (day:${peopleDay}, ret:${peopleRet}) | ${odo} ${lockBy} ${since}`.trim();
}

// -------------------- LEGACY MIGRATION --------------------
function migrateIfNeeded(rd: any) {
  if (rd && typeof rd === "object") {
    if (!rd.cars) rd.cars = {};
    if (rd.carId && !rd.cars[rd.carId] && rd.phase) {
      const carId = String(rd.carId);
      rd.cars[carId] = {
        phase: rd.phase as RoadPhase,
        roadActive: !!rd.roadActive,

        odoStartKm: rd.odoStartKm,
        odoEndKm: rd.odoEndKm,
        odoStartPhotoFileId: rd.odoStartPhotoFileId,
        odoEndPhotoFileId: rd.odoEndPhotoFileId,

        dayPeopleIds: Array.isArray(rd.dayPeopleIds) ? rd.dayPeopleIds : [],
        returnPeopleIds: Array.isArray(rd.returnPeopleIds) ? rd.returnPeopleIds : [],
        objectsCount: rd.objectsCount ?? 1,

        inCarIds: Array.isArray(rd.inCarIds) ? rd.inCarIds : [],
        members: Array.isArray(rd.members) ? rd.members : [],

        dayStartedAt: rd.dayStartedAt,
        dayEndedAt: rd.dayEndedAt,
        returnStartedAt: rd.returnStartedAt,
        returnEndedAt: rd.returnEndedAt,

        odoStartNeedPhoto: !!rd.odoStartNeedPhoto,
        odoEndNeedPhoto: !!rd.odoEndNeedPhoto,
      } as CarRoad;

      rd.activeCarId = rd.activeCarId ?? carId;
    }
  }
}

// -------------------- RENDER --------------------
async function render(bot: TelegramBot, chatId: number, s: any) {
  // ✅ Підготувати дані ДО renderFlow (тут await дозволений)
  const st = getFlowState<RoadState>(s, FLOW) as any;
  if (st) {
    migrateIfNeeded(st); // безпечно, якщо вже є
    await ensureCarsMeta(st);
    await ensureEmployees(st); // щоб і авто/люди показувались іменами
  }

  return renderFlow<RoadState>(bot, chatId, s, FLOW, (rd) => {
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date());

    const active = getActiveCar(rd);
    const activeCarId = active?.carId;
    const car = active?.car;

    const carLine = activeCarId
      ? `${TEXTS.roadFlow.labels.carOk} ${carName(rd, activeCarId)}`
      : TEXTS.roadFlow.labels.carNone;

    const odoStartLine =
      car?.odoStartKm !== undefined || car?.odoStartPhotoFileId
        ? `${TEXTS.roadFlow.labels.odoStartOk} ${fmtNum(car?.odoStartKm)} км ${car?.odoStartPhotoFileId ? "📷" : ""}`
        : TEXTS.roadFlow.labels.odoStartNone;

    const odoEndLine =
      car?.odoEndKm !== undefined || car?.odoEndPhotoFileId
        ? `${TEXTS.roadFlow.labels.odoEndOk} ${fmtNum(car?.odoEndKm)} км ${car?.odoEndPhotoFileId ? "📷" : ""}`
        : TEXTS.roadFlow.labels.odoEndNone;

    const peopleDayLine = `${TEXTS.roadFlow.labels.peopleDay} ${joinEmpNames(rd, car?.dayPeopleIds)}`;
    const peopleRetLine = `${TEXTS.roadFlow.labels.peopleReturn} ${joinEmpNames(rd, car?.returnPeopleIds)}`;

    const objLine = `${TEXTS.roadFlow.labels.objects} ${car?.objectsCount ?? TEXTS.ui.symbols.emptyDash}`;
    const inCarLine = `${TEXTS.roadFlow.labels.inCar} ${joinEmpNames(rd, car?.inCarIds)}`;

    const phaseLine = !car
      ? TEXTS.roadFlow.phase.noCar
      : car.phase === "SETUP"
        ? TEXTS.roadFlow.phase.setup
        : car.phase === "DAY"
          ? TEXTS.roadFlow.phase.day
          : car.phase === "WAIT_RETURN"
            ? TEXTS.roadFlow.phase.waitReturn
            : car.phase === "RETURN"
              ? TEXTS.roadFlow.phase.returnTrip
              : TEXTS.roadFlow.phase.finished;

    // якщо авто не обрано — далі не пускаємо
    if (!car || !activeCarId) {
      return {
        text: TEXTS.roadFlow.guards.needCar,
        kb: {
          inline_keyboard: [
            [{ text: TEXTS.roadFlow.buttons.pickCar, callback_data: cb.PICK_CAR }],
            [{ text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU }],
          ],
        },
      };
    }

    // -------- MANAGE PEOPLE (during run) --------
    if (rd.step === "MANAGE_PEOPLE") {
      const emps = rd.employees ?? [];
      const keyboard: TelegramBot.InlineKeyboardButton[][] = (emps ?? []).map((e) => {
        const inCar = car.inCarIds.includes(e.id);
        const label = inCar
          ? TEXTS.roadFlow.labels.dropPrefix.replace("{name}", e.name)
          : TEXTS.roadFlow.labels.pickPrefix.replace("{name}", e.name);

        return [{ text: label.slice(0, 60), callback_data: `${cb.ROAD_TOGGLE_EMP}${e.id}` }];
      });

      keyboard.push([{ text: TEXTS.ui.buttons.done, callback_data: cb.DONE }]);
      keyboard.push([{ text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU }]);

      return {
        text:
          `${TEXTS.roadFlow.screens.managePeople}\n\n` +
          `${TEXTS.roadFlow.labels.inCarNow} ${joinEmpNames(rd, car.inCarIds)}`,
        kb: { inline_keyboard: keyboard },
      };
    }

    // -------- START MENU (меню дороги) --------
    if (rd.step === "START") {
      const rows: TelegramBot.InlineKeyboardButton[][] = [];

      rows.push([{ text: TEXTS.roadFlow.buttons.pickCar, callback_data: cb.PICK_CAR }]);

      if (car?.roadActive && (car.phase === "DAY" || car.phase === "RETURN")) {
        rows.push([{ text: TEXTS.roadFlow.buttons.managePeople, callback_data: cb.MANAGE_PEOPLE }]);
      }

      if (car) {
        if (car.phase === "SETUP") {
          rows.push([{ text: TEXTS.roadFlow.buttons.odoStart, callback_data: cb.ODO_START }]);
          rows.push([{ text: TEXTS.roadFlow.buttons.peopleDay, callback_data: cb.PICK_PEOPLE_DAY }]);
          rows.push([{ text: TEXTS.roadFlow.buttons.objectsCount, callback_data: cb.PICK_OBJECTS }]);

          if (canStartDay(activeCarId, car)) {
            rows.push([{ text: TEXTS.roadFlow.buttons.startDay, callback_data: cb.START_DAY }]);
          }
        }

        if (car.phase === "DAY" && car.roadActive) {
          rows.push([{ text: TEXTS.roadFlow.buttons.stopDay, callback_data: cb.STOP_DAY }]);
        }

        if (car.phase === "WAIT_RETURN" && !car.roadActive) {
          rows.push([{ text: TEXTS.roadFlow.buttons.goReturnMenu, callback_data: cb.GO_RETURN_MENU }]);
          rows.push([{ text: TEXTS.roadFlow.buttons.peopleReturn, callback_data: cb.PICK_PEOPLE_RETURN }]);
          if (canStartReturn(car)) rows.push([{ text: TEXTS.roadFlow.buttons.startReturn, callback_data: cb.START_RETURN }]);
        }

        if (car.phase === "RETURN" && car.roadActive) {
          rows.push([{ text: TEXTS.roadFlow.buttons.stopReturn, callback_data: cb.STOP_RETURN }]);
        }

        if (car.phase === "FINISHED" && !car.roadActive) {
          rows.push([{ text: TEXTS.roadFlow.buttons.odoEnd, callback_data: cb.ODO_END }]);
          if (canSave(activeCarId, car)) rows.push([{ text: TEXTS.roadFlow.buttons.save, callback_data: cb.SAVE }]);
        }
      }

      rows.push([{ text: TEXTS.roadFlow.buttons.stats, callback_data: cb.STATS }]);
      rows.push([{ text: TEXTS.roadFlow.buttons.reset, callback_data: cb.RESET }]);
      rows.push([{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }]);

      return {
        text:
          `${TEXTS.flows.road}\n\n` +
          `📅 ${date}\n\n` +
          `${phaseLine}\n` +
          `${carLine}\n` +
          `${odoStartLine}\n` +
          `${peopleDayLine}\n` +
          `${objLine}\n` +
          `${peopleRetLine}\n` +
          `${odoEndLine}\n` +
          `${inCarLine}\n\n` +
          `${TEXTS.roadFlow.hints.menu}`,
        kb: { inline_keyboard: rows },
      };
    }

    // -------- PICK CAR SCREEN --------
    if (rd.step === "PICK_CAR") {
      return {
        text: TEXTS.roadFlow.screens.pickCar,
        kb: {
          inline_keyboard: [
            [{ text: TEXTS.ui.buttons.done, callback_data: cb.DONE }],
            [{ text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` }],
            [{ text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU }],
          ],
        },
      };
    }

    // -------- ODO START --------
    if (rd.step === "ODO_START") {
      if (car.odoStartKm === undefined) {
        return {
          text: `${TEXTS.roadFlow.screens.odoStartEnter}\n\n${TEXTS.ui.labels.current} ${fmtNum(car.odoStartKm)} км`,
          kb: {
            inline_keyboard: [
              [{ text: TEXTS.roadFlow.buttons.enterValue, callback_data: cb.ASK_ODO_START_KM }],
              [{ text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` }],
              [{ text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU }],
            ],
          },
        };
      }

      return {
        text: `${TEXTS.roadFlow.screens.odoStartOk.replace("{km}", fmtNum(car.odoStartKm))}\n\n${TEXTS.roadFlow.hints.sendOrSkipPhoto}`,
        kb: {
          inline_keyboard: [
            [{ text: TEXTS.roadFlow.buttons.sendPhoto, callback_data: cb.ASK_ODO_START_PHOTO }],
            [{ text: TEXTS.roadFlow.buttons.skipPhoto, callback_data: cb.SKIP_ODO_START_PHOTO }],
            [{ text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` }],
            [{ text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU }],
          ],
        },
      };
    }

    // -------- PICK PEOPLE DAY --------
    if (rd.step === "PICK_PEOPLE_DAY") {
      const emps = rd.employees ?? [];
      const selected = new Set(car.dayPeopleIds);

      const rows: TelegramBot.InlineKeyboardButton[][] = emps.map((e) => [
        {
          text: `${selected.has(e.id) ? "✅ " : ""}${e.name}`.slice(0, 60),
          callback_data: `${cb.EMP_DAY}${e.id}`,
        },
      ]);

      rows.push([{ text: TEXTS.ui.buttons.done, callback_data: cb.DONE }]);
      rows.push([{ text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` }]);
      rows.push([{ text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU }]);

      return {
        text: `👥 Люди (день)\n\n${TEXTS.roadFlow.labels.picked} ${joinEmpNames(rd, car.dayPeopleIds)}\n\n${TEXTS.roadFlow.hints.tapToToggle}`,
        kb: { inline_keyboard: rows },
      };
    }

    // -------- OBJECTS COUNT --------
    if (rd.step === "PICK_OBJECTS_COUNT") {
      const n = car.objectsCount ?? 1;
      return {
        text: TEXTS.roadFlow.screens.objects.replace("{n}", String(n)),
        kb: {
          inline_keyboard: [
            [
              { text: "1", callback_data: `${cb.OBJ_SET}1` },
              { text: "2", callback_data: `${cb.OBJ_SET}2` },
              { text: "3", callback_data: `${cb.OBJ_SET}3` },
              { text: "4", callback_data: `${cb.OBJ_SET}4` },
              { text: "5", callback_data: `${cb.OBJ_SET}5` },
            ],
            [
              { text: TEXTS.ui.buttons.minus, callback_data: cb.OBJ_MINUS },
              { text: TEXTS.ui.buttons.plus, callback_data: cb.OBJ_PLUS },
            ],
            [{ text: TEXTS.ui.buttons.done, callback_data: cb.DONE }],
            [{ text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` }],
            [{ text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU }],
          ],
        },
      };
    }

    // -------- RUN DAY --------
    if (rd.step === "RUN_DAY") {
      return {
        text:
          `${TEXTS.roadFlow.screens.runDay}\n\n` +
          `${carLine}\n${odoStartLine}\n${objLine}\n${inCarLine}\n\n` +
          `${TEXTS.roadFlow.hints.runDay}`,
        kb: {
          inline_keyboard: [
            [{ text: TEXTS.roadFlow.buttons.managePeople, callback_data: cb.MANAGE_PEOPLE }],
            [{ text: TEXTS.roadFlow.buttons.manageObjects, callback_data: cb.MANAGE_OBJECTS }],
            [{ text: TEXTS.roadFlow.buttons.stopGeneric, callback_data: cb.STOP_DAY }],
            [{ text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU }],
          ],
        },
      };
    }

    // -------- AFTER STOP DAY --------
    if (rd.step === "AFTER_STOP_DAY") {
      return {
        text: TEXTS.roadFlow.screens.afterStopDay,
        kb: {
          inline_keyboard: [
            [{ text: TEXTS.roadFlow.buttons.goReturnMenu, callback_data: cb.GO_RETURN_MENU }],
            [{ text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU }],
          ],
        },
      };
    }

    // -------- RETURN MENU --------
    if (rd.step === "RETURN_MENU") {
      return {
        text: TEXTS.roadFlow.screens.returnMenu,
        kb: {
          inline_keyboard: [
            [{ text: TEXTS.roadFlow.buttons.pickPeople, callback_data: cb.PICK_PEOPLE_RETURN }],
            [{ text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` }],
            [{ text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU }],
          ],
        },
      };
    }

    // -------- PICK PEOPLE RETURN --------
    if (rd.step === "PICK_PEOPLE_RETURN") {
      const emps = rd.employees ?? [];
      const selected = new Set(car.returnPeopleIds);

      const rows: TelegramBot.InlineKeyboardButton[][] = emps.map((e) => [
        {
          text: `${selected.has(e.id) ? "✅ " : ""}${e.name}`.slice(0, 60),
          callback_data: `${cb.EMP_RETURN}${e.id}`,
        },
      ]);

      rows.push([{ text: TEXTS.ui.buttons.done, callback_data: cb.DONE }]);
      rows.push([{ text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` }]);
      rows.push([{ text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU }]);

      return {
        text: `👥 Люди (повернення)\n\n${TEXTS.roadFlow.labels.picked} ${joinEmpNames(rd, car.returnPeopleIds)}\n\n${TEXTS.roadFlow.hints.tapToToggle}`,
        kb: { inline_keyboard: rows },
      };
    }

    // -------- RUN RETURN --------
    if (rd.step === "RUN_RETURN") {
      return {
        text:
          `${TEXTS.roadFlow.screens.runReturn}\n\n` +
          `${carLine}\n${inCarLine}\n\n` +
          `${TEXTS.roadFlow.hints.runReturn}`,
        kb: {
          inline_keyboard: [
            [{ text: TEXTS.roadFlow.buttons.managePeople, callback_data: cb.MANAGE_PEOPLE }],
            [{ text: TEXTS.roadFlow.buttons.stopGeneric, callback_data: cb.STOP_RETURN }],
            [{ text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU }],
          ],
        },
      };
    }

    // -------- ODO END --------
    if (rd.step === "ODO_END") {
      if (car.odoEndKm === undefined) {
        return {
          text: `${TEXTS.roadFlow.screens.odoEndEnter}\n\n${TEXTS.ui.labels.current} ${fmtNum(car.odoEndKm)} км`,
          kb: {
            inline_keyboard: [
              [{ text: TEXTS.roadFlow.buttons.enterValue, callback_data: cb.ASK_ODO_END_KM }],
              [{ text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` }],
              [{ text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU }],
            ],
          },
        };
      }

      return {
        text: `${TEXTS.roadFlow.screens.odoEndOk.replace("{km}", fmtNum(car.odoEndKm))}\n\n${TEXTS.roadFlow.hints.sendOrSkipPhoto}`,
        kb: {
          inline_keyboard: [
            [{ text: TEXTS.roadFlow.buttons.sendPhoto, callback_data: cb.ASK_ODO_END_PHOTO }],
            [{ text: TEXTS.roadFlow.buttons.skipPhoto, callback_data: cb.SKIP_ODO_END_PHOTO }],
            [{ text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` }],
            [{ text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU }],
          ],
        },
      };
    }

    // -------- SAVE --------
    if (rd.step === "SAVE") {
      return {
        text: TEXTS.roadFlow.screens.save,
        kb: {
          inline_keyboard: [
            [{ text: TEXTS.roadFlow.buttons.save, callback_data: cb.SAVE }],
            [{ text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` }],
            [{ text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU }],
          ],
        },
      };
    }

    return {
      text: "…",
      kb: { inline_keyboard: [[{ text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU }]] },
    };
  });
}


export const RoadFlow: FlowModule = {
  flow: FLOW,
  menuText: TEXTS.buttons.road,
  cbPrefix: PREFIX,

  start: async (bot, chatId, s) => {
    const existing = getFlowState<RoadState>(s, FLOW) as any;
    if (existing) {
      migrateIfNeeded(existing);
      s.mode = "FLOW";
      s.flow = FLOW;
      existing.step = (existing.step ?? "START") as RoadStep;
      existing.cars = existing.cars ?? {};
      return render(bot, chatId, s);
    }

    const st: RoadState = { step: "START", cars: {} };
    setFlowState(s, FLOW, st);
    s.mode = "FLOW";
    s.flow = FLOW;
    return render(bot, chatId, s);
  },

  render: async (bot, chatId, s) => render(bot, chatId, s),

  onCallback: async (bot, q, s, data) => {
    const chatId = q.message?.chat.id;
    if (!chatId) return false;

    const msgId = q.message?.message_id;
    if (!msgId) return false;

    const foremanTgId = q.from?.id ?? 0;
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date());

    const rd = getFlowState<RoadState>(s, FLOW) as any;
    if (!rd) return false;
    migrateIfNeeded(rd);

    const gate = async (text: string) => {
      await bot.answerCallbackQuery(q.id, { text: `⛔ ${text}`, show_alert: true });
    };

    const active = getActiveCar(rd);
    const activeCarId = active?.carId;
    const car = active?.car;

    // MENU
    if (data === cb.MENU) {
      rd.step = "START";
      await render(bot, chatId, s);
      return true;
    }

    if (data === cb.STATS) {
      const ids = new Set<string>([
        ...Array.from(carLocks.keys()),
        ...Object.keys(rd.cars ?? {}),
      ]);

      const lines: string[] = [];
      for (const carId of Array.from(ids).sort()) {
        const lock = carLocks.get(carId);
        const car = rd.cars?.[carId];
        const isInteresting =
          !!lock ||
          car?.roadActive ||
          car?.phase === "WAIT_RETURN" ||
          car?.phase === "RETURN" ||
          car?.phase === "FINISHED";

        if (!isInteresting) continue;
        lines.push(carShortLine(carId, lock, car));
      }

      const text =
        `${TEXTS.roadFlow.screens.statsTitle}\n\n` +
        (lines.length ? lines.join("\n") : TEXTS.roadFlow.screens.statsEmpty);

      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: {
          inline_keyboard: [
            [{ text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` }],
            [{ text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU }],
          ],
        },
      });

      return true;
    }

    // BACK
    if (data.startsWith(cb.BACK)) {
      const tag = data.slice(cb.BACK.length);
      rd.step = backToStep(tag);
      await render(bot, chatId, s);
      return true;
    }

    // RESET confirm
    if (data === cb.RESET) {
      await bot.editMessageText(TEXTS.roadFlow.screens.resetConfirm, {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: {
          inline_keyboard: [
            [{ text: TEXTS.ui.buttons.yesReset, callback_data: cb.RESET_YES }],
            [{ text: TEXTS.ui.buttons.no, callback_data: cb.RESET_NO }],
          ],
        },
      });
      return true;
    }
    if (data === cb.RESET_NO) {
      await render(bot, chatId, s);
      return true;
    }
    if (data === cb.RESET_YES) {
      if (activeCarId) rd.cars[activeCarId] = makeNewCarState();
      else rd.cars = {};
      rd.step = "START";
      await render(bot, chatId, s);
      return true;
    }

    // ---------------- CAR PICK ----------------
    if (data === cb.PICK_CAR) {
      rd.step = "PICK_CAR";
      const carsList = await fetchCars();
      const rows = (carsList ?? []).slice(0, 24);

      const keyboard: TelegramBot.InlineKeyboardButton[][] = rows.map((c: any) => {
        const id = String(c.id ?? c.ID ?? c.carId ?? c["ID"] ?? "").trim();
        const name = String(c.name ?? c.NAME ?? c.title ?? c["НАЗВА"] ?? id).trim();

        const lock = carLocks.get(id);
        const busyByOther = !!lock && lock.foremanTgId !== foremanTgId;
        const busyByMe = !!lock && lock.foremanTgId === foremanTgId;

        const selected = rd.activeCarId === id;
        const markSelected = selected ? "☑️ " : "";
        const markBusyMe = !selected && busyByMe ? "✅ " : "";
        const markBusyOther = busyByOther ? "🚫 " : "";
        const suffix = busyByOther ? ` ${TEXTS.roadFlow.labels.busySuffix}` : "";

        return [
          {
            text: `${markBusyOther}${markSelected}${markBusyMe}${name}${suffix}`.slice(0, 60),
            callback_data: busyByOther ? `${cb.CAR_BUSY}${id}` : `${cb.CAR}${id}`,
          },
        ];
      });

      keyboard.push([{ text: TEXTS.ui.buttons.done, callback_data: cb.DONE }]);
      keyboard.push([{ text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` }]);
      keyboard.push([{ text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU }]);

      await bot.editMessageText(TEXTS.roadFlow.screens.pickCarShort, {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: { inline_keyboard: keyboard },
      });
      return true;
    }

    if (data.startsWith(cb.CAR_BUSY)) {
      const carId = data.slice(cb.CAR_BUSY.length);
      const lock = carLocks.get(carId);

      const msg = lock
        ? TEXTS.roadFlow.screens.carBusyBy.replace("{carId}", carId).replace("{tg}", String(lock.foremanTgId))
        : TEXTS.roadFlow.screens.carBusy.replace("{carId}", carId);

      await bot.editMessageText(msg, {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: {
          inline_keyboard: [
            ...(lock ? [[{ text: TEXTS.roadFlow.buttons.messageForeman, url: `tg://user?id=${lock.foremanTgId}` }]] : []),
            [{ text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` }],
            [{ text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU }],
          ],
        },
      });
      return true;
    }

    if (data.startsWith(cb.CAR)) {
      const pickedCarId = data.slice(cb.CAR.length);

      const lock = carLocks.get(pickedCarId);
      if (lock && lock.foremanTgId !== foremanTgId) {
        await gate(TEXTS.roadFlow.guards.carBusy);
        return true;
      }

      if (rd.activeCarId === pickedCarId) {
        delete rd.activeCarId;
        await render(bot, chatId, s);
        return true;
      }

      rd.activeCarId = pickedCarId;
      ensureCar(rd, pickedCarId);
      await render(bot, chatId, s);
      return true;
    }

    // DONE = next logical step
    if (data === cb.DONE) {

if (rd.step === "MANAGE_PEOPLE") {
  // повертаємось назад в екран руху
  const a = getActiveCar(rd);
  if (!a) {
    await gate(TEXTS.roadFlow.guards.needCar);
    return true;
  }

  rd.step = a.car.phase === "RETURN" ? "RUN_RETURN" : "RUN_DAY";
  await render(bot, chatId, s);
  return true;
}


      if (rd.step === "PICK_CAR") {
        if (!rd.activeCarId) {
          await gate(TEXTS.roadFlow.guards.needPickCar);
          return true;
        }

        const a = getActiveCar(rd);
        if (!a) {
          await gate(TEXTS.roadFlow.guards.needCar);
          return true;
        }

        if (a.car.roadActive && a.car.phase === "DAY") {
          rd.step = "RUN_DAY";
          await render(bot, chatId, s);
          return true;
        }
        if (a.car.roadActive && a.car.phase === "RETURN") {
          rd.step = "RUN_RETURN";
          await render(bot, chatId, s);
          return true;
        }
        if (a.car.phase === "WAIT_RETURN") {
          rd.step = "RETURN_MENU";
          await render(bot, chatId, s);
          return true;
        }
        if (a.car.phase === "FINISHED") {
          rd.step = "ODO_END";
          await render(bot, chatId, s);
          return true;
        }

        rd.step = "ODO_START";
        a.car.odoStartNeedPhoto = true;
        await render(bot, chatId, s);
        return true;
      }

      const a = getActiveCar(rd);
      if (!a) {
        await gate(TEXTS.roadFlow.guards.needCar);
        return true;
      }

      if (rd.step === "ODO_START") {
        if (a.car.odoStartKm === undefined) {
          await gate(TEXTS.roadFlow.guards.needOdoStart);
          return true;
        }
        rd.step = "PICK_PEOPLE_DAY";
        await render(bot, chatId, s);
        return true;
      }

      if (rd.step === "PICK_PEOPLE_DAY") {
        if (a.car.dayPeopleIds.length < 1) {
          await gate(TEXTS.roadFlow.guards.needPeopleDay);
          return true;
        }
        rd.step = "PICK_OBJECTS_COUNT";
        await render(bot, chatId, s);
        return true;
      }

      if (rd.step === "PICK_OBJECTS_COUNT") {
        if (!a.car.objectsCount || a.car.objectsCount < 1) {
          await gate(TEXTS.roadFlow.guards.needObjects);
          return true;
        }
        rd.step = "START";
        await render(bot, chatId, s);
        return true;
      }

      rd.step = "START";
      await render(bot, chatId, s);
      return true;
    }

    // ---------- MUST HAVE ACTIVE CAR ----------
    const a = getActiveCar(rd);
    if (!a) {
      await gate(TEXTS.roadFlow.guards.needCar);
      return true;
    }
    const carId = a.carId;
    const c = a.car;

    // ODO_START enter
    if (data === cb.ODO_START) {
      rd.step = "ODO_START";
      await render(bot, chatId, s);
      return true;
    }

    // ASK ODO START KM
    if (data === cb.ASK_ODO_START_KM) {
      await askNextMessage(
        bot,
        chatId,
        foremanTgId,
        TEXTS.roadFlow.prompts.odoStartNumber,
        async (msg) => {
          const raw = (msg.text ?? (msg as any)?.caption ?? "").toString();
          const km = parseKm(raw);
          if (km === undefined) {
            await bot.sendMessage(chatId, TEXTS.roadFlow.errors.notNumberExample.replace("{ex}", "12345"));
            return;
          }
c.odoStartKm = km;
c.odoStartNeedPhoto = true;

rd.step = "ODO_START";
forceNewUiMessage(rd);;
await render(bot, chatId, s);


        },
      );
      return true;
    }

    // ASK ODO START PHOTO
    if (data === cb.ASK_ODO_START_PHOTO) {
      if (c.odoStartKm === undefined) {
        await gate(TEXTS.roadFlow.guards.needOdoStart);
        return true;
      }

      await askReply(bot, chatId, TEXTS.roadFlow.prompts.odoStartPhoto, async (msg) => {
        const fileId = fileIdFromPhoto(msg);
        if (!fileId) {
          await bot.sendMessage(chatId, TEXTS.roadFlow.errors.needPhoto);
          return;
        }
 c.odoStartPhotoFileId = fileId;
c.odoStartNeedPhoto = false;

const emps = await fetchEmployees();
const rows = (emps ?? []).slice(0, 40).map((e: any) => ({
  id: String(e.id ?? e.ID ?? e.employeeId ?? e["ID"] ?? "").trim(),
  name: String(e.name ?? e.NAME ?? e["ІМʼЯ"] ?? e["ІМ'Я"] ?? "").trim(),
}));

(rd as any)._cache ??= {};
(rd as any)._cache.emps = rows;

rd.step = "PICK_PEOPLE_DAY";
forceNewUiMessage(rd);;
await render(bot, chatId, s);


      });

      return true;
    }

    // SKIP ODO START PHOTO
if (data === cb.SKIP_ODO_START_PHOTO) {
  if (c.odoStartKm === undefined) {
    await gate(TEXTS.roadFlow.guards.needOdoStart);
    return true;
  }

  c.odoStartNeedPhoto = false;

await ensureEmployees(rd);
rd.step = "PICK_PEOPLE_DAY";
forceNewUiMessage(rd);;
await render(bot, chatId, s);

  return true;
}


    // PICK PEOPLE DAY
if (data === cb.PICK_PEOPLE_RETURN) {
  if (!canGoReturn(c)) {
    await gate(TEXTS.roadFlow.errors.needStopDayFirst);
    return true;
  }

  await ensureEmployees(rd);
  rd.step = "PICK_PEOPLE_RETURN";
  await render(bot, chatId, s);
  return true;
}


    if (data.startsWith(cb.EMP_DAY)) {
      const id = data.slice(cb.EMP_DAY.length);
      const has = c.dayPeopleIds.includes(id);
      c.dayPeopleIds = has ? c.dayPeopleIds.filter((x) => x !== id) : [...c.dayPeopleIds, id];

      await render(bot, chatId, s);
      return true;
    }

    // OBJECTS
    if (data === cb.PICK_OBJECTS) {
      if (c.odoStartKm === undefined) {
        await gate(TEXTS.roadFlow.guards.needOdoStart);
        return true;
      }
      if (c.dayPeopleIds.length < 1) {
        await gate(TEXTS.roadFlow.guards.needPeopleDay);
        return true;
      }
      rd.step = "PICK_OBJECTS_COUNT";
      await render(bot, chatId, s);
      return true;
    }

    if (data === cb.OBJ_MINUS) {
      c.objectsCount = Math.max(1, (c.objectsCount ?? 1) - 1);
      await render(bot, chatId, s);
      return true;
    }
    if (data === cb.OBJ_PLUS) {
      c.objectsCount = Math.min(50, (c.objectsCount ?? 1) + 1);
      await render(bot, chatId, s);
      return true;
    }
    if (data.startsWith(cb.OBJ_SET)) {
      const n = Number(data.slice(cb.OBJ_SET.length));
      if (Number.isFinite(n) && n >= 1 && n <= 5) c.objectsCount = n;
      await render(bot, chatId, s);
      return true;
    }

    // START DAY
    if (data === cb.START_DAY) {
      if (!canStartDay(activeCarId, c)) {
        const miss = missingForDaySetup(activeCarId, c) ?? TEXTS.roadFlow.errors.cantStartNow;
        await gate(miss);
        return true;
      }

      const l = carLocks.get(carId);
      if (l && l.foremanTgId !== foremanTgId) {
        await gate(TEXTS.roadFlow.guards.carBusy);
        return true;
      }
      lockCar(carId, foremanTgId, chatId, "ACTIVE");

      c.phase = "DAY";
      c.roadActive = true;
      c.dayStartedAt = nowISO();

      c.inCarIds = [...c.dayPeopleIds];
      c.members.push(...c.inCarIds.map((employeeId) => ({ employeeId, joinedAt: c.dayStartedAt! })));

      for (const empId of c.inCarIds) {
        const lock = empLocks.get(empId);
        if (lock && lock.carId !== carId && lock.foremanTgId !== foremanTgId) {
          await gate(TEXTS.roadFlow.errors.personInOtherCar.replace("{emp}", empId).replace("{car}", lock.carId));
          return true;
        }
      }
      for (const empId of c.inCarIds) lockEmp(empId, carId, foremanTgId, chatId);

      await appendEvents([
        {
          date,
          foremanTgId,
          type: "ROAD_DAY_START",
          objectId: "",
          carId,
          employeeIds: c.inCarIds.join(","),
          payload: JSON.stringify({ odoStartKm: c.odoStartKm, objectsCount: c.objectsCount }),
          chatId,
          msgId,
          status: "АКТИВНА",
          refEventId: "",
          updatedAt: nowISO(),
        } as any,
      ]);

      rd.step = "RUN_DAY";
      await render(bot, chatId, s);
      return true;
    }

    // STOP DAY
    if (data === cb.STOP_DAY) {
      if (!canStopDay(c)) {
        await gate(TEXTS.roadFlow.errors.dayNotActive);
        return true;
      }

      const ts = nowISO();
      const dropped = [...c.inCarIds];
      closeEveryoneInCar(c, ts);
      unlockAllEmp(dropped);

      c.roadActive = false;
      c.dayEndedAt = ts;
      c.phase = "WAIT_RETURN";
      setCarLockStatus(carId, "WAITING");

      await appendEvents([
        {
          date,
          foremanTgId,
          type: "ROAD_DAY_STOP",
          objectId: "",
          carId,
          employeeIds: dropped.join(","),
          payload: JSON.stringify({ autoDropAll: true }),
          chatId,
          msgId,
          status: "АКТИВНА",
          refEventId: "",
          updatedAt: nowISO(),
        } as any,
      ]);

      rd.step = "AFTER_STOP_DAY";
      await render(bot, chatId, s);
      return true;
    }

    // GO RETURN MENU
    if (data === cb.GO_RETURN_MENU) {
      if (!canGoReturn(c)) {
        await gate(TEXTS.roadFlow.errors.needStopDayFirst);
        return true;
      }
      rd.step = "RETURN_MENU";
      await render(bot, chatId, s);
      return true;
    }

    // PICK PEOPLE RETURN
    if (data === cb.PICK_PEOPLE_RETURN) {
      if (!canGoReturn(c)) {
        await gate(TEXTS.roadFlow.errors.needStopDayFirst);
        return true;
      }

      rd.step = "PICK_PEOPLE_RETURN";
      const emps = await fetchEmployees();
      const rows = (emps ?? []).slice(0, 40);

      const keyboard: TelegramBot.InlineKeyboardButton[][] = rows.map((e: any) => {
        const id = String(e.id ?? e.ID ?? e.employeeId ?? e["ID"] ?? "").trim();
        const name = String(e.name ?? e.NAME ?? e["ІМʼЯ"] ?? e["ІМ'Я"] ?? id).trim();
        const picked = c.returnPeopleIds.includes(id);
        return [{ text: `${picked ? "✅ " : ""}${name}`.slice(0, 60), callback_data: `${cb.EMP_RETURN}${id}` }];
      });

      keyboard.push([{ text: TEXTS.roadFlow.buttons.startReturn, callback_data: cb.START_RETURN }]);
      keyboard.push([{ text: TEXTS.ui.buttons.back, callback_data: `${cb.BACK}start` }]);
      keyboard.push([{ text: TEXTS.roadFlow.buttons.menuRoad, callback_data: cb.MENU }]);

      await bot.editMessageText(
        `${TEXTS.roadFlow.screens.peopleReturn}\n\n${TEXTS.roadFlow.labels.picked} ${
          c.returnPeopleIds.length ? c.returnPeopleIds.join(", ") : TEXTS.ui.symbols.emptyDash
        }\n\n${TEXTS.roadFlow.hints.tapToToggle}`,
        {
          chat_id: chatId,
          message_id: msgId,
          reply_markup: { inline_keyboard: keyboard },
        },
      );
      return true;
    }

    if (data.startsWith(cb.EMP_RETURN)) {
      const id = data.slice(cb.EMP_RETURN.length);
      const has = c.returnPeopleIds.includes(id);
      c.returnPeopleIds = has ? c.returnPeopleIds.filter((x) => x !== id) : [...c.returnPeopleIds, id];
      await render(bot, chatId, s);
      return true;
    }

    // START RETURN
    if (data === cb.START_RETURN) {
      if (!canStartReturn(c)) {
        await gate(TEXTS.roadFlow.guards.needPeopleReturn);
        return true;
      }

      const l = carLocks.get(carId);
      if (l && l.foremanTgId !== foremanTgId) {
        await gate(TEXTS.roadFlow.guards.carBusy);
        return true;
      }
      lockCar(carId, foremanTgId, chatId, "ACTIVE");

      c.phase = "RETURN";
      c.roadActive = true;
      c.returnStartedAt = nowISO();

      c.inCarIds = [...c.returnPeopleIds];
      c.members.push(...c.inCarIds.map((employeeId) => ({ employeeId, joinedAt: c.returnStartedAt! })));

      for (const empId of c.inCarIds) {
        const lock = empLocks.get(empId);
        if (lock && lock.carId !== carId && lock.foremanTgId !== foremanTgId) {
          await gate(TEXTS.roadFlow.errors.personInOtherCar.replace("{emp}", empId).replace("{car}", lock.carId));
          return true;
        }
      }
      for (const empId of c.inCarIds) lockEmp(empId, carId, foremanTgId, chatId);

      await appendEvents([
        {
          date,
          foremanTgId,
          type: "ROAD_RETURN_START",
          objectId: "",
          carId,
          employeeIds: c.inCarIds.join(","),
          payload: JSON.stringify({}),
          chatId,
          msgId,
          status: "АКТИВНА",
          refEventId: "",
          updatedAt: nowISO(),
        } as any,
      ]);

      rd.step = "RUN_RETURN";
      await render(bot, chatId, s);
      return true;
    }

    // STOP RETURN
    if (data === cb.STOP_RETURN) {
      if (!canStopReturn(c)) {
        await gate(TEXTS.roadFlow.errors.returnNotActive);
        return true;
      }

      const ts = nowISO();
      const dropped = [...c.inCarIds];
      closeEveryoneInCar(c, ts);
      unlockAllEmp(dropped);

      c.roadActive = false;
      c.returnEndedAt = ts;
      c.phase = "FINISHED";
      setCarLockStatus(carId, "FINISHED_PENDING_SAVE");

      await appendEvents([
        {
          date,
          foremanTgId,
          type: "ROAD_RETURN_STOP",
          objectId: "",
          carId,
          employeeIds: dropped.join(","),
          payload: JSON.stringify({ autoDropAll: true }),
          chatId,
          msgId,
          status: "АКТИВНА",
          refEventId: "",
          updatedAt: nowISO(),
        } as any,
      ]);

      rd.step = "ODO_END";
      await render(bot, chatId, s);
      return true;
    }

    // ODO END enter
    if (data === cb.ODO_END) {
      if (!canEnterOdoEnd(c)) {
        await gate(TEXTS.roadFlow.errors.odoEndAfterReturnStop);
        return true;
      }
      rd.step = "ODO_END";
      await render(bot, chatId, s);
      return true;
    }

    // ASK ODO END KM
    if (data === cb.ASK_ODO_END_KM) {
      if (!canEnterOdoEnd(c)) {
        await gate(TEXTS.roadFlow.errors.odoEndAfterReturnStop);
        return true;
      }

      await askNextMessage(
        bot,
        chatId,
        foremanTgId,
        TEXTS.roadFlow.prompts.odoEndNumber,
        async (msg) => {
          const raw = (msg.text ?? (msg as any)?.caption ?? "").toString();
          const km = parseKm(raw);
          if (km === undefined) {
            await bot.sendMessage(chatId, TEXTS.roadFlow.errors.notNumberExample.replace("{ex}", "12500"));
            return;
          }
c.odoEndKm = km;
c.odoEndNeedPhoto = true;

rd.step = "ODO_END";
forceNewUiMessage(rd);;
await render(bot, chatId, s);


        },
      );

      return true;
    }

    // ASK ODO END PHOTO
    if (data === cb.ASK_ODO_END_PHOTO) {
      if (c.odoEndKm === undefined || !canEnterOdoEnd(c)) {
        await gate(TEXTS.roadFlow.guards.needOdoEnd);
        return true;
      }

      await askReply(bot, chatId, TEXTS.roadFlow.prompts.odoEndPhoto, async (msg) => {
        const fileId = fileIdFromPhoto(msg);
        if (!fileId) {
          await bot.sendMessage(chatId, TEXTS.roadFlow.errors.needPhoto);
          return;
        }
        c.odoEndPhotoFileId = fileId;
        c.odoEndNeedPhoto = false;
        await bot.sendMessage(chatId, TEXTS.ui.ok.photoAccepted);
 rd.step = "SAVE";
forceNewUiMessage(rd);;
await render(bot, chatId, s);

      });
      return true;
    }

    // SKIP ODO END PHOTO
    if (data === cb.SKIP_ODO_END_PHOTO) {
      if (c.odoEndKm === undefined || !canEnterOdoEnd(c)) {
        await gate(TEXTS.roadFlow.guards.needOdoEnd);
        return true;
      }
      c.odoEndNeedPhoto = false;
rd.step = "SAVE";
forceNewUiMessage(rd);;
await render(bot, chatId, s);

      return true;
    }

    // MANAGE DURING RUN
    if (data === cb.MANAGE_OBJECTS) {
      if (!(c.phase === "DAY" && c.roadActive)) {
        await gate(TEXTS.roadFlow.errors.objectsOnlyDuringDay);
        return true;
      }
      rd.step = "PICK_OBJECTS_COUNT";
      await render(bot, chatId, s);
      return true;
    }

if (data === cb.MANAGE_PEOPLE) {
  if (!c.roadActive || (c.phase !== "DAY" && c.phase !== "RETURN")) {
    await gate(TEXTS.roadFlow.errors.peopleOnlyDuringActive);
    return true;
  }

  const emps = await fetchEmployees();
  const rows = (emps ?? []).slice(0, 40).map((e: any) => ({
    id: String(e.id ?? e.ID ?? e.employeeId ?? e["ID"] ?? "").trim(),
    name: String(e.name ?? e.NAME ?? e["ІМʼЯ"] ?? e["ІМ'Я"] ?? "").trim(),
  }));

  (rd as any)._cache ??= {};
  (rd as any)._cache.emps = rows;


  await ensureEmployees(rd);
  rd.step = "MANAGE_PEOPLE";
  await render(bot, chatId, s);
  return true;
}


    if (data.startsWith(cb.ROAD_TOGGLE_EMP)) {
      const employeeId = data.slice(cb.ROAD_TOGGLE_EMP.length);

      if (!c.roadActive || (c.phase !== "DAY" && c.phase !== "RETURN")) {
        await gate(TEXTS.roadFlow.errors.notActive);
        return true;
      }

      const inCar = c.inCarIds.includes(employeeId);

      if (!inCar) {
        const lock = empLocks.get(employeeId);
        if (lock && lock.carId !== carId && lock.foremanTgId !== foremanTgId) {
          await gate(TEXTS.roadFlow.errors.personInOtherCar.replace("{emp}", employeeId).replace("{car}", lock.carId));
          return true;
        }

        c.inCarIds.push(employeeId);
        c.members.push({ employeeId, joinedAt: nowISO() });
        lockEmp(employeeId, carId, foremanTgId, chatId);

        await appendEvents([
          {
            date,
            foremanTgId,
            type: "ROAD_PICKUP",
            objectId: "",
            carId,
            employeeIds: employeeId,
            payload: JSON.stringify({ phase: c.phase }),
            chatId,
            msgId,
            status: "АКТИВНА",
            refEventId: "",
            updatedAt: nowISO(),
          } as any,
        ]);

        await render(bot, chatId, s);
        return true;
      }

      c.inCarIds = c.inCarIds.filter((x) => x !== employeeId);
      const lastOpen = [...c.members].reverse().find((m) => m.employeeId === employeeId && !m.leftAt);
      if (lastOpen) lastOpen.leftAt = nowISO();
      unlockEmp(employeeId);

      await appendEvents([
        {
          date,
          foremanTgId,
          type: "ROAD_DROPOFF",
          objectId: "",
          carId,
          employeeIds: employeeId,
          payload: JSON.stringify({ phase: c.phase }),
          chatId,
          msgId,
          status: "АКТИВНА",
          refEventId: "",
          updatedAt: nowISO(),
        } as any,
      ]);

      await render(bot, chatId, s);
      return true;
    }

    // SAVE
    if (data === cb.SAVE) {
      if (!canSave(activeCarId, c)) {
        await gate(TEXTS.roadFlow.errors.needFinishAndOdoEnd);
        return true;
      }

      const riders = ridersFromMembers(c.members);
      const kmDay = Math.max(0, c.odoEndKm! - c.odoStartKm!);
      const tripClass = classifyTripByKm(kmDay);

      const amount =
        (await getSettingNumber(`ROAD_ALLOWANCE_${tripClass}`)) ??
        DEFAULT_ROAD_ALLOWANCE_BY_CLASS[tripClass];
      const perPerson = riders.length ? amount / riders.length : 0;

      const empsDict = await fetchEmployees();
      const nameById = (id: string) => {
        const e: any = (empsDict as any[]).find((x: any) => String(x.id ?? x.ID ?? x["ID"]) === id);
        return String(e?.name ?? e?.["ІМʼЯ"] ?? e?.["ІМ'Я"] ?? id);
      };

      await upsertOdometerDay({
        date,
        carId,
        foremanTgId,
        startValue: c.odoStartKm!,
        endValue: c.odoEndKm!,
        startPhoto: c.odoStartPhotoFileId ?? "",
        endPhoto: c.odoEndPhotoFileId ?? "",
        updatedAt: nowISO(),
      } as any);

      await upsertAllowanceRows(
        riders.map(
          (employeeId) =>
            ({
              date,
              foremanTgId,
              type: "ROAD_TRIP",
              employeeId,
              employeeName: nameById(employeeId),
              objectId: "ROAD",
              amount: perPerson,
              meta: JSON.stringify({
                kmDay,
                tripClass,
                carId,
                objectsCount: c.objectsCount,
                timeSec: calcSecondsByEmployee(c.members)[employeeId] ?? 0,
              }),
              dayStatus: "ЧЕРНЕТКА",
              updatedAt: nowISO(),
            } as any),
        ),
      );

      await bot.sendMessage(
        chatId,
        TEXTS.roadFlow.messages.saved
          .replace("{km}", String(kmDay))
          .replace("{class}", String(tripClass))
          .replace("{amount}", String(amount))
          .replace("{per}", perPerson.toFixed(2))
          .replace("{n}", String(riders.length)),
      );

      unlockCar(carId);
      unlockAllEmp(riders);

      rd.cars[carId] = makeNewCarState();
      rd.step = "START";
      await render(bot, chatId, s);
      return true;
    }

    return false;
  },
};
