export type DbusVariant = { signature: string; value: DbusValue };
export type DbusScalar = string | number | bigint | boolean;

export interface DbusDictionary {
	[key: string]: DbusValue;
}

export type DbusValue =
	| null
	| boolean
	| number
	| bigint
	| string
	| Uint8Array
	| DbusValue[]
	| Map<DbusScalar, DbusValue>
	| DbusDictionary
	| DbusVariant;

export type DbusMessageType = "method_call" | "method_return" | "error" | "signal";

export interface DbusMessage {
	type: DbusMessageType;
	serial: number;
	flags?: number;
	path?: string;
	interface?: string;
	member?: string;
	errorName?: string;
	replySerial?: number;
	destination?: string;
	sender?: string;
	bodySignature?: string;
	body?: DbusValue[];
}

export const DBUS_MAX_MESSAGE_BYTES = 1024 * 1024;

interface SignatureNode {
	code: string;
	children?: SignatureNode[];
}

const ALIGNMENT: Record<string, number> = {
	y: 1,
	b: 4,
	n: 2,
	q: 2,
	i: 4,
	u: 4,
	x: 8,
	t: 8,
	d: 8,
	h: 4,
	s: 4,
	o: 4,
	g: 1,
	a: 4,
	"(": 8,
	"{": 8,
	v: 1,
};

