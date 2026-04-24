// src/bot/flows/peopleTimesheet.types.ts
import type { FlowBaseState } from "../core/flowTypes.js";
import type { ObjectTS } from "./peopleTimesheet.utils.js";

export type Step =
  | "START"
  | "PICK_OBJECT"
  | "OBJECT_MENU"
  | "PICK_PEOPLE"
  | "WORKS_MENU"
  | "PICK_WORK"
  | "WORK_ASSIGN"
  | "RUN"
  | "MOVE_EMP_PICK"
  | "MOVE_EMP_TO_OBJ"
  | "RATE"
  | "PREVIEW";

export type DictWork = { id: string; name: string };

export type State = FlowBaseState & {
  step: Step;
  date: string;
  activeObjectId?: string;
  objects: Record<string, ObjectTS>;
  moveEmployeeId?: string;
};

export type Ts2Type =
  | "TS2_OBJ_START"
  | "TS2_OBJ_STOP"
  | "TS2_WORK_ADD"
  | "TS2_WORK_REMOVE"
  | "TS2_ASSIGN"
  | "TS2_UNASSIGN"
  | "TS2_WORK_START"
  | "TS2_WORK_STOP"
  | "TS2_EMP_MOVE"
  | "TS2_COEF_SET";

export type Ts2Row = {
  objectId: string;
  employeeId: string;
  sec: number;
  disciplineCoef: number;
  productivityCoef: number;
};