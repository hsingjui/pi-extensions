import { buildCompactUrl } from "../src/runtime.ts";

const baseUrl = process.env.OPENAI_BASE_URL?.trim();
const apiKey = process.env.OPENAI_API_KEY?.trim();
const model = process.env.OPENAI_MODEL?.trim();
const selectedVariant = process.argv.slice(2).find((argument) => argument !== "--") ?? "all";

if (!baseUrl || !apiKey || !model) {
	console.error("Required: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL");
	process.exit(2);
}

const variants = {
	base: {},
	key: { prompt_cache_key: "pi-oai-compact-api-test" },
	retention: {
		prompt_cache_key: "pi-oai-compact-api-test",
		prompt_cache_retention: "24h",
	},
} as const;

if (selectedVariant !== "all" && !(selectedVariant in variants)) {
	console.error("Variant must be one of: all, base, key, retention");
	process.exit(2);
}

const stablePrefix = "Stable prompt-cache prefix for the pi-oai-compact endpoint test. ".repeat(400);
const input = [
	{ role: "developer", content: stablePrefix },
	{ role: "user", content: "Remember that the project name is pi-oai-compact." },
	{ role: "assistant", content: "The project name is pi-oai-compact." },
];
const responsesUrl = buildCompactUrl(baseUrl).replace(/\/compact$/, "");
const selected = Object.entries(variants).filter(([name]) => selectedVariant === "all" || name === selectedVariant);

console.log(`Endpoint: ${responsesUrl}`);
console.log(`Model: ${model}`);
console.log(`Variants: ${selected.map(([name]) => name).join(", ")} (${selected.length * 2} billable request(s))`);
console.log(`Stable input prefix: ${stablePrefix.length} characters`);

let failed = false;
const runCounts = new Map<string, number>();
const cacheResults = new Map<string, unknown[]>();
for (const [name, extra] of [...selected, ...selected]) {
	const run = (runCounts.get(name) ?? 0) + 1;
	runCounts.set(name, run);
	const body = {
		model,
		input: [...input, { type: "compaction_trigger" }],
		stream: true,
		...extra,
	};
	console.log(`\n[${name} #${run}] request fields: ${Object.keys(body).join(", ")}`);

	try {
		const response = await fetch(responsesUrl, {
			method: "POST",
			headers: {
				accept: "text/event-stream",
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
				"x-codex-beta-features": "remote_compaction_v2",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(60_000),
		});
		const responseText = await response.text();
		const events = responseText
			.replace(/\r\n/g, "\n")
			.split(/\n\n+/)
			.flatMap((frame) => {
				const data = frame.split("\n").find((line) => line.startsWith("data:"))?.slice("data:".length).trim();
				if (!data || data === "[DONE]") return [];
				try {
					return [JSON.parse(data) as Record<string, unknown>];
				} catch {
					return [];
				}
			});
		let responseBody: unknown = responseText;
		try {
			responseBody = JSON.parse(responseText);
		} catch {
			// Successful remote compaction v2 responses are SSE.
		}

		console.log(`[${name} #${run}] HTTP ${response.status} ${response.statusText}`);
		const requestId = response.headers.get("x-request-id");
		if (requestId) console.log(`[${name} #${run}] x-request-id: ${requestId}`);
		const failedEvent = events.find((event) => event.type === "response.failed");
		if (!response.ok || failedEvent) {
			failed = true;
			console.log(JSON.stringify(failedEvent ?? responseBody, null, 2));
			continue;
		}

		const completed = [...events].reverse().find((event) => event.type === "response.completed");
		const completedResponse = completed?.response as Record<string, unknown> | undefined;
		const usage = completedResponse?.usage as Record<string, unknown> | undefined;
		const inputDetails = usage?.input_tokens_details as Record<string, unknown> | undefined;
		const cachedTokens = inputDetails?.cached_tokens;
		cacheResults.set(name, [...(cacheResults.get(name) ?? []), cachedTokens]);
		console.log(JSON.stringify({
			eventTypes: events.map((event) => event.type),
			outputTypes: events
				.filter((event) => event.type === "response.output_item.done")
				.map((event) => (event.item as Record<string, unknown> | undefined)?.type),
			id: completedResponse?.id,
			status: completedResponse?.status,
			cachedTokens,
			usage,
		}, null, 2));
	} catch (error) {
		failed = true;
		console.error(`[${name} #${run}] ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
	}
}

console.log("\nCache comparison (first, second cached_tokens):");
for (const [name, values] of cacheResults) {
	console.log(`${name}: ${values.map((value) => value ?? "unreported").join(", ")}`);
}

if (failed) process.exitCode = 1;
