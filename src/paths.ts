import os from "os";
import path from "path";

/** Expand a leading ~ or ~/ to the user's home directory. */
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
