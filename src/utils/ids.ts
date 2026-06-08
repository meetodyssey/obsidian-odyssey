import { compactStamp } from "./time";

let lastStamp = "";
let sameStampCounter = 0;

export function makeId(prefix: string): string {
  const stamp = compactStamp();
  if (stamp === lastStamp) {
    sameStampCounter++;
  } else {
    lastStamp = stamp;
    sameStampCounter = 0;
  }
  const sequence = String(sameStampCounter).padStart(4, "0");
  return `${prefix}_${stamp}_${sequence}_${Math.random().toString(36).slice(2, 7)}`;
}
