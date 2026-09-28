// Helpers shared by the SDK wrappers.

/** Returns `target` with `prop` replaced; every other property is read from, and bound to, `target`. */
export function override<T extends object>(
	target: T,
	prop: PropertyKey,
	value: unknown,
): T {
	return new Proxy(target, {
		get(t, p) {
			if (p === prop) return value;
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
