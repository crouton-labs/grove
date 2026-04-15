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
