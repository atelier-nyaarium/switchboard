const START_KEY = 0xab;

export function encrypt(plaintext: string): Uint8Array {
	const input = new TextEncoder().encode(plaintext);
	const output = new Uint8Array(input.length);
	let key = START_KEY;
	for (let index = 0; index < input.length; index += 1) {
		const cipher = input[index]! ^ key;
		output[index] = cipher;
		key = cipher;
	}
	return output;
}

export function decrypt(ciphertext: Uint8Array): string {
	const output = new Uint8Array(ciphertext.length);
	let key = START_KEY;
	for (let index = 0; index < ciphertext.length; index += 1) {
		const cipher = ciphertext[index]!;
		output[index] = cipher ^ key;
		key = cipher;
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(output);
}

export function frame(plaintext: string): Uint8Array {
	const body = encrypt(plaintext);
	const output = new Uint8Array(body.length + 4);
	new DataView(output.buffer).setUint32(0, body.length, false);
	output.set(body, 4);
	return output;
}

export function unframe(packet: Uint8Array): string {
	if (packet.length < 4) throw new Error("Kasa frame is missing its length");
	const length = new DataView(packet.buffer, packet.byteOffset, 4).getUint32(0, false);
	if (packet.length !== length + 4) throw new Error("Kasa frame length does not match its payload");
	return decrypt(packet.subarray(4));
}
