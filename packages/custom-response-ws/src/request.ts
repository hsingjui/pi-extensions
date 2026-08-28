import { isDeepStrictEqual } from "node:util";
import { PI_USER_AGENT } from "./constants.js";
import type { CachedConnection, ContinuationState, RequestBody } from "./types.js";

export function requestUrl(input: string | URL | Request): string {
	return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

export function resolveWebSocketUrl(input: string | URL | Request): string {
	const url = new URL(requestUrl(input));
	if (url.protocol === "https:") url.protocol = "wss:";
	else if (url.protocol === "http:") url.protocol = "ws:";
	if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		throw new Error(`Unsupported WebSocket protocol: ${url.protocol}`);
	}
	return url.toString();
}

export function responsesWebSocketUrl(baseUrl: string): string {
	const url = new URL(baseUrl);
	url.pathname = url.pathname.replace(/\/+$/, "") || "/";
	if (!url.pathname.endsWith("/responses")) {
		url.pathname = `${url.pathname.replace(/\/+$/, "")}/responses`;
	}
	if (url.protocol === "https:") url.protocol = "wss:";
	else if (url.protocol === "http:") url.protocol = "ws:";
	if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		throw new Error(`Unsupported WebSocket protocol: ${url.protocol}`);
	}
	return url.toString();
}

export function requestHeaders(
	input: string | URL | Request,
	init: RequestInit | undefined,
	beta: string,
	requestId: string,
): Record<string, string> {
	const source = new Headers(input instanceof Request ? input.headers : undefined);
	for (const [key, value] of new Headers(init?.headers)) source.set(key, value);
	const authorization = source.get("authorization");
	if (!authorization) throw new Error("Responses WebSocket requires an Authorization header");
	return {
		Authorization: authorization,
		"User-Agent": PI_USER_AGENT,
		"OpenAI-Beta": beta,
		"x-client-request-id": requestId,
		"session-id": requestId,
	};
}

export function authorizationHeader(apiKey?: string, headers?: Record<string, string>): string {
	const configured = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
	if (configured) return configured;
	if (!apiKey) throw new Error("Responses WebSocket compaction requires an API key");
	return /^Bearer\s/i.test(apiKey) ? apiKey : `Bearer ${apiKey}`;
}

export async function parseRequestBody(
	input: string | URL | Request,
	body: BodyInit | null | undefined,
): Promise<RequestBody> {
	let text: string;
	if (body === undefined && input instanceof Request) text = await input.clone().text();
	else if (typeof body === "string") text = body;
	else if (body instanceof URLSearchParams) text = body.toString();
	else if (body instanceof ArrayBuffer) text = new TextDecoder().decode(body);
	else if (ArrayBuffer.isView(body)) text = new TextDecoder().decode(body);
	else throw new Error("Responses WebSocket requires a JSON request body");

	const parsed = JSON.parse(text) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Responses WebSocket request body must be a JSON object");
	}
	return parsed as RequestBody;
}

export function normalizeRequestBody(body: RequestBody): RequestBody {
	const input = Array.isArray(body.input) ? [...body.input] : [];
	const first = input[0] as { role?: unknown; content?: unknown } | undefined;
	const hasInstructions =
		first !== undefined &&
		(first.role === "developer" || first.role === "system") &&
		typeof first.content === "string";
	const instructions = hasInstructions ? (first.content as string) : "You are a helpful assistant.";
	if (hasInstructions) input.shift();

	const reasoning = body.reasoning as { effort?: unknown; summary?: unknown } | undefined;
	if (reasoning?.effort === "none" && reasoning.summary === undefined) delete body.reasoning;
	else if (reasoning && reasoning.summary === undefined) body.reasoning = { ...reasoning, summary: "auto" };

	const tools = Array.isArray(body.tools)
		? body.tools.map((tool) => {
				if (!tool || typeof tool !== "object") return tool;
				const value = tool as Record<string, unknown>;
				return value.type === "function" && value.strict !== true ? { ...value, strict: null } : tool;
			})
		: body.tools;

	delete body.max_output_tokens;
	delete body.prompt_cache_retention;
	delete body.prompt_cache_options;
	delete body.background;
	return {
		...body,
		store: false,
		stream: true,
		instructions,
		input,
		...(tools === undefined ? {} : { tools }),
		text: { verbosity: "low", ...(body.text as Record<string, unknown> | undefined) },
		include: ["reasoning.encrypted_content"],
		tool_choice: body.tool_choice ?? "auto",
		parallel_tool_calls: true,
	};
}

export function requestBodyWithoutInput(body: RequestBody): RequestBody {
	const {
		input: _input,
		previous_response_id: _previousResponseId,
		context_management: _contextManagement,
		...rest
	} = body;
	return rest;
}

export function getInputDelta(body: RequestBody, continuation: ContinuationState): unknown[] | undefined {
	if (!isDeepStrictEqual(requestBodyWithoutInput(body), requestBodyWithoutInput(continuation.lastRequestBody))) {
		return undefined;
	}
	const input = body.input ?? [];
	const replayedResponseItems = continuation.lastResponseItems.filter(
		(item) => !item || typeof item !== "object" || (item as Record<string, unknown>).type !== "compaction",
	);
	const previousInput = (continuation.lastRequestBody.input ?? []).filter(
		(item) => !item || typeof item !== "object" || (item as Record<string, unknown>).type !== "compaction_trigger",
	);
	const baseline = [...previousInput, ...replayedResponseItems];
	if (input.length < baseline.length || !isDeepStrictEqual(input.slice(0, baseline.length), baseline)) return undefined;
	return input.slice(baseline.length);
}

export function buildCachedRequestBody(entry: CachedConnection, body: RequestBody): RequestBody {
	if (!entry.continuation) return body;
	const delta = getInputDelta(body, entry.continuation);
	if (!delta) {
		entry.continuation = undefined;
		return body;
	}
	return {
		...body,
		previous_response_id: entry.continuation.lastResponseId,
		input: delta,
	};
}

export function normalizeResponseItem(item: unknown): unknown {
	if (!item || typeof item !== "object") return item;
	const value = item as Record<string, unknown>;
	if (value.type === "message") {
		const content = Array.isArray(value.content)
			? value.content.map((part) => {
					if (!part || typeof part !== "object") return part;
					const p = part as Record<string, unknown>;
					return p.type === "output_text"
						? { type: "output_text", text: p.text, annotations: p.annotations ?? [] }
						: p.type === "refusal"
							? { type: "refusal", refusal: p.refusal }
							: part;
				})
			: [];
		return {
			type: "message",
			role: "assistant",
			content,
			status: value.status,
			id: value.id,
			...(value.phase === undefined ? {} : { phase: value.phase }),
		};
	}
	if (value.type === "function_call") {
		return {
			type: "function_call",
			id: value.id,
			call_id: value.call_id,
			name: value.name,
			arguments: value.arguments,
			...(value.namespace === undefined ? {} : { namespace: value.namespace }),
		};
	}
	if (value.type === "custom_tool_call") {
		return {
			type: "custom_tool_call",
			id: value.id,
			call_id: value.call_id,
			name: value.name,
			input: value.input,
			...(value.namespace === undefined ? {} : { namespace: value.namespace }),
		};
	}
	return item;
}

export function fallbackRequest(init: RequestInit | undefined, body: RequestBody): RequestInit {
	const headers = new Headers(init?.headers);
	headers.delete("content-length");
	headers.set("User-Agent", PI_USER_AGENT);
	return { ...init, headers, body: JSON.stringify(body) };
}