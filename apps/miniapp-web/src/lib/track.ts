import { api } from "./api";

/**
 * Журнал дій: що людина натиснула, на якому екрані і коли.
 * ТИМЧАСОВЕ, на час обкатки.
 *
 * Поставлено тому, що кожне розслідування впиралось в одне питання — «а що
 * саме вона натиснула?» — і відповіді не було ніде. Незданий день живе тільки
 * в телефоні, сервер бачить хіба підсумок. Тут видно послідовність.
 *
 * Три правила, які роблять це безпечним для роботи бригадира:
 *
 * 1. Нічого не блокує. Події складаються в чергу і йдуть пачкою раз на кілька
 *    секунд; жодне натискання не чекає на мережу.
 * 2. Помилки ковтаються мовчки. Телеметрія, яка показує бригадиру помилку —
 *    гірша за відсутню.
 * 3. Черга обмежена. Телефон без звʼязку не має роздувати памʼять — старі
 *    події просто випадають.
 */

type Ev = {
  id: string;
  ts: string;
  screen: string;
  step: string;
  kind: "click" | "screen" | "step" | "error";
  label: string;
  detail?: string;
};

const FLUSH_MS = 4000;
const MAX_QUEUE = 300;
const MAX_BATCH = 100;

/**
 * Журнал читає людина, а не програміст. `roadTimesheet/ODO_START` не каже
 * нічого навіть тому, хто писав код, — назви перекладаємо тут, на клієнті,
 * щоб у файл, лог і базу лягало вже зрозуміле.
 */
const SCREEN_NAMES: Record<string, string> = {
  menu: "Меню",
  roadTimesheet: "Дорожній табель",
  roadTimesheetRetro: "Внести день заднім числом",
  logistics: "Логістика",
  materials: "Матеріали",
  stats: "Статистика",
  tools: "Інструменти",
  approval: "Затвердження",
  adminOverview: "Поточні поїздки",
  actionLog: "Журнал дій",
};

const STEP_NAMES: Record<string, string> = {
  INDEX: "Головна",
  HUB: "Збирання поїздки",
  PICK_CAR: "Вибір авто",
  ODO_START: "Одометр на виїзд",
  PICK_PEOPLE: "Вибір людей",
  PICK_OBJECTS: "Вибір обʼєктів",
  PLAN: "План обʼєкта",
  PLAN_WORKS: "Роботи обʼєкта",
  PLAN_VOLUMES: "Обсяги робіт",
  READY: "Готові до виїзду",
  DRIVE: "У дорозі",
  ARRIVE_PICK: "Прибуття на обʼєкт",
  AT_OBJECT: "На обʼєкті",
  RETURN_PICKUP: "Забираємо людей",
  RETURN: "Повернення на базу",
  REVIEW: "Підсумок дня",
  DONE: "День зданий",
};

let queue: Ev[] = [];
let timer: number | null = null;
let ctx = { screen: "", step: "" };

/** Де користувач зараз. Викликається з екранів при зміні. */
export function setTrackContext(next: { screen?: string; step?: string }) {
  const before = `${ctx.screen} · ${ctx.step}`;
  const screen = next.screen ?? ctx.screen;
  const step = next.step ?? ctx.step;
  ctx = { screen: SCREEN_NAMES[screen] ?? screen, step: STEP_NAMES[step] ?? step };
  const after = `${ctx.screen} · ${ctx.step}`;
  // Підпис для запису про перехід — назва місця, куди прийшли. Раніше тут
  // дублювалась та сама пара, що вже стоїть у колонці екрана, і рядок
  // виглядав як службовий шум.
  if (after !== before) track("screen", ctx.step ? `→ ${ctx.step}` : `→ ${ctx.screen}`);
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function track(kind: Ev["kind"], label: string, detail?: string) {
  queue.push({ id: newId(), ts: new Date().toISOString(), screen: ctx.screen, step: ctx.step, kind, label: label.slice(0, 200), detail });
  // Найновіші події цінніші за найстаріші: коли щось щойно пішло не так,
  // дивляться в хвіст.
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  if (timer === null) timer = window.setTimeout(flush, FLUSH_MS);
}

export function flush() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (!queue.length) return;
  const batch = queue.slice(0, MAX_BATCH);
  queue = queue.slice(MAX_BATCH);
  api.post("/api/telemetry", { events: batch }).catch(() => {
    // Не вдалося — повертаємо в чергу, спробуємо наступного разу. Але без
    // нескінченного накопичення: обмеження черги вище зріже найстаріше.
    queue = [...batch, ...queue].slice(-MAX_QUEUE);
  });
  if (queue.length && timer === null) timer = window.setTimeout(flush, FLUSH_MS);
}

/**
 * Один слухач на весь застосунок замість виклику в кожній кнопці: інструментувати
 * сотні обробників руками — це і робота на день, і гарантія що десь забудеш.
 * Тут же фіксується рівно те, що людина бачила на кнопці.
 *
 * Слухаємо у фазі перехоплення, щоб запис стався навіть коли обробник кнопки
 * зупиняє подальше поширення події.
 */
/**
 * Підпис кнопки так, як його бачила людина.
 *
 * `textContent` склеює вкладені елементи впритул — «🚙Автоне обрано» замість
 * «🚙 Авто не обрано». `innerText` бере текст так, як він відрисуваний, з
 * переносами між рядками; лишається звести пробіли.
 *
 * Кнопка-іконка (сам 🗑) без підказки не каже нічого навіть тому, хто писав
 * екран, — тому для неї беремо `title`/`aria-label`.
 */
function labelOf(el: HTMLElement): string {
  const rendered = (el as HTMLElement & { innerText?: string }).innerText ?? el.textContent ?? "";
  const text = String(rendered).replace(/\s+/g, " ").trim();
  const hint = (el.getAttribute("title") || el.getAttribute("aria-label") || "").trim();
  if (hint && text.length <= 3) return text ? `${text} ${hint}` : hint;
  return text;
}

export function startTracking() {
  document.addEventListener(
    "click",
    (e) => {
      const el = (e.target as HTMLElement | null)?.closest("button, a, [role='button'], .cell, .chip");
      if (!el) return;
      const label = labelOf(el as HTMLElement);
      if (label) track("click", label);
    },
    true,
  );

  // Згорнули застосунок — віддаємо все, що назбиралось: інакше саме останні
  // дії перед проблемою і губляться.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", flush);

  window.addEventListener("error", (e) => track("error", String(e.message ?? "error").slice(0, 200)));
  window.addEventListener("unhandledrejection", (e) => track("error", String((e as PromiseRejectionEvent).reason ?? "rejection").slice(0, 200)));
}
