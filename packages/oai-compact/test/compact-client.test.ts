import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { executeNativeCompaction } from "../src/compact-client.ts";
import { buildCompactUrl } from "../src/runtime.ts";
import type { NativeCompactionRequestBody } from "../src/serializer.ts";

test("buildCompactUrl accepts provider base and Responses URLs", () => {
	assert.equal(buildCompactUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/responses/compact");
	assert.equal(buildCompactUrl("https://api.openai.com/v1/responses"), "https://api.openai.com/v1/responses/compact");
	assert.equal(buildCompactUrl("https://api.openai.com/v1/responses/compact/"), "https://api.openai.com/v1/responses/compact");
});

test("executeNativeCompaction uses remote compaction v2 and parses its SSE output", async (t) => {
	let receivedBody: unknown;
	let receivedUrl: string | undefined;
	let receivedAuthorization: string | undefined;
	let receivedAccept: string | undefined;
	let receivedBetaFeatures: string | undefined;
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			receivedUrl = request.url;
			receivedAuthorization = request.headers.authorization;
			receivedAccept = request.headers.accept;
			receivedBetaFeatures = Array.isArray(request.headers["x-codex-beta-features"])
				? request.headers["x-codex-beta-features"].join(",")
				: request.headers["x-codex-beta-features"];
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end([
				`event: response.output_item.added\ndata: ${JSON.stringify({
					type: "response.output_item.added",
					item: { type: "compaction", encrypted_content: "draft" },
				})}`,
				`event: response.output_item.done\ndata: ${JSON.stringify({
					type: "response.output_item.done",
					item: { type: "compaction", encrypted_content: "opaque" },
				})}`,
				`event: response.completed\ndata: ${JSON.stringify({
					type: "response.completed",
					response: {
						id: "resp_compact_1",
						created_at: 1_700_000_000,
						output: [],
					},
				})}`,
			].join("\n\n") + "\n\n");
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const address = server.address();
	assert.ok(address && typeof address !== "string");

	const request: NativeCompactionRequestBody = {
		model: "gpt-5.2",
		input: [{ role: "user", content: "compact me" }],
		prompt_cache_key: "test-key",
		prompt_cache_retention: "24h",
	};
	const result = await executeNativeCompaction({
		config: {
			compactUrl: `http://127.0.0.1:${address.port}/v1/responses/compact`,
			apiKey: "test-key",
		},
		request,
	});

	assert.equal(result.ok, true);
	assert.equal(receivedUrl, "/v1/responses");
	assert.deepEqual(receivedBody, {
		...request,
		input: [...request.input, { type: "compaction_trigger" }],
		stream: true,
	});
	assert.equal(receivedAuthorization, "Bearer test-key");
	assert.equal(receivedAccept, "text/event-stream");
	assert.equal(receivedBetaFeatures, "remote_compaction_v2");
	if (result.ok) {
		assert.deepEqual(result.compactedWindow, [{ type: "compaction", encrypted_content: "opaque" }]);
		assert.equal(result.compactResponseId, "resp_compact_1");
		assert.equal(result.createdAt, "2023-11-14T22:13:20.000Z");
	}
});