const BASIC = new Set(["y", "b", "n", "q", "i", "u", "x", "t", "d", "h", "s", "o", "g"]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function fail(message: string): never {
	throw new Error(`invalid D-Bus message: ${message}`);
}

function align(offset: number, boundary: number): number {
	return (offset + boundary - 1) & ~(boundary - 1);
}

function utf8(value: string): Uint8Array {
	if (value.includes("\0")) fail("string contains NUL");
	return encoder.encode(value);
}

function parseType(
	signature: string,
	index: { value: number },
	inArray = false,
	arrayDepth = 0,
	structDepth = 0,
): SignatureNode {
	const code = signature[index.value++];
	if (!code || !(code in ALIGNMENT)) fail("unknown signature type");
	if (code === "a") {
		if (arrayDepth >= 32) fail("array nesting too deep");
		const child = parseType(signature, index, true, arrayDepth + 1, structDepth);
		return { code, children: [child] };
	}
	if (code === "(") {
		if (structDepth >= 32) fail("struct nesting too deep");
		const children: SignatureNode[] = [];
		while (signature[index.value] !== ")") {
			if (index.value >= signature.length) fail("unclosed struct");
			children.push(parseType(signature, index, false, arrayDepth, structDepth + 1));
		}
		index.value++;
		if (children.length === 0) fail("empty struct");
		return { code, children };
	}
	if (code === "{") {
		if (!inArray) fail("dict entry outside array");
		if (structDepth >= 32) fail("struct nesting too deep");
		const key = signature[index.value];
		if (!key || !BASIC.has(key)) fail("invalid dict key");
		const children = [
			parseType(signature, index, false, arrayDepth, structDepth + 1),
			parseType(signature, index, false, arrayDepth, structDepth + 1),
		];
		if (signature[index.value++] !== "}") fail("unclosed dict entry");
		return { code, children };
	}
	if (code === ")" || code === "}") fail("unexpected close");
	return { code };
}

function parseSignature(signature: string): SignatureNode[] {
	const bytes = utf8(signature);
	if (bytes.length > 255) fail("signature too long");
	const index = { value: 0 };
	const nodes: SignatureNode[] = [];
	while (index.value < signature.length) nodes.push(parseType(signature, index));
	return nodes;
}

class Writer {
	bytes: number[] = [];

	get offset(): number {
		return this.bytes.length;
	}

	pad(boundary: number): void {
		while (this.offset % boundary !== 0) this.bytes.push(0);
	}

	byte(value: number): void {
		if (this.bytes.length >= DBUS_MAX_MESSAGE_BYTES) fail("message too long");
		this.bytes.push(value & 0xff);
	}

	u16(value: number): void {
		this.byte(value);
		this.byte(value >>> 8);
	}

	u32(value: number): void {
		this.byte(value);
		this.byte(value >>> 8);
		this.byte(value >>> 16);
		this.byte(value >>> 24);
	}

	u64(value: bigint): void {
		let current = BigInt.asUintN(64, value);
		for (let index = 0; index < 8; index++) {
			this.byte(Number(current & 0xffn));
			current >>= 8n;
		}
	}

	patchU32(offset: number, value: number): void {
		for (let index = 0; index < 4; index++) this.bytes[offset + index] = value >>> (index * 8);
	}

	append(value: Uint8Array): void {
		for (const byte of value) this.byte(byte);
	}

	string(value: string, objectPath = false): void {
		const bytes = utf8(value);
		if (bytes.length > DBUS_MAX_MESSAGE_BYTES) fail("string too long");
		if (objectPath && !/^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/.test(value)) fail("invalid object path");
		this.u32(bytes.length);
		this.append(bytes);
		this.byte(0);
	}

	signature(value: string): void {
		const bytes = utf8(value);
		parseSignature(value);
		this.byte(bytes.length);
		this.append(bytes);
		this.byte(0);
	}

	value(node: SignatureNode, value: DbusValue): void {
		this.pad(ALIGNMENT[node.code]);
		switch (node.code) {
			case "y":
				if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255)
					fail("byte out of range");
				this.byte(value);
				return;
			case "b":
				if (typeof value !== "boolean") fail("boolean expected");
				this.u32(value ? 1 : 0);
				return;
			case "n":
				if (typeof value !== "number" || !Number.isInteger(value) || value < -32768 || value > 32767)
					fail("int16 out of range");
				this.u16(value);
				return;
			case "q":
				if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535)
					fail("uint16 out of range");
				this.u16(value);
				return;
			case "i":
				if (typeof value !== "number" || !Number.isInteger(value) || value < -2147483648 || value > 2147483647)
					fail("int32 out of range");
				this.u32(value);
				return;
			case "u":
				if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
					fail("uint32 out of range");
				this.u32(value);
				return;
			case "h":
				if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
					fail("file descriptor out of range");
				this.u32(value);
				return;
			case "x":
				if (typeof value !== "bigint" || value < -(1n << 63n) || value >= 1n << 63n) fail("int64 expected");
				this.u64(value);
				return;
			case "t":
				if (typeof value !== "bigint" || value < 0 || value > 0xffffffffffffffffn) fail("uint64 expected");
				this.u64(value);
				return;
			case "d": {
				if (typeof value !== "number" || !Number.isFinite(value)) fail("finite double expected");
				const bytes = new Uint8Array(8);
				new DataView(bytes.buffer).setFloat64(0, value, true);
				this.append(bytes);
				return;
			}
			case "s":
				if (typeof value !== "string") fail("string expected");
				this.string(value);
				return;
			case "o":
				if (typeof value !== "string") fail("object path expected");
				this.string(value, true);
				return;
			case "g":
				if (typeof value !== "string") fail("signature expected");
				this.signature(value);
				return;
			case "v": {
				if (!isVariant(value)) fail("variant expected");
				const nodes = parseSignature(value.signature);
				if (nodes.length !== 1) fail("variant needs one type");
				this.signature(value.signature);
				this.value(nodes[0], value.value);
				return;
			}
			case "a": {
				const child = node.children?.[0];
				if (!child) fail("array type missing");
				const lengthAt = this.offset;
				this.u32(0);
				this.pad(ALIGNMENT[child.code]);
				const dataAt = this.offset;
				if (child.code === "{") {
					for (const [key, item] of dictEntries(value)) this.value(child, [key, item]);
				} else {
					for (const item of arrayValues(value)) this.value(child, item);
				}
				const length = this.offset - dataAt;
				if (length > DBUS_MAX_MESSAGE_BYTES) fail("array too long");
				this.patchU32(lengthAt, length);
				return;
			}
			case "(": {
				if (!Array.isArray(value) || value.length !== (node.children?.length ?? 0))
					fail("struct shape mismatch");
				for (let index = 0; index < value.length; index++) this.value(node.children![index], value[index]);
				return;
			}
			case "{": {
				if (!Array.isArray(value) || value.length !== 2) fail("dict entry shape mismatch");
				for (let index = 0; index < 2; index++) this.value(node.children![index], value[index]);
				return;
			}
			default:
				fail("unsupported type");
		}
	}
}

