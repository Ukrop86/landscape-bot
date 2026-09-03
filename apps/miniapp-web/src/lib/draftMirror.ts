import { api } from "./api";

/**
 * Дзеркало чернетки на сервері.
 *
 * Телефон лишається робочою копією: він працює без звʼязку, і день ведеться
 * саме там. Сюди йде знімок, з відставанням у кілька секунд.
 *
 * Навіщо: до цього незданий день не існував ніде, крім одного телефона. Коли
 * один такий день поїхав учорашньою датою, перевірити було нічим — ні адмін
 * не бачив, ні я не міг подивитись. Тепер бачить сервер.
 *
 * Ті самі три правила, що й для журналу дій: нічого не блокує, помилки
 * ковтаються мовчки, і невдала синхронізація ніяк не впливає на день. Дзеркало,
 * яке заважає роботі, гірше за відсутнє.
 */

const PUSH_DELAY_MS = 5000;

let timer: number | null = null;
let pending: Record<string, unknown> | null = null;
let lastSent = "";

/** Надіслати знімок. Кілька змін підряд згортаються в одну відправку. */
export function mirrorDraft(snapshot: {
  date: string;
  step: string;
  carId: string;
  employeeIds: string[];
  objectNames: string[];
  tripStartedAt: string | null;
  payload: unknown;
}) {
  pending = snapshot;
  if (timer !== null) return;
  timer = window.setTimeout(() => {
    timer = null;
    const body = pending;
    pending = null;
    if (!body) return;
    // Нічого не змінилось -- нема чого і слати: таймери перемальовують екран
    // щосекунди, і без цього ми б лупили в сервер на кожен тік.
    const fingerprint = JSON.stringify(body);
    if (fingerprint === lastSent) return;
    lastSent = fingerprint;
    api.put("/api/drafts", body).catch(() => {
      // Не вийшло -- нехай: локальна чернетка ціла, наступна зміна надішле знову.
      lastSent = "";
    });
  }, PUSH_DELAY_MS);
}

/** День здали або скинули -- дзеркалу тут більше нічого показувати. */
export function clearMirroredDraft() {
  lastSent = "";
  api.del("/api/drafts").catch(() => {});
}

/** Чернетка з сервера. Потрібна, коли на телефоні порожньо, а день був. */
export async function fetchMirroredDraft<T>(): Promise<{ payload: T; updatedAt: string } | null> {
  try {
    const res = await api.get<{ found: boolean; payload: T; updatedAt: string }>("/api/drafts/mine");
    return res.found && res.payload ? { payload: res.payload, updatedAt: res.updatedAt } : null;
  } catch {
    return null;
  }
}
