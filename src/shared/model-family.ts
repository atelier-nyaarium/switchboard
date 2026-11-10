// A model's family: its id with the version numbers taken out.

/** `claude-opus-5-4` and `claude-opus-5-5` share one; `deepseek-v4-pro` and `deepseek-v4.1-flash` do not. */
export function modelFamily(id: string): string {
	return id
		.toLowerCase()
		.replace(/\d+(?:[._-]\d+)*/g, "")
		.split(/[-_./]+/)
		.filter(Boolean)
		.join("-");
}

export function sameFamily(a: string, b: string): boolean {
	return modelFamily(a) === modelFamily(b);
}
