import assert from "node:assert/strict";
import { buildCompactUrl } from "../src/runtime.ts";

const baseUrl = process.env.OPENAI_BASE_URL?.trim();
const apiKey = process.env.OPENAI_API_KEY?.trim();
const model = process.env.OPENAI_MODEL?.trim();

if (!baseUrl || !apiKey || !model) {
	console.error("Required: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL");
	process.exit(2);
}

const prefixCharacters = Number.parseInt(process.env.OPENAI_CACHE_PREFIX_CHARS ?? "260000", 10);
if (!Number.isFinite(prefixCharacters) || prefixCharacters < 10000) {
	console.error("OPENAI_CACHE_PREFIX_CHARS must be an integer >= 10000");
	process.exit(2);
}

const cacheKey = process.env.OPENAI_PROMPT_CACHE_KEY?.trim() || `pi-oai-compact-prefix-${Date.now()}`;
const prefixSeed = "Stable full-prefix cache probe. Preserve this exact text and every request field. ";
const stablePrefix = prefixSeed.repeat(Math.ceil(prefixCharacters / prefixSeed.length)).slice(0, prefixCharacters);
const responsesUrl = buildCompactUrl(baseUrl).replace(/\/compact$/, "");

const normalPayload = {
	model,
	input: [
		{ role: "developer", content: stablePrefix },
		{ role: "user", content: "Reply with OK only." },
	],
	tools: [
		{
			type: "function",
			name: "cache_probe",
			description: "A stable tool definition used only to verify full-prefix caching.",
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			strict: true,
		},
	],
	tool_choice: "none",
	parallel_tool_calls: true,
	reasoning: { effort: process.env.OPENAI_REASONING_EFFORT?.trim() || "low", summary: "auto" },
	text: { format: { type: "text" }, verbosity: "low" },
	service_tier: process.env.OPENAI_SERVICE_TIER?.trim() || "default",
	prompt_cache_key: cacheKey,
	store: false,
	stream: true,
	max_output_tokens: 256,
};
const compactionTrigger = { type: "compaction_trigger" } as const;
const compactPayload = {
	...structuredClone(normalPayload),
	input: [...structuredClone(normalPayload.input), compactionTrigger],
};

const { input: normalInput, ...normalTopLevel } = normalPayload;
const { input: compactInput, ...compactTopLevel } = compactPayload;
assert.deepEqual(compactTopLevel, normalTopLevel, "compact top-level fields drifted from normal payload");
assert.deepEqual(compactInput.slice(0, -1), normalInput, "compact input is not the complete normal input prefix");
assert.deepEqual(compactInput.at(-1), compactionTrigger, "compact input does not end with compaction_trigger");

function parseSseEvents(responseText: string): Record<string, unknown>[] {
	return responseText
		.replace(/\r\n/g, "\n")
		.split(/\n\n+/)
		.flatMap((frame) => {
			const data = frame
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice("data:".length).trimStart())
				.join("\n")
				.trim();
			if (!data || data === "[DONE]") return [];
			try {
				return [JSON.parse(data) as Record<string, unknown>];
			} catch {
				return [];
			}
		});
}

async function send(label: "normal" | "compact", payload: typeof normalPayload | typeof compactPayload) {
	const response = await fetch(responsesUrl, {
		method: "POST",
		headers: {
			accept: "text/event-stream",
			authorization: `Bearer ${apiKey}`,
			"content-type": "application/json",
			"x-codex-beta-features": "remote_compaction_v2",
		},
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(120_000),
	});
	const responseText = await response.text();
	const events = parseSseEvents(responseText);
	const failedEvent = events.find((event) => event.type === "response.failed");
	if (!response.ok || failedEvent) {
		throw new Error(`${label} failed: HTTP ${response.status} ${response.statusText}\n${JSON.stringify(failedEvent ?? responseText, null, 2)}`);
	}

	const completed = [...events].reverse().find((event) => event.type === "response.completed");
	const completedResponse = completed?.response as Record<string, unknown> | undefined;
	const usage = completedResponse?.usage as Record<string, unknown> | undefined;
	const inputDetails = usage?.input_tokens_details as Record<string, unknown> | undefined;
	const inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined;
	const cachedTokens = typeof inputDetails?.cached_tokens === "number" ? inputDetails.cached_tokens : 0;
	const requestId = response.headers.get("x-request-id");

	console.log(`${label}: HTTP ${response.status}, input_tokens=${inputTokens ?? "unreported"}, cached_tokens=${cachedTokens}, request_id=${requestId ?? "unreported"}`);
	return { inputTokens, cachedTokens };
}

console.log(`Endpoint: ${responsesUrl}`);
console.log(`Model: ${model}`);
console.log(`Cache key: ${cacheKey}`);
console.log(`Stable prefix: ${stablePrefix.length} characters`);
console.log("Payload parity: PASS (all top-level fields and the complete input prefix match)");
console.log("Billable requests: 2\n");

const normal = await send("normal", normalPayload);
const compact = await send("compact", compactPayload);
const hitRate = compact.inputTokens ? (compact.cachedTokens / compact.inputTokens) * 100 : undefined;

if (compact.cachedTokens > 0) {
	console.log(`\nCache result: HIT (${compact.cachedTokens} tokens${hitRate === undefined ? "" : `, ${hitRate.toFixed(1)}% of compact input`})`);
} else {
	console.warn("\nCache result: MISS. Payload parity passed; retry to distinguish cache routing/expiry from request drift.");
	if (process.env.STRICT_CACHE_HIT === "1") process.exitCode = 1;
}

if (normal.cachedTokens > 0) {
	console.log(`Note: normal request already read ${normal.cachedTokens} cached tokens; use a fresh cache key for an uncontaminated write-then-read run.`);
}
