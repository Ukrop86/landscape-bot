/**
 * Тап проти прокрутки.
 *
 * Рядок списку -- звичайна кнопка, і на телефоні вона спрацьовує від двох
 * речей, які людина натисканням не вважає: коротка протяжка пальцем (палець
 * зрушив, але браузер усе одно віддав клік) і тап, яким гасять інерцію
 * списку, що ще їде. У довгому списку робіт це коштувало бригадиру семи
 * робіт, які вона не обирала, -- вони мовчки опинились у дні, і побачила
 * вона це аж на здачі звіту.
 *
 * Тут два фільтри, обидва невидимі для справжнього тапу:
 *  - палець зрушив далі за `MOVE_TOLERANCE_PX` між дотиком і кліком;
 *  - клік прийшов раніше за `SCROLL_QUIET_MS` після останньої прокрутки
 *    (саме таким і є тап, що зупиняє інерцію).
 *
 * Ціна помилки несиметрична, і поріг обрано з цього: пропущений тап людина
 * бачить одразу й повторює, а зайвий вибір ніхто не помічає до вечора.
 */
const MOVE_TOLERANCE_PX = 10;
const SCROLL_QUIET_MS = 150;

let downX = 0;
let downY = 0;
let hasDown = false;
let lastScrollAt = 0;

if (typeof window !== "undefined") {
  // capture: прокрутка йде у внутрішньому контейнері, не у window.
  window.addEventListener(
    "scroll",
    () => {
      lastScrollAt = Date.now();
    },
    { capture: true, passive: true },
  );
}

/**
 * Props для кнопки, натискання якої має щось змінити в дні.
 * `<button {...tapProps(() => toggleWork(...))}>` замість `onClick`.
 */
export function tapProps(onTap: () => void) {
  return {
    onPointerDown: (e: { clientX: number; clientY: number }) => {
      downX = e.clientX;
      downY = e.clientY;
      hasDown = true;
    },
    onClick: (e: { clientX: number; clientY: number }) => {
      const moved = hasDown ? Math.hypot(e.clientX - downX, e.clientY - downY) : 0;
      hasDown = false;
      // Клавіатура/скрінрідер дають клік без координат -- там (0,0), і
      // перевірку руху для них треба пропустити, а не завалити.
      if (e.clientX !== 0 && e.clientY !== 0 && moved > MOVE_TOLERANCE_PX) return;
      if (Date.now() - lastScrollAt < SCROLL_QUIET_MS) return;
      onTap();
    },
  };
}
