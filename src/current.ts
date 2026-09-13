import fs from "fs";
import path from "path";
import { GROVE_DIR } from "./registry.js";

export const CURRENT_PATH = path.join(GROVE_DIR, "current.json");

interface CurrentInstance {
  version: 1;
  current: string;
}

export function loadCurrent(): string | null {
  if (!fs.existsSync(CURRENT_PATH)) return null;
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(CURRENT_PATH, "utf-8"));
  } catch (error) {
    throw new Error(`${CURRENT_PATH} is not valid JSON: ${(error as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${CURRENT_PATH} must be an object with version 1 and current`);
  }
  const current = value as Partial<CurrentInstance>;
  if (current.version !== 1 || typeof current.current !== "string" || !current.current) {
    throw new Error(`${CURRENT_PATH} must contain { "version": 1, "current": "<project>/<name>" }`);
  }
  return current.current;
}

export function saveCurrent(current: string): void {
  fs.mkdirSync(GROVE_DIR, { recursive: true });
  fs.writeFileSync(CURRENT_PATH, JSON.stringify({ version: 1, current }, null, 2) + "\n");
}

export function clearCurrent(): void {
  fs.rmSync(CURRENT_PATH, { force: true });
}
