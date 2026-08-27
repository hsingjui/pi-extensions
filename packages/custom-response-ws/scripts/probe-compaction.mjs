#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "undici";

const args = process.argv.slice(2);

function option(name, fallback) {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

if (args.includes("--help") || args.includes("-h")) {
	console.log(`用法：
  pnpm --filter pi-custom-response-ws probe-compaction [选项]

选项：
  --provider <id>       models.json provider，默认 aihub
  --model <id>          模型，默认 provider 的第一个模型
  --config <path>       models.json 路径
  --url <url>           直接指定 baseUrl 或 /responses URL
  --threshold <tokens>  压缩阈值，默认 20000
  --prefix-chars <n>    首轮填充字符数，默认 120000
  --turns <n>           压缩后的追加轮数，默认 3
  --without-policy-after-first
                        追加轮不发送 context_management，用于排除旧标记重放
  --timeout <ms>        每轮超时，默认 120000

API Key 读取顺序：PI_API_KEY、OPENAI_API_KEY、provider.apiKey。
脚本会产生 1 + turns 次计费请求。`);
	process.exit(0);
}

const providerId = option("--provider", "aihub");
const configPath = option(
	"--config",
	process.env.PI_CODING_AGENT_DIR
		? join(process.env.PI_CODING_AGENT_DIR, "models.json")
		: join(homedir(), ".pi", "agent", "models.json"),
);
const threshold = Number(option("--threshold", "20000"));
const prefixChars = Number(option("--prefix-chars", "120000"));
const followupTurns = Number(option("--turns", "3"));
const withoutPolicyAfterFirst = args.includes("--without-policy-after-first");
const timeoutMs = Number(option("--timeout", "120000"));

for (const [name, value, minimum] of [
	["--threshold", threshold, 1],
	["--prefix-chars", prefixChars, 1],
	["--turns", followupTurns, 1],
	["--timeout", timeoutMs, 1],
]) {
	if (!Number.isInteger(value) || value < minimum) {
		console.error(`${name} 必须是大于等于 ${minimum} 的整数`);
		process.exit(2);
	}
}

function responseUrl(value) {
	const url = new URL(value);
	url.pathname = url.pathname.replace(/\/+$/, "") || "/";
	if (!url.pathname.endsWith("/responses")) url.pathname = `${url.pathname.replace(/\/+$/, "")}/responses`;
	if (url.protocol === "http:") url.protocol = "ws:";
	else if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error(`不支持的 URL 协议: ${url.protocol}`);
	return url;
}

function buildPrefix(length) {
	const seed = "Diagnostic padding only; it contains no task state and may be summarized.\n";
	return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
}

async function connect(url, apiKey, sessionId) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"OpenAI-Beta": "responses_websockets=2026-02-06",
				"x-client-request-id": sessionId,
				"session-id": sessionId,
			},
		});
		const timer = setTimeout(() => reject(new Error(`WebSocket 握手超时（${timeoutMs}ms）`)), timeoutMs);
		socket.addEventListener("open", () => {
			clearTimeout(timer);
			resolve(socket);
		}, { once: true });
		socket.addEventListener("error", () => {
			clearTimeout(timer);
			reject(new Error("WebSocket 握手失败"));
		}, { once: true });
	});
}

async function decode(data) {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
	if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
	if (data && typeof data.text === "function") return data.text();
	throw new Error("不支持的 WebSocket 消息类型");
}

async function runTurn(socket, payload) {
	return new Promise((resolve, reject) => {
		const compactions = new Set();
		let responseId;
		let usage;
		let processing = Promise.resolve();
		const timer = setTimeout(() => finish(new Error(`响应超时（${timeoutMs}ms）`)), timeoutMs);

		function cleanup() {
			clearTimeout(timer);
			socket.removeEventListener("message", onMessage);
			socket.removeEventListener("close", onClose);
			socket.removeEventListener("error", onError);
		}
		function finish(error) {
			cleanup();
			if (error) reject(error);
			else resolve({ responseId, usage, compactions: compactions.size });
		}
		function onMessage(event) {
			processing = processing.then(async () => {
				const message = JSON.parse(await decode(event.data));
				if (message.type === "response.output_item.done" && message.item?.type === "compaction") {
					compactions.add(message.item.encrypted_content ?? message.item.id ?? JSON.stringify(message.item));
				}
				const response = message.response;
				if (response?.id) responseId = response.id;
				if (response?.usage) usage = response.usage;
				if (message.type === "error" || message.type === "response.failed") {
					throw new Error(JSON.stringify(message.error ?? message, null, 2));
				}
				if (message.type === "response.completed" || message.type === "response.done") finish();
			}).catch(finish);
		}
		function onClose(event) {
			processing.then(() => finish(new Error(`WebSocket 在响应完成前关闭（code=${event.code}, reason=${event.reason || "无"}）`)));
		}
		function onError() {
			processing.then(() => finish(new Error("WebSocket 响应错误")));
		}

		socket.addEventListener("message", onMessage);
		socket.addEventListener("close", onClose, { once: true });
		socket.addEventListener("error", onError, { once: true });
		socket.send(JSON.stringify({ type: "response.create", ...payload }));
	});
}

