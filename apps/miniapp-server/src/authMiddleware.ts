import type { Request, Response, NextFunction } from "express";
import { validateInitData, db, schema } from "@landscape/core";
import { eq } from "drizzle-orm";

export type AuthedUser = {
  tgId: number;
  pib: string;
  role: "ADMIN" | "BRIGADIER";
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

/**
 * The app has exactly two levels of access: admins, who approve days and see
 * the money, and everyone else, who fill in their own days. So the РОЛЬ column
 * in КОРИСТУВАЧІ only has to answer one question -- is this person an admin --
 * and anything that isn't one is a brigadier.
 *
 * Defaulting instead of rejecting is deliberate. The old version accepted only
 * an exact "АДМІН"/"БРИГАДИР" and locked out anything else, so a perfectly
 * legitimate job title in that column ("Керівник ландшафту") meant the person
 * simply could not open the app, with nothing on screen to explain why. Access
 * is still gated -- the row must exist in КОРИСТУВАЧІ and be АКТИВ -- this
 * only stops the wording of a job title from being a second, invisible gate.
 *
 * Matched on a word boundary rather than the whole cell, so "Адміністратор"
 * and "головний адмін" both grant admin. Admin is kept the narrow, explicit
 * side of the check: mistaking a brigadier for an admin would hand them
 * approval of payroll, while the reverse only costs them a button.
 */
export function normRole(v: string): "ADMIN" | "BRIGADIER" {
  const raw = v.trim().toUpperCase();
  return /(^|\s)(АДМІН|АДМИН|ADMIN)/.test(raw) ? "ADMIN" : "BRIGADIER";
}

/**
 * Validates the Telegram Mini App `initData` sent as a header, then checks
 * the user against the КОРИСТУВАЧІ dictionary (mirrored in Postgres) exactly
 * like the bot's hydrateAuth does — same access rules, same source of truth.
 */
export async function requireTelegramAuth(req: Request, res: Response, next: NextFunction) {
  const initData = req.header("x-telegram-init-data");
  if (!initData) {
    res.status(401).json({ error: "Missing X-Telegram-Init-Data header" });
    return;
  }

  const validated = validateInitData(initData);
  if (!validated) {
    res.status(401).json({ error: "Invalid or expired Telegram initData" });
    return;
  }

  const [row] = await db.select().from(schema.users).where(eq(schema.users.tgId, BigInt(validated.user.id))).limit(1);

  if (!row || !row.active) {
    res.status(403).json({ error: "Access denied: not in КОРИСТУВАЧІ or inactive" });
    return;
  }

  req.user = { tgId: Number(row.tgId), pib: row.pib, role: normRole(row.role) };
  next();
}
