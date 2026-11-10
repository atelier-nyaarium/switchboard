import net from "node:net";
import tls from "node:tls";
import type { Ambient } from "../../shared/ambient.js";
import { fingerprintOf } from "./pinnedSocket.js";

////////////////////////////////
//  Constants

const MAX_ANSWER_BYTES = 1_048_576;

////////////////////////////////
//  Interfaces & Types

export type ExchangeFailure = "unreachable" | "pin_mismatch" | "bad_answer";

export interface RouterExchange {
	/** `https://host:port`. */
	url: string;
	method: "GET" | "POST";
	path: string;
	body?: unknown;
	/** Refuses any other certificate. Absent on first contact. */
	pin?: string;
	deadlineMs: number;
	signal?: AbortSignal;
}

export interface RouterAnswer {
	/** The certificate the peer presented. */
	certFp: string;
	status: number;
	body: string;
}

export type RouterExchanger = (request: RouterExchange) => Promise<RouterAnswer>;

////////////////////////////////
//  Classes

export class RouterExchangeError extends Error {
	constructor(
		readonly failure: ExchangeFailure,
		detail: string,
	) {
		super(detail);
		this.name = "RouterExchangeError";
	}
}

////////////////////////////////
//  Functions & Helpers

function dechunked(raw: Buffer): Buffer {
	const parts: Buffer[] = [];
	let at = 0;
	for (;;) {
		const eol = raw.indexOf("\r\n", at);
		if (eol < 0) break;
		const size = Number.parseInt(raw.subarray(at, eol).toString("latin1"), 16);
		if (!Number.isFinite(size) || size <= 0) break;
		parts.push(raw.subarray(eol + 2, eol + 2 + size));
		at = eol + 2 + size + 2;
	}
	return Buffer.concat(parts);
}

function answerOf(raw: Buffer): { status: number; body: string } | null {
	const split = raw.indexOf("\r\n\r\n");
	if (split < 0) return null;
	const head = raw.subarray(0, split).toString("latin1");
	const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1]);
	if (!status) return null;
	const rest = raw.subarray(split + 4);
	const chunked = /^transfer-encoding:[ \t]*chunked[ \t]*$/im.test(head);
	return { status, body: (chunked ? dechunked(rest) : rest).toString("utf8") };
}

/** One HTTP/1.1 request on a TLS socket. Nothing is written until the peer certificate passes the pin. */
export function createRouterExchange(ambient: Pick<Ambient, "setTimer" | "clearTimer">): RouterExchanger {
	return (request) =>
		new Promise((resolve, reject) => {
			let target: URL;
			try {
				target = new URL(request.url);
			} catch {
				reject(new RouterExchangeError("unreachable", `not an address: ${request.url}`));
				return;
			}
			const host = target.hostname;
			const payload = request.body === undefined ? "" : JSON.stringify(request.body);
			const head = [
				`${request.method} ${request.path} HTTP/1.1`,
				`Host: ${target.host}`,
				"Content-Type: application/json",
				`Content-Length: ${Buffer.byteLength(payload, "utf8")}`,
				"Connection: close",
				"",
				"",
			].join("\r\n");

			const chunks: Buffer[] = [];
			let size = 0;
			let certFp = "";
			let settled = false;
			const socket = tls.connect({
				host,
				port: Number(target.port) || 443,
				rejectUnauthorized: false,
				// SNI is a hostname field; handing it an IP literal throws.
				servername: net.isIP(host) === 0 ? host : undefined,
			});
			const settle = (failure: RouterExchangeError | null, answer?: RouterAnswer): void => {
				if (settled) return;
				settled = true;
				ambient.clearTimer(timer);
				socket.destroy();
				if (failure) reject(failure);
				else resolve(answer as RouterAnswer);
			};
			const timer = ambient.setTimer(
				() => settle(new RouterExchangeError("unreachable", "timed out")),
				request.deadlineMs,
			);
			const stopped = () => settle(new RouterExchangeError("unreachable", "stopped"));
			if (request.signal?.aborted) stopped();
			else request.signal?.addEventListener("abort", stopped, { once: true });

			socket.once("secureConnect", () => {
				const raw = socket.getPeerCertificate?.(true)?.raw;
				if (!raw?.length) {
					settle(new RouterExchangeError("unreachable", "no certificate presented"));
					return;
				}
				certFp = fingerprintOf(raw);
				if (request.pin && certFp !== request.pin.trim().toLowerCase()) {
					settle(new RouterExchangeError("pin_mismatch", "the Router presented another certificate"));
					return;
				}
				socket.write(head + payload);
			});
			socket.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_ANSWER_BYTES) {
					settle(new RouterExchangeError("bad_answer", "the answer is too large"));
					return;
				}
				chunks.push(chunk);
			});
			socket.once("error", (error) => settle(new RouterExchangeError("unreachable", error.message)));
			socket.once("close", () => {
				const answer = answerOf(Buffer.concat(chunks));
				if (answer) settle(null, { certFp, ...answer });
				else settle(new RouterExchangeError("bad_answer", "no answer came back"));
			});
		});
}
