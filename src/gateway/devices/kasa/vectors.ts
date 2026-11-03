// Inputs the phone's codec must frame byte for byte.

import { frame } from "./codec.js";

const PLAINTEXTS = [
	`{"system":{"get_sysinfo":{}}}`,
	`{"netif":{"get_scaninfo":{"refresh":1}}}`,
	`{"netif":{"set_stainfo":{"ssid":"Home Net","password":"p@ss \\"q\\" é 🌙","key_type":3}}}`,
	`{"system":{"set_dev_alias":{"alias":"Sign"}}}`,
	"",
];

export interface KasaVector {
	plaintext: string;
	frame: string;
}

export function kasaVectors(): KasaVector[] {
	return PLAINTEXTS.map((plaintext) => ({ plaintext, frame: Buffer.from(frame(plaintext)).toString("hex") }));
}