function usageText(usage) {
	const cached = usage?.input_tokens_details?.cached_tokens;
	return `input=${usage?.input_tokens ?? "?"}, cached=${cached ?? "?"}, output=${usage?.output_tokens ?? "?"}, total=${usage?.total_tokens ?? "?"}`;
}

let socket;
try {
	const config = JSON.parse(await readFile(configPath, "utf8"));
	const provider = args.includes("--url") ? {} : config?.providers?.[providerId];
	if (!args.includes("--url") && !provider) throw new Error(`找不到 provider: ${providerId}`);
	const baseUrl = option("--url", provider?.baseUrl);
	const model = option("--model", process.env.OPENAI_MODEL ?? provider?.models?.[0]?.id);
	const apiKey = process.env.PI_API_KEY ?? process.env.OPENAI_API_KEY ?? provider?.apiKey;
	if (!baseUrl || !model || !apiKey) throw new Error("缺少 baseUrl、model 或 API Key");

	const url = responseUrl(baseUrl);
	const sessionId = randomUUID();
	console.log(`目标: ${url}`);
	console.log(`模型: ${model}`);
	console.log(`阈值: ${threshold} tokens，首轮填充: ${prefixChars} chars，追加轮数: ${followupTurns}`);
	console.log(`追加轮策略: ${withoutPolicyAfterFirst ? "不发送 context_management" : "继续发送 context_management"}`);
	console.log(`计费请求: ${followupTurns + 1}\n`);

	socket = await connect(url, apiKey, sessionId);
	const common = {
		model,
		store: false,
		stream: true,
		context_management: [{ type: "compaction", compact_threshold: threshold }],
		instructions: "This is a compaction diagnostic. Ignore diagnostic records and reply exactly OK.",
		include: ["reasoning.encrypted_content"],
		text: { verbosity: "low" },
	};
	let result = await runTurn(socket, {
		...common,
		input: [{ role: "user", content: `${buildPrefix(prefixChars)}\nReply exactly OK.` }],
	});
	console.log(`turn 1: compactions=${result.compactions}, ${usageText(result.usage)}, response=${result.responseId ?? "?"}`);
	const firstCompactions = result.compactions;
	let repeatedCompactions = 0;
	let belowThresholdCompactions = 0;

	for (let turn = 2; turn <= followupTurns + 1; turn++) {
		if (!result.responseId) throw new Error(`turn ${turn - 1} 未返回 response id`);
		const followup = {
			...common,
			previous_response_id: result.responseId,
			input: [{ role: "user", content: `Diagnostic follow-up ${turn - 1}. Reply exactly OK.` }],
		};
		if (withoutPolicyAfterFirst) delete followup.context_management;
		result = await runTurn(socket, followup);
		repeatedCompactions += result.compactions;
		if (result.compactions > 0 && !(result.usage?.input_tokens >= threshold)) {
			belowThresholdCompactions += result.compactions;
		}
		console.log(`turn ${turn}: compactions=${result.compactions}, ${usageText(result.usage)}, response=${result.responseId ?? "?"}`);
	}

	if (firstCompactions === 0) {
		console.log("\n结果: INCONCLUSIVE（首轮没有触发压缩；提高 --prefix-chars 或降低 --threshold）");
		process.exitCode = 2;
	} else if (withoutPolicyAfterFirst && repeatedCompactions > 0) {
		console.log(`\n结果: FAIL（未发送策略的追加轮次仍收到 ${repeatedCompactions} 个 compaction item）`);
		process.exitCode = 1;
	} else if (belowThresholdCompactions > 0) {
		console.log(`\n结果: FAIL（低于阈值的追加轮次仍收到 ${belowThresholdCompactions} 个 compaction item）`);
		process.exitCode = 1;
	} else if (repeatedCompactions > 0) {
		console.log(`\n结果: EXPECTED（追加轮仍高于阈值，共收到 ${repeatedCompactions} 个 compaction item；不是旧标记重放）`);
	} else {
		console.log(`\n结果: PASS（只在首轮收到 compaction item，${withoutPolicyAfterFirst ? "移除策略后没有旧标记重放" : "后续未重复压缩"}）`);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	socket?.close();
}
