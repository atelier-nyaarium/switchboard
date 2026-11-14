import { createConnection, type Socket } from "node:net";
import {
	DBUS_MAX_MESSAGE_BYTES,
	type DbusMessage,
	type DbusValue,
	decodeMessage,
	encodeMessage,
	messageLength,
} from "./dbusWire.js";

const DBUS_NAME = "org.freedesktop.DBus";
const DBUS_PATH = "/org/freedesktop/DBus";
const DBUS_TIMEOUT_MS = 1_000;
const SOCKET_CONNECT_TIMEOUT_MS = 1_000;
const MAX_PENDING_CALLS = 128;
const MAX_AUTH_BYTES = 8192;
const MAX_STREAM_BYTES = DBUS_MAX_MESSAGE_BYTES * 2;

export interface DbusTransport {
	connect(): Promise<void>;
	write(bytes: Uint8Array): void;
	onBytes(listener: (bytes: Uint8Array) => void): () => void;
	onClose(listener: (error?: Error) => void): () => void;
	close(): void;
}

export interface DbusCall {
	destination: string;
	path: string;
	interface: string;
	member: string;
	bodySignature?: string;
	body?: DbusValue[];
	timeoutMs?: number;
}

export class DbusCallError extends Error {
	constructor(
		readonly errorName: string,
		message: string,
	) {
		super(message);
		this.name = "DbusCallError";
	}
}

export class DbusConnectionError extends Error {
	constructor(cause: unknown) {
		super("D-Bus system bus unavailable", { cause });
		this.name = "DbusConnectionError";
	}
}

