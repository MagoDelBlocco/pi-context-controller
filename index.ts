import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scaffoldConfig } from "./src/config";
import { registerBeforeCompactHook } from "./src/hooks/before-compact";
import { registerRecallTool } from "./src/tools/recall";
import { registerContextControllerCommand } from "./src/commands/context-controller";
import { registerCcRecallCommand } from "./src/commands/cc-recall";

export default function (pi: ExtensionAPI) {
	// Ensure config file exists with defaults
	scaffoldConfig();

	// Register compaction hook
	registerBeforeCompactHook(pi);

	// Register recall tool (LLM-callable)
	registerRecallTool(pi);

	// Register slash commands
	registerContextControllerCommand(pi);
	registerCcRecallCommand(pi);
}