function isVariant(value: DbusValue): value is DbusVariant {
	return (
		typeof value === "object" && value !== null && !Array.isArray(value) && "signature" in value && "value" in value
	);
}

function arrayValues(value: DbusValue): DbusValue[] {
	if (value instanceof Uint8Array) return [...value];
	if (Array.isArray(value)) return value;
	fail("array expected");
}

function dictEntries(value: DbusValue): Array<[DbusScalar, DbusValue]> {
	if (value instanceof Map) return [...value.entries()];
	if (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof Uint8Array) &&
		!isVariant(value)
	)
		return Object.entries(value);
	fail("dictionary expected");
}

class Reader {
	offset = 0;
	constructor(
		readonly bytes: Uint8Array,
		start = 0,
		readonly end = bytes.length,
		readonly littleEndian = true,
	) {
		this.offset = start;
	}

	pad(boundary: number): void {
		this.offset = align(this.offset, boundary);
		if (this.offset > this.end) fail("truncated padding");
	}

	need(length: number): void {
		if (length < 0 || this.offset + length > this.end) fail("truncated value");
	}

	byte(): number {
		this.need(1);
		return this.bytes[this.offset++];
	}

	u16(): number {
		this.need(2);
		const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 2).getUint16(
			0,
			this.littleEndian,
		);
		this.offset += 2;
		return value;
	}

	u32(): number {
		this.need(4);
		const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4).getUint32(
			0,
			this.littleEndian,
		);
		this.offset += 4;
		return value;
	}

	u64(): bigint {
		this.need(8);
		let value = 0n;
		if (this.littleEndian) {
			for (let index = 7; index >= 0; index--) value = (value << 8n) | BigInt(this.bytes[this.offset + index]);
		} else {
			for (let index = 0; index < 8; index++) value = (value << 8n) | BigInt(this.bytes[this.offset + index]);
		}
		this.offset += 8;
		return value;
	}

	string(objectPath = false): string {
		const length = this.u32();
		this.need(length + 1);
		const bytes = this.bytes.subarray(this.offset, this.offset + length);
		this.offset += length;
		if (this.byte() !== 0) fail("missing string terminator");
		let value: string;
		try {
			value = decoder.decode(bytes);
		} catch {
			fail("invalid UTF-8");
		}
		if (objectPath && !/^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/.test(value)) fail("invalid object path");
		return value;
	}

	signature(): string {
		const length = this.byte();
		this.need(length + 1);
		const bytes = this.bytes.subarray(this.offset, this.offset + length);
		this.offset += length;
		if (this.byte() !== 0) fail("missing signature terminator");
		let signature: string;
		try {
			signature = decoder.decode(bytes);
		} catch {
			fail("invalid signature encoding");
		}
		parseSignature(signature);
		return signature;
	}

	value(node: SignatureNode): DbusValue {
		this.pad(ALIGNMENT[node.code]);
		switch (node.code) {
			case "y":
				return this.byte();
			case "b": {
				const value = this.u32();
				if (value > 1) fail("invalid boolean");
				return value === 1;
			}
			case "n": {
				const value = this.u16();
				return value & 0x8000 ? value - 0x10000 : value;
			}
			case "q":
				return this.u16();
			case "i":
				return this.u32() | 0;
			case "u":
				return this.u32();
			case "h":
				return this.u32();
			case "x":
				return BigInt.asIntN(64, this.u64());
			case "t":
				return this.u64();
			case "d": {
				this.need(8);
				const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8).getFloat64(
					0,
					this.littleEndian,
				);
				this.offset += 8;
				if (!Number.isFinite(value)) fail("non-finite double");
				return value;
			}
			case "s":
				return this.string();
			case "o":
				return this.string(true);
			case "g":
				return this.signature();
			case "v": {
				const signature = this.signature();
				const nodes = parseSignature(signature);
				if (nodes.length !== 1) fail("variant needs one type");
				return { signature, value: this.value(nodes[0]) };
			}
			case "a": {
				const length = this.u32();
				const child = node.children?.[0];
				if (!child) fail("array type missing");
				this.pad(ALIGNMENT[child.code]);
				const end = this.offset + length;
				if (end > this.end) fail("truncated array");
				const values: DbusValue[] = [];
				const entries = new Map<DbusScalar, DbusValue>();
				while (this.offset < end) {
					const item = this.value(child);
					if (child.code === "{") {
						if (!Array.isArray(item) || item.length !== 2) fail("bad dictionary entry");
						entries.set(item[0] as DbusScalar, item[1]);
					} else values.push(item);
				}
				if (this.offset !== end) fail("array length mismatch");
				return child.code === "{" ? entries : values;
			}
			case "(":
				return (node.children ?? []).map((child) => this.value(child));
			case "{":
				return (node.children ?? []).map((child) => this.value(child));
			default:
				fail("unsupported type");
		}
	}
}