interface PendingCall {
	resolve: (message: DbusMessage) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBufferLike> {
	const joined = new Uint8Array(left.length + right.length);
	joined.set(left);
	joined.set(right, left.length);
	return joined;
}

function ascii(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function defaultSystemBusPath(): string {
	const address = process.env.DBUS_SYSTEM_BUS_ADDRESS;
	if (!address) return "/run/dbus/system_bus_socket";
	const unix = address.split(";").find((entry) => entry.startsWith("unix:"));
	const path = unix
		?.slice("unix:".length)
		.split(",")
		.find((part) => part.startsWith("path="))
		?.slice(5);
	if (!path) throw new Error("system bus address has no unix path");
	try {
		return decodeURIComponent(path);
	} catch {
		throw new Error("system bus path is malformed");
	}
}

export class UnixDbusTransport implements DbusTransport {
	private socket: Socket | null = null;
	private readonly bytesListeners = new Set<(bytes: Uint8Array) => void>();
	private readonly closeListeners = new Set<(error?: Error) => void>();
	private ended = false;

	constructor(private readonly path?: string) {}

	connect(): Promise<void> {
		if (this.socket) return Promise.reject(new Error("D-Bus transport already connected"));
		return new Promise((resolve, reject) => {
			const socket = createConnection({ path: this.path ?? defaultSystemBusPath() });
			this.socket = socket;
			let connected = false;
			const timer = setTimeout(() => {
				if (connected) return;
				reject(new Error("D-Bus socket deadline elapsed"));
				socket.destroy();
			}, SOCKET_CONNECT_TIMEOUT_MS);
			socket.on("data", (chunk) => {
				const bytes =
					typeof chunk === "string"
						? ascii(chunk)
						: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
				for (const listener of this.bytesListeners) listener(bytes);
			});
			socket.on("error", (error) => {
				if (!connected) {
					clearTimeout(timer);
					reject(error);
				}
				this.emitClose(error);
			});
			socket.on("close", () => {
				clearTimeout(timer);
				this.emitClose();
			});
			socket.once("connect", () => {
				connected = true;
				clearTimeout(timer);
				resolve();
			});
		});
	}

	write(bytes: Uint8Array): void {
		if (!this.socket || this.ended) throw new Error("D-Bus transport is closed");
		this.socket.write(bytes);
	}

	onBytes(listener: (bytes: Uint8Array) => void): () => void {
		this.bytesListeners.add(listener);
		return () => this.bytesListeners.delete(listener);
	}

	onClose(listener: (error?: Error) => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	close(): void {
		if (this.ended) return;
		this.emitClose(new Error("D-Bus transport closed"));
		this.socket?.destroy();
	}

	private emitClose(error?: Error): void {
		if (this.ended) return;
		this.ended = true;
		for (const listener of this.closeListeners) listener(error);
	}
}

export class DbusClient {
	private readonly pending = new Map<number, PendingCall>();
	private readonly signalListeners = new Set<(message: DbusMessage) => void>();
	private readonly closeListeners = new Set<(error: Error) => void>();
	private startPromise: Promise<void> | null = null;
	private authBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
	private streamBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
	private authReady: Promise<void>;
	private resolveAuth!: () => void;
	private rejectAuth!: (error: Error) => void;
	private nextSerial = 1;
	private closedError: Error | null = null;
	private readonly removeBytesListener: () => void;
	private readonly removeCloseListener: () => void;

	constructor(private readonly transport: DbusTransport) {
		this.authReady = new Promise<void>((resolve, reject) => {
			this.resolveAuth = resolve;
			this.rejectAuth = reject;
		});
		void this.authReady.catch(() => {});
		this.removeBytesListener = transport.onBytes((bytes) => this.receive(bytes));
		this.removeCloseListener = transport.onClose((error) =>
			this.fail(error ?? new Error("D-Bus connection closed")),
		);
	}

	get dead(): boolean {
		return this.closedError !== null;
	}

	connect(): Promise<void> {
		if (!this.startPromise) this.startPromise = this.startConnection();
		return this.startPromise;
	}

	async call(call: DbusCall): Promise<DbusMessage> {
		await this.connect();
		return this.callRaw(call);
	}

	onSignal(listener: (message: DbusMessage) => void): () => void {
		this.signalListeners.add(listener);
		return () => this.signalListeners.delete(listener);
	}

	onClose(listener: (error: Error) => void): () => void {
		if (this.closedError) {
			listener(this.closedError);
			return () => {};
		}
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	close(): void {
		this.fail(new Error("D-Bus client closed"));
		this.transport.close();
		this.removeBytesListener();
		this.removeCloseListener();
		this.closeListeners.clear();
	}

	private async startConnection(): Promise<void> {
		try {
			try {
				await this.transport.connect();
			} catch (error) {
				throw new DbusConnectionError(error);
			}
			const uid = String(process.getuid?.() ?? 0);
			const credentials = [...new TextEncoder().encode(uid)]
				.map((byte) => byte.toString(16).padStart(2, "0"))
				.join("");
			this.transport.write(concat(Uint8Array.of(0), ascii(`AUTH EXTERNAL ${credentials}\r\n`)));
			await this.waitForAuth();
			const reply = await this.callRaw({
				destination: DBUS_NAME,
				path: DBUS_PATH,
				interface: DBUS_NAME,
				member: "Hello",
			});
			if (reply.type !== "method_return" || typeof reply.body?.[0] !== "string")
				throw new Error("D-Bus Hello failed");
		} catch (error) {
			const failure = asError(error);
			this.fail(failure);
			throw failure;
		}
	}

	private async waitForAuth(): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.authReady,
				new Promise<void>((_, reject) => {
					timer = setTimeout(() => reject(new Error("D-Bus auth deadline elapsed")), DBUS_TIMEOUT_MS);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	private async callRaw(call: DbusCall): Promise<DbusMessage> {
		if (this.closedError) throw this.closedError;
		if (this.pending.size >= MAX_PENDING_CALLS) throw new Error("too many D-Bus calls");
		const serial = this.mintSerial();
		const timeoutMs = call.timeoutMs ?? DBUS_TIMEOUT_MS;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(serial);
				reject(new Error(`D-Bus call deadline elapsed: ${call.member}`));
			}, timeoutMs);
			this.pending.set(serial, { resolve, reject, timer });
			try {
				this.transport.write(
					encodeMessage({
						type: "method_call",
						serial,
						path: call.path,
						interface: call.interface,
						member: call.member,
						destination: call.destination,
						bodySignature: call.bodySignature,
						body: call.body,
					}),
				);
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(serial);
				reject(asError(error));
			}
		});
	}

	private mintSerial(): number {
		const serial = this.nextSerial;
		this.nextSerial = this.nextSerial === 0xffffffff ? 1 : this.nextSerial + 1;
		return serial;
	}

	private receive(bytes: Uint8Array): void {
		if (this.closedError) return;
		if (!this.authReadySettled()) {
			this.authBuffer = concat(this.authBuffer, bytes);
			if (this.authBuffer.length > MAX_AUTH_BYTES) {
				this.fail(new Error("D-Bus auth response too large"));
				return;
			}
			let end = -1;
			for (let index = 0; index + 1 < this.authBuffer.length; index++) {
				if (this.authBuffer[index] === 13 && this.authBuffer[index + 1] === 10) {
					end = index + 2;
					break;
				}
			}
			if (end < 0) return;
			const line = new TextDecoder().decode(this.authBuffer.subarray(0, end - 2));
			const remainder = this.authBuffer.subarray(end);
			this.authBuffer = new Uint8Array();
			if (!line.startsWith("OK ")) {
				this.fail(new Error(`D-Bus auth refused: ${line}`));
				return;
			}
			try {
				this.transport.write(ascii("BEGIN\r\n"));
				this.authSettled = true;
				this.resolveAuth();
			} catch (error) {
				this.fail(asError(error));
				return;
			}
			if (remainder.length) this.receiveBinary(remainder);
			return;
		}
		this.receiveBinary(bytes);
	}

	private authSettled = false;

	private authReadySettled(): boolean {
		return this.authSettled;
	}

	private receiveBinary(bytes: Uint8Array): void {
		this.streamBuffer = concat(this.streamBuffer, bytes);
		if (this.streamBuffer.length > MAX_STREAM_BYTES) {
			this.fail(new Error("D-Bus receive buffer too large"));
			return;
		}
		try {
			while (true) {
				const length = messageLength(this.streamBuffer);
				if (length === null) return;
				const bytes = this.streamBuffer.subarray(0, length);
				this.streamBuffer = this.streamBuffer.slice(length);
				let message: DbusMessage | null = null;
				try {
					message = decodeMessage(bytes);
				} catch {}
				if (message !== null) this.dispatch(message);
			}
		} catch (error) {
			this.fail(asError(error));
		}
	}

	private dispatch(message: DbusMessage): void {
		if (message.type === "signal") {
			for (const listener of this.signalListeners) listener(message);
			return;
		}
		if (message.type !== "method_return" && message.type !== "error") return;
		const pending = message.replySerial === undefined ? undefined : this.pending.get(message.replySerial);
		if (!pending || message.replySerial === undefined) return;
		this.pending.delete(message.replySerial);
		clearTimeout(pending.timer);
		if (message.type === "error") {
			const text = typeof message.body?.[0] === "string" ? message.body[0] : (message.errorName ?? "D-Bus error");
			pending.reject(new DbusCallError(message.errorName ?? "org.freedesktop.DBus.Error.Failed", text));
		} else pending.resolve(message);
	}

	private fail(error: Error): void {
		if (this.closedError) return;
		this.closedError = error;
		this.rejectAuth(error);
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		for (const listener of this.closeListeners) listener(error);
		this.closeListeners.clear();
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export function createSystemBusClient(): DbusClient {
	return new DbusClient(new UnixDbusTransport());
}

export function systemBusAddressPath(): string {
	return defaultSystemBusPath();
}
