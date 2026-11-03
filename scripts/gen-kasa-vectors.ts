// Kasa wire vectors from the Gateway's codec, replayed by the phone's twin.

import fs from "node:fs";
import path from "node:path";
import { kasaVectors } from "../src/gateway/devices/kasa/vectors.js";

const output = path.resolve(import.meta.dirname, "../tests/fixtures/kasa-codec/vectors.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify({ vectors: kasaVectors() }, null, "\t")}\n`);
