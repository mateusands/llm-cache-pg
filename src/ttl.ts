/** Milliseconds, or a string like "500ms", "30s", "15m", "2h", "7d". `null` means no expiry. */
export type Ttl = number | `${number}${"ms" | "s" | "m" | "h" | "d"}` | null;

const UNIT_MS = {
	ms: 1,
	s: 1000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
} as const;

/** Returns the TTL in milliseconds, or null for no expiry. Throws on anything not positive. */
export function parseTtl(ttl: Ttl | undefined): number | null {
	if (ttl === null || ttl === undefined) return null;
	if (typeof ttl === "number") {
		if (Number.isInteger(ttl) && ttl > 0) return ttl;
		throw new Error(
			`Invalid ttl ${ttl}: must be a positive integer of milliseconds`,
		);
	}
	const match = /^(\d+)(ms|s|m|h|d)$/.exec(ttl);
	const amount = Number(match?.[1]);
	if (!match || amount <= 0) {
		throw new Error(
			`Invalid ttl ${JSON.stringify(ttl)}: use a number of ms or a string like "7d"`,
		);
	}
	return amount * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}
