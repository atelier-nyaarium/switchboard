// A recorded channel message, read back to its words.

import { REMINDER_TAG } from "./system-reminder.js";

const CHANNEL_ROW = /^<channel source="[^"]*"[^>]*>\n?([\s\S]*?)\n?<\/channel>\s*$/;
/** What `composeModelMessage` puts before a body. */
const BEFORE_BODY = new RegExp(
	`^(?:\\[FILES[^\\]\\n]*\\][\\s\\S]*?\\[\\/FILES\\]\\s*|<${REMINDER_TAG}>[\\s\\S]*?<\\/${REMINDER_TAG}>\\s*)+`,
);

/** A turn start's text as the message it carried; any other text as it stands. */
export function channelBodyOf(text: string): string {
	const tag = CHANNEL_ROW.exec(text);
	return tag ? (tag[1] ?? "").replace(BEFORE_BODY, "") : text;
}
