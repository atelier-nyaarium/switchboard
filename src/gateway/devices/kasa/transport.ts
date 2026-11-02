import { createConnection, type Socket } from "node:net";
import { DeviceDriverFailure } from "../driver.js";
import { frame, unframe } from "./codec.js";

export const KASA_PORT = 9999;
export const KASA_MAX_ANSWER_BYTES = 64 * 1024;

export interface KasaTransport {
	request(address: string, command: object, signal: AbortSignal): Promise<unknown>;
}

function unreachable(detail: string, sent?: boolean): DeviceDriverFailure {
	return new DeviceDriverFailure(
		sent === undefined ? { kind: "unreachable", detail } : { kind: "unreachable", detail, sent },
	);
}

function notSent(detail: string): DeviceDriverFailure {
	return new DeviceDriverFailure({ kind: "timeout", detail, sent: false });
}

function timedOut(): DeviceDriverFailure {
	return new DeviceDriverFailure({
		kind: "timeout",
		detail: "Kasa command was sent, but no answer arrived before the deadline; its outcome is unknown",
		sent: true,
	});
}

// Never quotes the plug's bytes.
function parseAnswer(packet: Uint8Array): unknown {
	try {
		return JSON.parse(unframe(packet));
	} catch {
		throw unreachable("Kasa returned an invalid response", true);
	}
}

/** One connection per command. */
export function createKasaTransport(port = KASA_PORT): KasaTransport {
	return {
		request(address, command, signal) {
			return new Promise((resolve, reject) => {
				if (signal.aborted) {
					reject(notSent("Kasa operation ended before the connection opened"));
					return;
				}

				let socket: Socket;
				try {
					socket = createConnection({ host: address, port });
				} catch (error) {
					reject(
						unreachable(
							`Kasa connection failed: ${error instanceof Error ? error.message : "socket error"}`,
						),
					);
					return;
				}
				const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

				let sent = false;
				let settled = false;
				let chunks: Buffer[] = [];
				let byteCount = 0;
				let frameLength: number | undefined;
				const finish = (error?: DeviceDriverFailure, value?: unknown): void => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", abort);
					socket.destroy();
					void socketClosed.then(() => {
						if (error) reject(error);
						else resolve(value);
					});
				};
				const abort = (): void => {
					finish(sent ? timedOut() : notSent("Kasa operation ended before the command was sent"));
				};
				const fail = (error: unknown): void => {
					finish(
						unreachable(
							`Kasa connection ended: ${error instanceof Error ? error.message : "no response"}`,
							sent,
						),
					);
				};

				signal.addEventListener("abort", abort, { once: true });
				socket.on("connect", () => {
					if (settled || signal.aborted) return;
					try {
						sent = true;
						socket.write(frame(JSON.stringify(command)));
					} catch (error) {
						fail(error);
					}
				});
				socket.on("data", (chunk: Buffer) => {
					if (settled || signal.aborted) return;
					chunks.push(chunk);
					byteCount += chunk.length;
					if (byteCount > KASA_MAX_ANSWER_BYTES + 4) {
						finish(unreachable("Kasa answer exceeded 64 KiB", true));
						return;
					}
					if (frameLength === undefined) {
						if (byteCount < 4) return;
						const header = Buffer.alloc(4);
						let copied = 0;
						for (const part of chunks) {
							const count = Math.min(part.length, 4 - copied);
							part.copy(header, copied, 0, count);
							copied += count;
							if (copied === 4) break;
						}
						frameLength = header.readUInt32BE(0);
					}
					if (frameLength > KASA_MAX_ANSWER_BYTES) {
						finish(unreachable("Kasa answer exceeded 64 KiB", true));
						return;
					}
					const frameBytes = frameLength + 4;
					if (byteCount < frameBytes) return;
					try {
						const packet = Buffer.concat(chunks, frameBytes);
						chunks = [];
						finish(undefined, parseAnswer(packet));
					} catch (error) {
						finish(
							error instanceof DeviceDriverFailure
								? error
								: unreachable("Kasa returned an invalid response", true),
						);
					}
				});
				socket.on("error", fail);
				socket.on("close", () => {
					if (!settled) fail(new Error("socket closed without an answer"));
				});
			});
		},
	};
}
