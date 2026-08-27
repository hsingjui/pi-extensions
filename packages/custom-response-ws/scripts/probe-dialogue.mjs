#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os, { homedir } from "node:os";
import { join } from "node:path";
import { ProxyAgent, WebSocket } from "undici";

const args = process.argv.slice(2);
function option(name, fallback) {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

if (args.includes("--help") || args.includes("-h")) {
	console.log(`用法：
  pnpm --filter pi-custom-response-ws probe-dialogue [选项]

选项：
  --provider <id>   models.json provider，默认 aihub
  --model <id>      模型，默认 provider 的第一个模型
  --config <path>   models.json 路径
  --url <url>       直接指定 baseUrl 或 /responses URL
  --proxy <url>     HTTP 代理，例如 http://127.0.0.1:7890
  --timeout <ms>    超时，默认 120000
`);
	process.exit(0);
}

const providerId = option("--provider", "aihub");
const configPath = option(
	"--config",
	process.env.PI_CODING_AGENT_DIR
		? join(process.env.PI_CODING_AGENT_DIR, "models.json")
		: join(homedir(), ".pi", "agent", "models.json"),
);
const timeoutMs = Number(option("--timeout", "120000"));
const proxy = option("--proxy", process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY);

function responseUrl(value) {
	const url = new URL(value);
	url.pathname = url.pathname.replace(/\/+$/, "") || "/";
	if (!url.pathname.endsWith("/responses")) url.pathname = `${url.pathname.replace(/\/+$/, "")}/responses`;
	if (url.protocol === "https:") url.protocol = "wss:";
	else if (url.protocol === "http:") url.protocol = "ws:";
	if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error(`不支持的 URL 协议: ${url.protocol}`);
	return url;
}

async function decode(data) {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
	if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
	if (data && typeof data.text === "function") return data.text();
	throw new Error("不支持的 WebSocket 消息类型");
}

let socket;
try {
	const config = args.includes("--url") ? {} : JSON.parse(await readFile(configPath, "utf8"));
	const provider = config?.providers?.[providerId];
	if (!args.includes("--url") && !provider) throw new Error(`找不到 provider: ${providerId}`);
	const baseUrl = option("--url", provider?.baseUrl);
	const model = option("--model", provider?.models?.[0]?.id);
	const apiKey = process.env.PI_API_KEY ?? process.env.OPENAI_API_KEY ?? provider?.apiKey;
	if (!baseUrl || !model || !apiKey) throw new Error("缺少 baseUrl、model 或 API Key");

	const url = responseUrl(baseUrl);
	const sessionId = randomUUID();
	console.log(`目标: ${url}`);
	console.log(`模型: ${model}`);

	socket = new WebSocket(url, {
		...(proxy ? { dispatcher: new ProxyAgent(proxy) } : {}),
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"User-Agent": `pi (${os.platform()} ${os.release()}; ${os.arch()})`,
			"OpenAI-Beta": "responses_websockets=2026-02-06",
			"x-client-request-id": sessionId,
			"session-id": sessionId,
		},
	});

	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`WebSocket 超时（${timeoutMs}ms）`)), timeoutMs);
		socket.addEventListener("open", () => {
			clearTimeout(timer);
			console.log("握手: 成功");
			resolve();
		}, { once: true });
		socket.addEventListener("error", () => {
			clearTimeout(timer);
			reject(new Error("WebSocket 连接失败"));
		}, { once: true });
		socket.addEventListener("close", (event) => {
			clearTimeout(timer);
			reject(new Error(`WebSocket 关闭（code=${event.code}, reason=${event.reason || "无"}）`));
		}, { once: true });
	});

	const response = await new Promise((resolve, reject) => {
		let text = "";
		let responseId;
		const timer = setTimeout(() => reject(new Error(`响应超时（${timeoutMs}ms）`)), timeoutMs);
		const onMessage = async (event) => {
			try {
				const message = JSON.parse(await decode(event.data));
				const current = message.response;
				if (current?.id) responseId = current.id;
				if (message.type === "response.output_text.delta") text += message.delta ?? "";
				if (message.type === "error" || message.type === "response.failed") {
					throw new Error(JSON.stringify(message.error ?? message));
				}
				if (message.type === "response.completed" || message.type === "response.done") {
					clearTimeout(timer);
					socket.removeEventListener("message", onMessage);
					resolve({ responseId, text });
				}
			} catch (error) {
				clearTimeout(timer);
				socket.removeEventListener("message", onMessage);
				reject(error);
			}
		};
		socket.addEventListener("message", onMessage);
		socket.addEventListener("close", (event) => {
			clearTimeout(timer);
			reject(new Error(`响应完成前关闭（code=${event.code}, reason=${event.reason || "无"}）`));
		}, { once: true });
		socket.send(JSON.stringify({
			type: "response.create",
			model,
			store: false,
			stream: true,
			instructions: "Reply exactly: WS dialogue OK",
			input: [{ role: "user", content: "Reply exactly: WS dialogue OK" }],
			include: ["reasoning.encrypted_content"],
			text: { verbosity: "low" },
			tool_choice: "auto",
			parallel_tool_calls: true,
		}));
	});

	console.log(`结果: 对话成功，response=${response.responseId ?? "?"}`);
	console.log(`回复: ${response.text || "（未收到 output_text.delta）"}`);
} catch (error) {
	console.error(`结果: 对话失败，${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
} finally {
	socket?.close();
}
