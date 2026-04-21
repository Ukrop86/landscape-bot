import TelegramBot from "node-telegram-bot-api";
import { config } from "./config.js";
import { onStart, handleCallback, handleMessage } from "./bot/wizard.js";

const bot = new TelegramBot(config.botToken, { polling: true });

bot.onText(/\/start/, async (msg) => {
  await onStart(bot, msg.chat.id);
});

bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/")) return; // щоб /start не дублювався
  await handleMessage(bot, msg);
});

bot.on("callback_query", async (q) => {
  await handleCallback(bot, q);
});

console.log("Bot is running (polling)...");
