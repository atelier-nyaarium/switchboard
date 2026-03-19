import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

////////////////////////////////
//  Interfaces & Types

interface GenerateServerCertParams {
	caCert: string;
	caKey: string;
	domain: string;
}

////////////////////////////////
//  Returns

interface GenerateCaCertReturn {
	caCert: string;
	caKey: string;
}

interface GenerateServerCertReturn {
	serverCert: string;
	serverKey: string;
}

////////////////////////////////
//  Functions & Helpers

export function generateCaCert(commonName: string): GenerateCaCertReturn {
	const dir = mkdtempSync(join(tmpdir(), "tls-ca-"));
	const caKeyPath = join(dir, "ca.key");
	const caCertPath = join(dir, "ca.crt");

	try {
		run("openssl", ["genrsa", "-out", caKeyPath, "4096"]);
		run("openssl", [
			"req",
			"-x509",
			"-new",
			"-nodes",
			"-key",
			caKeyPath,
			"-sha256",
			"-days",
			"3650",
			"-out",
			caCertPath,
			"-subj",
			`/CN=${commonName}-ca`,
		]);

		return {
			caCert: readFileSync(caCertPath, "utf-8"),
			caKey: readFileSync(caKeyPath, "utf-8"),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export function generateServerCert({ caCert, caKey, domain }: GenerateServerCertParams): GenerateServerCertReturn {
	const dir = mkdtempSync(join(tmpdir(), "tls-server-"));
	const caCertPath = join(dir, "ca.crt");
	const caKeyPath = join(dir, "ca.key");
	const serverKeyPath = join(dir, "server.key");
	const csrPath = join(dir, "server.csr");
	const serverCertPath = join(dir, "server.crt");
	const extPath = join(dir, "server.ext");

	try {
		writeFileSync(caCertPath, caCert);
		writeFileSync(caKeyPath, caKey);

		run("openssl", ["genrsa", "-out", serverKeyPath, "4096"]);
		run("openssl", ["req", "-new", "-key", serverKeyPath, "-out", csrPath, "-subj", `/CN=${domain}`]);

		writeFileSync(
			extPath,
			[
				"authorityKeyIdentifier=keyid,issuer",
				"basicConstraints=CA:FALSE",
				"keyUsage=digitalSignature,keyEncipherment",
				"extendedKeyUsage=serverAuth",
				`subjectAltName=DNS:${domain},IP:127.0.0.1`,
			].join("\n"),
		);

		run("openssl", [
			"x509",
			"-req",
			"-in",
			csrPath,
			"-CA",
			caCertPath,
			"-CAkey",
			caKeyPath,
			"-CAcreateserial",
			"-out",
			serverCertPath,
			"-days",
			"3650",
			"-sha256",
			"-extfile",
			extPath,
		]);

		return {
			serverCert: readFileSync(serverCertPath, "utf-8"),
			serverKey: readFileSync(serverKeyPath, "utf-8"),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function run(cmd: string, args: string[]): void {
	const result = spawnSync(cmd, args, { encoding: "utf-8" });
	if (result.error) {
		throw new Error(`${cmd} ${args[0]} failed: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`${cmd} ${args[0]} failed (exit ${result.status}): ${result.stderr}`);
	}
}
