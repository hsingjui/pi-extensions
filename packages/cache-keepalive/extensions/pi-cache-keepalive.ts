import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type CacheKeepAliveConfig = {
	enabled?: boolean;
	force?: boolean;
	notify?: boolean;
	models?: Record<string, number>;
};

type MutableModel = {
	provider: string;
	id: string;
	promptCache?: { short?: number; long?: number };
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function loadConfig(): CacheKeepAliveConfig {
	try {
		const settings = JSON.parse(readFileSync(path.join(getAgentDir(), "settings.json"), "utf8")) as unknown;
		if (isRecord(settings) && isRecord(settings.cacheKeepAlive)) {
			return settings.cacheKeepAlive as CacheKeepAliveConfig;
		}
	} catch {
		// Use defaults when settings.json is unavailable or invalid.
	}
	return {};
}

function globMatches(pattern: string, value: string): boolean {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`).test(value);
}

function getConfiguredTtl(config: CacheKeepAliveConfig, model: MutableModel): number | undefined {
	const models = config.models;
	if (!models) return undefined;

	const keys = [`${model.provider}/${model.id}`, model.id];
	for (const key of keys) {
		const seconds = models[key];
		if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 10) return seconds;
	}
	for (const [pattern, seconds] of Object.entries(models)) {
		if (
			typeof seconds === "number" &&
			Number.isFinite(seconds) &&
			seconds > 10 &&
			keys.some((key) => globMatches(pattern, key))
		) {
			return seconds;
		}
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	if (config.enabled === false) return;

	function applyConfiguredTtl(model: MutableModel | undefined): void {
		if (!model) return;
		const ttl = getConfiguredTtl(config, model);
		if (ttl === undefined) return;

		// Pi's built-in CacheWarmer schedules from these model metadata values.
		// ponytail: use the model metadata hook; replace with a public TTL setter if Pi adds one.
		model.promptCache = { ...model.promptCache, short: ttl, long: ttl };
	}

	pi.on("model_select", (event) => applyConfiguredTtl(event.model as MutableModel));
	pi.on("before_agent_start", (_event, ctx) => applyConfiguredTtl(ctx.model as MutableModel | undefined));

	pi.on("cache_warming_decision", (event, ctx) => {
		const model = ctx.model as MutableModel | undefined;
		if (!model) return { action: "stop" as const };
		if (config.models && getConfiguredTtl(config, model) === undefined) {
			return { action: "stop" as const };
		}

		const action = config.force === false ? event.action : "warm";
		if (action === "warm" && config.notify !== false) {
			ctx.ui.notify(`缓存保持请求已触发：${model.id}（maxTokens=1）`, "info");
		}
		return { action };
	});
}
