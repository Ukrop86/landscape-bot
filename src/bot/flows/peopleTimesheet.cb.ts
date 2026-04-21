// src/bot/flows/peopleTimesheet.cb.ts
export const FLOW = "PEOPLE_TIMESHEET" as const;
export const PREFIX = "ts:" as const;

export const cb = {
  MENU: `${PREFIX}menu`,
  BACK: `${PREFIX}back:`,

  PICK_OBJECT: `${PREFIX}pick_obj`,
  OBJ: `${PREFIX}obj:`,

  PEOPLE: `${PREFIX}people`,
  WORKS: `${PREFIX}works`,
  RUN: `${PREFIX}run`,
  PREVIEW: `${PREFIX}preview`,

  TOGGLE_EMP: `${PREFIX}emp:`,
  DONE: `${PREFIX}done`,
  WORKS_DONE: `${PREFIX}works_done`,

  PICK_WORK: `${PREFIX}pick_work`,
  WORK: `${PREFIX}work:`,
  WORKS_REMOVE: `${PREFIX}work_remove:`,

  ASSIGN_MENU: `${PREFIX}assign_menu`,
  ASSIGN_EMP: `${PREFIX}assign_emp:`,
  ASSIGN_TOGGLE: `${PREFIX}assign_toggle:`,
  ASSIGN_DONE: `${PREFIX}assign_done`,

  START_OBJ: `${PREFIX}start_obj`,
  STOP_OBJ: `${PREFIX}stop_obj`,
  START_WORK: `${PREFIX}start_work:`,
  STOP_WORK: `${PREFIX}stop_work:`,
  MOVE_EMP: `${PREFIX}move_emp`,
  MOVE_PICK: `${PREFIX}move_pick:`,
  MOVE_TO: `${PREFIX}move_to:`,

  RATE: `${PREFIX}rate`,

  SET_COEF_DISC: `${PREFIX}coef_disc:`,
  SET_COEF_PROD: `${PREFIX}coef_prod:`,
  COEF_CUSTOM_DISC: `${PREFIX}coef_custom_disc:`,
  COEF_CUSTOM_PROD: `${PREFIX}coef_custom_prod:`,

  DISC_DEC: `${PREFIX}disc_dec:`,
  DISC_INC: `${PREFIX}disc_inc:`,
  PROD_DEC: `${PREFIX}prod_dec:`,
  PROD_INC: `${PREFIX}prod_inc:`,

  SAVE: `${PREFIX}save`,
} as const;