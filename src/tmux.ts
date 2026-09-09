import { targetSlot, type GroveTarget } from "./target.js";

export function tmuxSessionName(target: GroveTarget): string {
  return `${target.projectName}-${targetSlot(target)}`;
}