const MESSAGE_TYPE: Record<DbusMessageType, number> = { method_call: 1, method_return: 2, error: 3, signal: 4 };
const MESSAGE_TYPE_NAME: Record<number, DbusMessageType> = {
	1: "method_call",
	2: "method_return",
	3: "error",
	4: "signal",
};

function headerFields(message: DbusMessage, bodySignature: string): Array<[number, string, DbusValue]> {
	const fields: Array<[number, string, DbusValue]> = [];
	if (message.path !== undefined) fields.push([1, "o", message.path]);
	if (message.interface !== undefined) fields.push([2, "s", message.interface]);
	if (message.member !== undefined) fields.push([3, "s", message.member]);
	if (message.errorName !== undefined) fields.push([4, "s", message.errorName]);
	if (message.replySerial !== undefined) fields.push([5, "u", message.replySerial]);
	if (message.destination !== undefined) fields.push([6, "s", message.destination]);
	if (message.sender !== undefined) fields.push([7, "s", message.sender]);
	if (bodySignature) fields.push([8, "g", bodySignature]);
	return fields;
}

function writeVariant(writer: Writer, signature: string, value: DbusValue): void {
	writer.value({ code: "v" }, { signature, value });
}

export function encodeMessage(message: DbusMessage): Uint8Array {
	if (!Number.isInteger(message.serial) || message.serial < 1 || message.serial > 0xffffffff) fail("invalid serial");
	const body = message.body ?? [];
	const bodySignature = message.bodySignature ?? body.map(inferSignature).join("");
	const bodyNodes = parseSignature(bodySignature);
	if (bodyNodes.length !== body.length) fail("body signature count mismatch");
	const writer = new Writer();
	for (let index = 0; index < 16; index++) writer.byte(0);
	const fieldsAt = writer.offset;
	for (const [code, signature, value] of headerFields(message, bodySignature)) {
		writer.pad(8);
		writer.byte(code);
		writeVariant(writer, signature, value);
	}
	const fieldsLength = writer.offset - fieldsAt;
	if (fieldsLength > DBUS_MAX_MESSAGE_BYTES) fail("header too long");
	writer.patchU32(12, fieldsLength);
	writer.pad(8);
	const bodyAt = writer.offset;
	for (let index = 0; index < body.length; index++) writer.value(bodyNodes[index], body[index]);
	const bodyLength = writer.offset - bodyAt;
	if (bodyLength + bodyAt > DBUS_MAX_MESSAGE_BYTES) fail("message too long");
	writer.bytes[0] = 0x6c;
	writer.bytes[1] = MESSAGE_TYPE[message.type];
	writer.bytes[2] = message.flags ?? 0;
	writer.bytes[3] = 1;
	writer.patchU32(4, bodyLength);
	writer.patchU32(8, message.serial);
	return Uint8Array.from(writer.bytes);
}

