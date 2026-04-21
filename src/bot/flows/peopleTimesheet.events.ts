// src/bot/flows/peopleTimesheet.events.ts
import type TelegramBot from "node-telegram-bot-api";
import { appendEvents } from "../../google/sheets/working.js";
import { getDayStatusRow } from "../../google/sheets/checklist.js";
import { makeEventId, nowISO } from "../../google/sheets/utils.js";
import { isLocked } from "../core/helpers.js";
import type { Ts2Type } from "./peopleTimesheet.types.js";

export async function writeTs2Event(args: {
  bot: TelegramBot;
  chatId: number;
  msgId: number;
  date: string;
  foremanTgId: number;
  objectId: string;
  type: Ts2Type;
  employeeIds?: string[];
  payload?: any;
}) {
  const ds = await getDayStatusRow(args.date, args.objectId, args.foremanTgId);
  if (isLocked(ds?.status)) {
    await args.bot.sendMessage(args.chatId, `🔒 День уже ${ds?.status}. Редагування табеля недоступне.`);
    return null;
  }

  const evId = makeEventId("TS2");
  const t = nowISO();
 
  await appendEvents([
    {
      eventId: evId,
      status: "АКТИВНА",
      ts: t,
      date: args.date,
      foremanTgId: args.foremanTgId,
      type: args.type,
      objectId: args.objectId,
      carId: "",
      employeeIds: (args.employeeIds ?? []).join(","),
      payload: args.payload ? JSON.stringify(args.payload) : "",
      chatId: args.chatId,
      msgId: args.msgId,
      refEventId: "",
      updatedAt: t,
    } as any,
  ]);

  return evId;
}