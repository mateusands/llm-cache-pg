// Helpers shared by the SDK wrappers.

/** Returns `target` with the given properties replaced; every other property is read from, and bound to, `target`. */
export function override<T extends object>(
	target: T,
	replacements: Record<PropertyKey, unknown>,
): T {
	return new Proxy(target, {
		get(t, p) {
			if (Object.hasOwn(replacements, p)) return replacements[p];
			const v = Reflect.get(t, p, t);
			return typeof v === "function" ? v.bind(t) : v;
		},
	});
}

/** `fields` without the keys in `drop`. Everything not listed is kept, so new fields stay in the key. */
export function without(
	fields: Record<string, unknown>,
	drop: ReadonlySet<string>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(fields).filter(([k]) => !drop.has(k)),
	);
}

/**
 * Yields `source` unchanged, calling `onChunk` for each item, and `onEnd` only if the source ran
 * to its end. Stopping early, an error or a signal abort never reach `onEnd`; the SDKs end an
 * aborted stream quietly, so the signal is checked instead of trusting the end of the loop.
 */
export async function* tap<T>(
	source: AsyncIterable<T>,
	signal: AbortSignal,
	onChunk: (chunk: T) => void,
	onEnd: () => void,
): AsyncGenerator<T> {
	for await (const chunk of source) {
		onChunk(chunk);
		yield chunk;
	}
	if (!signal.aborted) onEnd();
}

/** Yields `source` until `signal` aborts. A replay has no request to cancel, so it checks itself. */
export async function* untilAborted<T>(
	source: AsyncIterable<T>,
	signal: AbortSignal,
): AsyncGenerator<T> {
	for await (const item of source) {
		if (signal.aborted) return;
		yield item;
	}
}
