import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blobIdFor } from "../shared/blob-store.js";
import { openSealedBlobRange } from "../shared/sealed-blob.js";
import { composeSessionName } from "../shared/session-id.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";
import { contentKeyOf } from "../testing/identitySet.js";

describe("attachments across the Router", () => {
	let h: FederationHarness;
	let bound: FakeSession;

	beforeAll(async () => {
		h = await startFederationHarness();
		let launched: FakeSession | undefined;
		h.host.handlers.onCreateSession = (op) => {
			launched = attachFakeSession(h.gateway, {
				team: composeSessionName(op.target.name, op.target.sessionName),
				conversationId: "conv-files",
				sessionToken: op.sessionToken,
			});
		};
		const { result } = await h.phone.value({
			kind: "create_session",
			target: h.target("host"),
			displayLabel: "Files",
		});
		expect(result).toMatchObject({ created: true });
		bound = await h.waitFor(() => launched, "the daemon's launch");
		await bound.ready();
	}, 30_000);

	afterAll(async () => {
		bound?.close();
		if (h) await h.close();
	});

	it("a session's bytes reach the phone through the Router alone, and leave the Gateway once the row lands", async () => {
		const bytes = Buffer.from("the attachment the session made");
		const blobId = blobIdFor(bytes);
		const put = await bound.post("/blob/put", { blobId, offset: 0, chunk: bytes.toString("base64"), final: true });
		expect(put.status).toBe(200);
		const posted = await bound.post("/human/notify", {
			from: bound.team,
			title: "With a file",
			summary: "A file rides along.",
			full: "The bytes are the Router's now.",
			files: [
				{
					filename: "a.txt",
					mime: "text/plain",
					size: bytes.length,
					descriptiveKey: "a",
					role: "attachment",
					blobId,
				},
			],
		});
		expect(posted.status).toBe(200);

		const row = await h.waitFor(
			async () =>
				(await h.phone.inboxRead()).find((candidate) => candidate.envelope.contentRefs.includes(blobId)),
			"the row naming the blob",
			20_000,
		);
		expect(row.envelope.contentRefs).toEqual([blobId]);

		const fetched = (await h.phone.send({ kind: "blob_fetch", blobId })) as {
			outcome: string;
			bytes: string;
			offset: number;
			size: number;
			epoch: number;
		};
		expect(fetched.outcome).toBe("fetched");
		const opened = openSealedBlobRange(
			{
				bytes: Buffer.from(fetched.bytes, "base64"),
				offset: fetched.offset,
				size: fetched.size,
				epoch: fetched.epoch,
			},
			0,
			fetched.size,
			contentKeyOf(h.set),
			{ domainId: h.set.domain.id, ownerSignPub: h.set.domain.owner.sign.pub, blobId },
		);
		expect(opened.bytes).toEqual(bytes);

		const retired = await h.waitFor(async () => {
			const stat = (await (await bound.post("/blob/stat", { blobId })).json()) as { complete: boolean };
			return stat.complete ? undefined : stat;
		}, "the Gateway's staging retired");
		expect(retired.complete).toBe(false);

		const got = (await (await bound.post("/blob/get", { blobId, offset: 0, length: 1024 })).json()) as {
			chunk?: string;
			eof: boolean;
		};
		expect(Buffer.from(got.chunk ?? "", "base64")).toEqual(bytes);
		expect(got.eof).toBe(true);
	});
});
