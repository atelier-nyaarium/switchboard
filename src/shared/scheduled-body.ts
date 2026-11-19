import { z } from "zod";
import { CHANNEL_FILES_MAX, type ChannelFile, ChannelFileSchema } from "./channel-file.js";
import type { RowEnvelope } from "./schemasInbox.js";

////////////////////////////////
//  Interfaces & Types

/** Phone fileJson, src stripped. */
const ScheduledFileSchema = z.object({
	name: ChannelFileSchema.shape.filename,
	mime: ChannelFileSchema.shape.mime,
	size: ChannelFileSchema.shape.size.optional(),
	blobId: ChannelFileSchema.shape.blobId,
	role: ChannelFileSchema.shape.role.optional(),
});

/** Sealed scheduled plaintext. */
export const ScheduledBodySchema = z.object({
	text: z.string(),
	// Written, never read.
	messageId: z.string().min(1).optional(),
	files: z.array(ScheduledFileSchema).max(CHANNEL_FILES_MAX),
});

export type ScheduledFile = z.infer<typeof ScheduledFileSchema>;
export type ScheduledBody = z.infer<typeof ScheduledBodySchema>;

////////////////////////////////
//  Functions & Helpers

/** Router-fired schedule row. */
export function isFiredSchedule(envelope: Pick<RowEnvelope, "origin" | "kind">): boolean {
	return envelope.origin.kind === "router" && envelope.kind === "message";
}

/** Twin of `OutgoingFile.wireFile`; null without a size. */
export function scheduledWireFile(file: ScheduledFile): ChannelFile | null {
	if (file.size === undefined) return null;
	return {
		filename: file.name,
		mime: file.mime,
		size: file.size,
		descriptiveKey: file.name,
		...(file.blobId ? { blobId: file.blobId } : {}),
		role: file.role ?? "attachment",
	};
}
