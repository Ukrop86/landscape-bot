import type TelegramBot from "node-telegram-bot-api";
import { TEXTS } from "../texts.js";

// =========================
// Types (тільки для цього флоу)
// =========================

export type WorkItem = { workId: string; name: string };

export type OpenSession = {
  objectId: string;
  workId: string;
  employeeId: string;
  startedAt: string;
};

export type ObjPhase = "SETUP" | "RUN" | "FINISHED";

export type ObjectTS = {
  phase: ObjPhase;
  objectId: string;
  employeeIds: string[];
  works: WorkItem[];
  assigned: Record<string, string[]>;
  open: OpenSession[];
  startedAt?: string;
  endedAt?: string;
  coefDiscipline: Record<string, number>;
  coefProductivity: Record<string, number>;
};

export type StateLike = {
  activeObjectId?: string;
  objects: Record<string, ObjectTS>;
};

// =========================
// Object helpers
// =========================

export function ensureObject(st: StateLike, objectId: string): ObjectTS {
  st.objects ??= {};
  if (!st.objects[objectId]) {
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
  }
  return st.objects[objectId];
}

export function getActive(st: StateLike) {
  const id = st.activeObjectId;
  if (!id) return null;
  return { objectId: id, obj: ensureObject(st, id) };
}

export function workNameById(obj: ObjectTS, workId: string) {
  return obj.works.find((w) => w.workId === workId)?.name ?? workId;
}

export function empNamesLine(ids: string[], emps: { id: string; name: string }[]) {
  const map = new Map(emps.map((e) => [String(e.id), e.name]));
  if (!ids.length) return "—";
  return ids.map((id) => map.get(String(id)) ?? id).join(", ");
}

// =========================
// Open sessions helpers
// =========================

export function openKey(s: OpenSession) {
  return `${s.employeeId}||${s.workId}||${s.objectId}`;
}

export function findOpen(obj: ObjectTS, employeeId: string, workId: string) {
  return obj.open.find(
    (x) =>
      x.employeeId === employeeId &&
      x.workId === workId &&
      x.objectId === obj.objectId
  );
}

export function closeAllOpenForEmployee(obj: ObjectTS, employeeId: string): OpenSession[] {
  const out: OpenSession[] = [];
  const still: OpenSession[] = [];
  for (const s of obj.open) {
    if (s.employeeId === employeeId && s.objectId === obj.objectId) out.push(s);
    else still.push(s);
  }
  obj.open = still;
  return out;
}

export function closeAllOpen(obj: ObjectTS): OpenSession[] {
  const out = [...obj.open];
  obj.open = [];
  return out;
}

// =========================
// Input helper (можна залишити тут)
// =========================

type PendingInput = {
  chatId: number;
  fromId: number;
  createdAt: number;
  timer: NodeJS.Timeout;
  listener: (msg: TelegramBot.Message) => Promise<void>;
};

const pendingInputs = new Map<string, PendingInput>();

export function clearPending(chatId: number, fromId: number, bot?: TelegramBot) {
  const key = `${chatId}:${fromId}`;
  const p = pendingInputs.get(key);
  if (!p) return;
  clearTimeout(p.timer);
  if (bot) bot.removeListener("message", p.listener as any);
  pendingInputs.delete(key);
}

export async function askNextMessage(
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
    if (msg.chat?.id !== chatId) return;
    if (msg.from?.id !== fromId) return;

    const raw = (msg.text ?? "").toString().trim();
    if (!raw) return;

    clearPending(chatId, fromId, bot);
    await onNext(msg);
  };

  const timer = setTimeout(() => {
    clearPending(chatId, fromId, bot);
    bot.sendMessage(chatId, TEXTS.ui.errors.timeout);
  }, timeoutMs);

  pendingInputs.set(key, { chatId, fromId, createdAt: Date.now(), timer, listener });
  bot.on("message", listener);
}