function inferSignature(value: DbusValue): string {
	if (typeof value === "boolean") return "b";
	if (typeof value === "string") return "s";
	if (typeof value === "bigint") return value < 0n ? "x" : "t";
	if (typeof value === "number") return Number.isInteger(value) ? "i" : "d";
	if (value instanceof Uint8Array) return "ay";
	if (Array.isArray(value)) {
		if (value.length === 0) fail("empty array needs a signature");
		return `a${inferSignature(value[0])}`;
	}
	if (value instanceof Map) fail("dictionary needs a signature");
	if (isVariant(value)) return "v";
	if (typeof value === "object" && value !== null) return "a{sv}";
	fail("cannot infer signature");
}

export function messageLength(prefix: Uint8Array): number | null {
	if (prefix.length < 16) return null;
	if (prefix[0] !== 0x6c && prefix[0] !== 0x42) fail("unsupported byte order");
	if (prefix[3] !== 1) fail("unsupported protocol version");
	const littleEndian = prefix[0] === 0x6c;
	const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
	const bodyLength = view.getUint32(4, littleEndian);
	const fieldsLength = view.getUint32(12, littleEndian);
	const bodyAt = align(16 + fieldsLength, 8);
	const length = bodyAt + bodyLength;
	if (length > DBUS_MAX_MESSAGE_BYTES) fail("message too large");
	return prefix.length >= length ? length : null;
}

export function decodeMessage(bytes: Uint8Array): DbusMessage {
	const length = messageLength(bytes);
	if (length === null || length !== bytes.length) fail("incomplete or trailing bytes");
	const littleEndian = bytes[0] === 0x6c;
	const type = MESSAGE_TYPE_NAME[bytes[1]];
	if (!type) fail("unknown message type");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const bodyLength = view.getUint32(4, littleEndian);
	const serial = view.getUint32(8, littleEndian);
	if (serial === 0) fail("serial zero");
	const fieldsLength = view.getUint32(12, littleEndian);
	const fieldsEnd = 16 + fieldsLength;
	const reader = new Reader(bytes, 16, fieldsEnd, littleEndian);
	const fields = new Map<number, DbusValue>();
	while (reader.offset < fieldsEnd) {
		reader.pad(8);
		if (reader.offset >= fieldsEnd) break;
		const code = reader.byte();
		const value = reader.value({ code: "v" });
		if (!isVariant(value)) fail("header field variant missing");
		fields.set(code, value.value);
	}
	if (reader.offset !== fieldsEnd) fail("header length mismatch");
	const bodyAt = align(fieldsEnd, 8);
	const signature = fields.get(8) ?? "";
	if (typeof signature !== "string") fail("invalid body signature");
	const bodyNodes = parseSignature(signature);
	const bodyReader = new Reader(bytes, bodyAt, bodyAt + bodyLength, littleEndian);
	const body = bodyNodes.map((node) => bodyReader.value(node));
	if (bodyReader.offset !== bodyAt + bodyLength) fail("body length mismatch");
	const textField = (code: number): string | undefined => {
		const value = fields.get(code);
		return typeof value === "string" ? value : undefined;
	};
	const numberField = (code: number): number | undefined => {
		const value = fields.get(code);
		return typeof value === "number" ? value : undefined;
	};
	return {
		type,
		serial,
		flags: bytes[2],
		path: textField(1),
		interface: textField(2),
		member: textField(3),
		errorName: textField(4),
		replySerial: numberField(5),
		destination: textField(6),
		sender: textField(7),
		bodySignature: signature,
		body,
	};
}
