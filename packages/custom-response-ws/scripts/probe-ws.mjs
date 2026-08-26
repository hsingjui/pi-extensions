#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os, { homedir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";

const args = process.argv.slice(2);

function option(name, fallback) {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

if (args.includes("--help") || args.includes("-h")) {
	console.log(`用法：
  pnpm --filter pi-custom-response-ws probe-ws [选项]

选项：
  --provider <id>   从 models.json 读取 provider，默认 ccs
  --config <path>   models.json 路径
  --url <url>       直接指定 baseUrl 或 /responses URL
  --timeout <ms>    握手超时，默认 5000
`);
	process.exit(0);
}

const providerId = option("--provider", "ccs");
const configPath = option(
	"--config",
	process.env.PI_CODING_AGENT_DIR
		? join(process.env.PI_CODING_AGENT_DIR, "models.json")
		: join(homedir(), ".pi", "agent", "models.json"),
);
const timeoutMs = Number(option("--timeout", "5000"));

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
	console.error("--timeout 必须是正数");
	process.exit(2);
}

async function loadProvider() {
	if (args.includes("--url")) return {};
	const config = JSON.parse(await readFile(configPath, "utf8"));
	const provider = config?.providers?.[providerId];
	if (!provider) throw new Error(`找不到 provider: ${providerId}（配置文件：${configPath}）`);
	return provider;
}

function responseUrl(value) {
	const url = new URL(value);
	url.pathname = url.pathname.replace(/\/+$/, "") || "/";
	if (!url.pathname.endsWith("/responses")) {
		url.pathname = `${url.pathname.replace(/\/+$/, "")}/responses`;
	}
	return url;
}

function websocketUrl(value) {
	const url = responseUrl(value);
	if (url.protocol === "http:") url.protocol = "ws:";
	else if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		throw new Error(`不支持的 URL 协议: ${url.protocol}`);
	}
	return url;
}

function headerValue(headers, name) {
	return headers[name.toLowerCase()];
}

function probe(url, apiKey) {
	const requestModule = url.protocol === "wss:" ? https : http;
	const requestId = randomUUID();
	const websocketKey = randomBytes(16).toString("base64");
	const expectedAccept = createHash("sha1")
		.update(`${websocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
		.digest("base64");
	const headers = {
		Connection: "Upgrade",
		Upgrade: "websocket",
		"Sec-WebSocket-Version": "13",
		"Sec-WebSocket-Key": websocketKey,
		"User-Agent": `pi (${os.platform()} ${os.release()}; ${os.arch()})`,
		"OpenAI-Beta": "responses_websockets=2026-02-06",
		"x-client-request-id": requestId,
		"session-id": requestId,
		...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
	};

	return new Promise((resolve) => {
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const request = requestModule.request({
			protocol: url.protocol === "wss:" ? "https:" : "http:",
			hostname: url.hostname,
			port: url.port || undefined,
			path: `${url.pathname}${url.search}`,
			method: "GET",
			headers,
		});
		const timer = setTimeout(() => {
			request.destroy();
			finish({ error: `握手超时（${timeoutMs}ms）` });
		}, timeoutMs);

		request.once("upgrade", (response, socket) => {
			const accept = headerValue(response.headers, "sec-websocket-accept");
			const valid = response.statusCode === 101 && accept === expectedAccept;
			socket.destroy();
			finish({
				ok: valid,
				status: response.statusCode,
				accept,
			});
		});
		request.once("response", (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => {
				if (body.length < 1000) body += chunk.slice(0, 1000 - body.length);
			});
			response.once("end", () =>
				finish({
					ok: false,
					status: response.statusCode,
					allow: response.headers.allow,
					body: body.trim(),
				}),
			);
			response.resume();
		});
		request.once("error", (error) => finish({ error: error.message }));
		request.end();
	});
}

try {
	const provider = await loadProvider();
	const baseUrl = option("--url", provider.baseUrl);
	if (!baseUrl) throw new Error("没有 baseUrl；请使用 --url 指定地址");
	const url = websocketUrl(baseUrl);
	const apiKey = process.env.PI_API_KEY ?? provider.apiKey;
	const result = await probe(url, apiKey);

	console.log(`目标: ${url}`);
	if (result.ok) {
		console.log("结果: WebSocket 握手成功（HTTP 101）");
	} else if (result.status !== undefined) {
		console.log(`结果: WebSocket 握手失败（HTTP ${result.status}）`);
		if (result.allow) console.log(`Allow: ${result.allow}`);
		if (result.body) console.log(`响应: ${result.body}`);
		if (result.status === 405 && result.allow === "POST") {
			console.log("判断: 这是 HTTP Responses 路由，不接受 WebSocket Upgrade。");
		}
	} else {
		console.log(`结果: ${result.error}`);
	}
	process.exitCode = result.ok ? 0 : 1;
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 2;
}
