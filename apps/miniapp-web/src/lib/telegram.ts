// Thin wrapper around the Telegram Mini App JS SDK (window.Telegram.WebApp).
// Falls back to no-ops when running in a plain browser during development.
import { useEffect } from "react";

type WebAppUser = { id: number; first_name?: string; username?: string };
type ImpactStyle = "light" | "medium" | "heavy" | "rigid" | "soft";
type NotificationType = "error" | "success" | "warning";

interface TelegramWebApp {
  initData: string;
  initDataUnsafe: { user?: WebAppUser };
  ready(): void;
  expand(): void;
  colorScheme: "light" | "dark";
  MainButton: {
    text: string;
    show(): void;
    hide(): void;
    onClick(cb: () => void): void;
    offClick(cb: () => void): void;
    setText(text: string): void;
    showProgress(leaveActive?: boolean): void;
    hideProgress(): void;
    disable(): void;
    enable(): void;
  };
  BackButton: {
    show(): void;
    hide(): void;
    onClick(cb: () => void): void;
    offClick(cb: () => void): void;
  };
  HapticFeedback?: {
    impactOccurred(style: ImpactStyle): void;
    notificationOccurred(type: NotificationType): void;
    selectionChanged(): void;
  };
  showConfirm?(message: string, callback: (confirmed: boolean) => void): void;
  showAlert?(message: string, callback?: () => void): void;
  showPopup?(
    params: { title?: string; message: string; buttons?: Array<{ id?: string; type?: "default" | "ok" | "close" | "cancel" | "destructive"; text?: string }> },
    callback?: (buttonId: string) => void,
  ): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

export function getWebApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null;
}

export function initTelegramApp() {
  const webApp = getWebApp();
  webApp?.ready();
  webApp?.expand();
}

export function getInitData(): string {
  return getWebApp()?.initData ?? "";
}

export function getInitDataUser(): WebAppUser | null {
  return getWebApp()?.initDataUnsafe?.user ?? null;
}

// Native Telegram confirm dialog when available; some Telegram WebViews
// silently block window.confirm (the tap just does nothing), so prefer the
// SDK's own dialog and fall back to window.confirm for plain-browser dev.
export function confirmDialog(message: string): Promise<boolean> {
  const webApp = getWebApp();
  if (webApp?.showConfirm) {
    return new Promise((resolve) => webApp.showConfirm!(message, resolve));
  }
  return Promise.resolve(window.confirm(message));
}

/**
 * A statement, not a question: something is not allowed and here is why.
 *
 * Kept apart from confirmDialog on purpose -- offering OK/Cancel for a rule
 * the app will not bend either way reads as a choice that does not exist.
 */
export function alertDialog(message: string): Promise<void> {
  const webApp = getWebApp();
  if (webApp?.showAlert) {
    return new Promise((resolve) => webApp.showAlert!(message, () => resolve()));
  }
  if (webApp?.showPopup) {
    return new Promise((resolve) =>
      webApp.showPopup!({ message, buttons: [{ id: "ok", type: "default", text: "Зрозуміло" }] }, () => resolve()),
    );
  }
  window.alert(message);
  return Promise.resolve();
}

/**
 * A yes/no question with the buttons SPELLED OUT.
 *
 * showConfirm renders Telegram's own OK/Cancel, which is fine for "are you
 * sure?" but wrong for a real question -- "Почати роботи з бригадиром?" with
 * an "OK" button leaves the foreman guessing what OK agreed to. showPopup lets
 * the buttons say Так and Ні. Older clients without showPopup fall back to the
 * confirm dialog, where OK still means "так".
 */
export function askDialog(message: string, yes = "Так", no = "Ні", title?: string): Promise<boolean> {
  const webApp = getWebApp();
  if (webApp?.showPopup) {
    return new Promise((resolve) =>
      webApp.showPopup!(
        {
          ...(title ? { title } : {}),
          message,
          // BOTH buttons are type "default" on purpose. Telegram renders a
          // "cancel" button with its own localised label ("Скасувати") and
          // throws the given text away -- which turned a Так/Ні question into
          // Так/Скасувати. Only "default" keeps the words we wrote.
          buttons: [
            { id: "yes", type: "default", text: yes },
            { id: "no", type: "default", text: no },
          ],
        },
        // Dismissing the popup (swipe, back) yields no button id, and that
        // must mean "ні" -- never a silent yes.
        (buttonId) => resolve(buttonId === "yes"),
      ),
    );
  }
  return confirmDialog(message);
}

// Small tactile feedback on toggles/confirmations -- no-ops outside Telegram
// (plain browser dev, or old client versions without HapticFeedback).
export function haptic(kind: ImpactStyle | NotificationType | "selection" = "light") {
  const feedback = getWebApp()?.HapticFeedback;
  if (!feedback) return;
  if (kind === "selection") feedback.selectionChanged();
  else if (kind === "error" || kind === "success" || kind === "warning") feedback.notificationOccurred(kind);
  else feedback.impactOccurred(kind);
}

// Wires Telegram's native hardware/gesture back button to the same handler
// used by the in-app "‹ Назад" row, so swiping back doesn't accidentally
// exit the whole mini app instead of going up one menu level. Pass null to
// hide the button (e.g. on the top-level screen).
export function useTelegramBackButton(onBack: (() => void) | null) {
  useEffect(() => {
    const webApp = getWebApp();
    if (!webApp) return;
    if (!onBack) {
      webApp.BackButton.hide();
      return;
    }
    webApp.BackButton.show();
    webApp.BackButton.onClick(onBack);
    return () => {
      webApp.BackButton.offClick(onBack);
      webApp.BackButton.hide();
    };
  }, [onBack]);
}
