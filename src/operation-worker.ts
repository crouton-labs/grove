import { applyExistingCheckoutSetup } from "./setup.js";
import { applyRef } from "./state.js";
import type { GroveExecutionContext } from "./context.js";
import type { GroveRepoConfig } from "./config.js";
import type { GroveSettings } from "./settings.js";
import type { StateRef } from "./state.js";
import type { GroveProjectConfig, PortDef } from "./types.js";

type OperationMessage =
  | {
    kind: "apply";
    source: string;
    target: string;
    config: GroveRepoConfig | null;
    ports: Record<string, PortDef>;
    configFile: string;
    context: GroveExecutionContext;
    settings: GroveSettings;
  }
  | {
    kind: "restore";
    project: GroveProjectConfig;
    ref: StateRef;
    dest: GroveExecutionContext;
    ignoreFingerprint: boolean;
  };

let receivedWork = false;
process.once("message", (message: OperationMessage) => {
  receivedWork = true;
  try {
    if (message.kind === "apply") {
      applyExistingCheckoutSetup(
        message.source,
        message.target,
        message.config,
        message.ports,
        message.configFile,
        message.context,
        message.settings,
      );
    } else {
      applyRef(message.project, message.ref, message.dest, message.ignoreFingerprint);
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    process.disconnect();
  }
});

process.once("disconnect", () => {
  if (!receivedWork) process.exit(1);
});
