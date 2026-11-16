/** A thrown value's class, never its message. */
export const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);
