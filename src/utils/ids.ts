import { compactStamp } from "./time";

export function makeId(prefix: string): string {
  return `${prefix}_${compactStamp()}_${Math.random().toString(36).slice(2, 7)}`;
}
