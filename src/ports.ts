import net from "net";
import { PortDef } from "./types.js";

export function computePort(def: PortDef, slot: number): number {
  return def.base + slot * def.offset;
}

export function computePorts(
  defs: Record<string, PortDef>,
  slot: number,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [name, def] of Object.entries(defs)) {
    result[name] = computePort(def, slot);
  }
  return result;
}

/**
 * The largest usable instance slot. A project without declared ports has no
 * port-derived upper bound, represented by Infinity.
 */
export function maxSlot(defs: Record<string, PortDef>): number {
  const entries = Object.entries(defs);
  if (entries.length === 0) return Infinity;

  let upper = Infinity;
  for (const [name, def] of entries) {
    if (!Number.isInteger(def.base) || !Number.isInteger(def.offset) || def.base < 1 || def.base > 65535 || def.offset < 0) {
      throw new Error(`port ${name} must use an integer base from 1 to 65535 and a non-negative integer offset`);
    }
    if (def.offset === 0) return 0;
    upper = Math.min(upper, Math.floor((65535 - def.base) / def.offset));
  }

  const assigned = new Set<number>();
  for (let slot = 0; slot <= upper; slot++) {
    for (const [, def] of entries) {
      const port = computePort(def, slot);
      if (assigned.has(port)) return Math.max(0, slot - 1);
      assigned.add(port);
    }
  }
  return upper;
}

export function formatSlotCap(cap: number): string {
  return Number.isFinite(cap) ? String(cap) : "unbounded";
}

export function checkPort(port: number, timeout = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, "127.0.0.1");
  });
}
