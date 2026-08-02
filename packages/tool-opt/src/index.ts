import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerBashDefaultTimeout } from "./bash-timeout.js";
import { createReadToolDefinition } from "./read-tool.js";

export default function (pi: ExtensionAPI) {
	registerBashDefaultTimeout(pi);
	pi.registerTool(createReadToolDefinition(process.cwd()));
}
