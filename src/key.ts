import { createHash } from "node:crypto";

/**
 * Bumped whenever the hashing below changes for plain JSON, so rows written under the old format
 * stop matching. Still 1 after 0.6.1: plain JSON hashes byte for byte as before; only non-JSON
 * values (Date, Buffer, Map, class instances) changed.
 */
export const KEY_VERSION = 1;

/** A chat message. Fields other than these two are hashed into the partition as well. */
export interface Message {
	role: string;
	content?: unknown;
}

export interface KeyInput {
	model: string;
	messages: readonly Message[];
	/** Every other request field that can change the answer. Unknown fields are hashed too. */
	params?: Record<string, unknown>;
}

export interface CacheKey {
	model: string;
	/** Hash of the params plus every message except the last user message's text. */
	paramsHash: string;
	/** Hash of the last user message's text. */
	promptHash: string;
	/** The last user message's text, the only part compared by vector. */
	text: string;
}

/**
 * A value the key does not hash, such as a Map, Set or class instance: their state can live in the
 * prototype (getters, private fields) or have no own keys at all, so two different ones could match.
 */
export class UnkeyableValueError extends Error {
	constructor(kind: string) {
		super(`Cannot build a cache key from a ${kind}`);
		this.name = "UnkeyableValueError";
	}
}

/**
 * JSON with object keys sorted at every depth; `undefined` properties are dropped. Throws
 * UnkeyableValueError for objects that are neither plain, arrays, nor have a toJSON method.
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value, "", false));
}

function isPlainObject(value: object): boolean {
	const proto = Object.getPrototypeOf(value);
	// Object.prototype of any realm (vm, jsdom, some edge runtimes) has a null prototype itself.
	return proto === null || Object.getPrototypeOf(proto) === null;
}

/** `jsonDone`: the value already came out of a toJSON call, which JSON.stringify never repeats. */
function sortKeys(value: unknown, key: string, jsonDone: boolean): unknown {
	const v = value as { toJSON?: unknown } | null;
	if (!jsonDone && typeof v?.toJSON === "function")
		return sortKeys(v.toJSON(key), key, true);
	if (Array.isArray(value))
		return value.map((item, i) => sortKeys(item, String(i), false));
	if (value === null || typeof value !== "object") return value;
	if (!isPlainObject(value))
		throw new UnkeyableValueError(value.constructor?.name || "object");
	// No prototype, so an own "__proto__" key stays a key instead of replacing the prototype.
	const sorted: Record<string, unknown> = Object.create(null);
	for (const k of Object.keys(value).sort()) {
		const item = (value as Record<string, unknown>)[k];
		// JSON drops function values in objects anyway; copying one named toJSON would get it called.
		if (typeof item !== "function") sorted[k] = sortKeys(item, k, false);
	}
	return sorted;
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Text parts joined by newlines, or null when there is no text or any part is not text. */
function textOf(content: unknown): string | null {
	if (typeof content === "string") return content.trim() ? content : null;
	if (!Array.isArray(content) || content.length === 0) return null;
	const texts: string[] = [];
	for (const part of content) {
		if (part?.type !== "text" || typeof part.text !== "string") return null;
		texts.push(part.text);
	}
	const text = texts.join("\n");
	return text.trim() ? text : null;
}

/**
 * Splits a request into the exact partition and the semantic text. `key` is null when the request
 * must bypass the cache: the last message is not from the user, it carries anything other than
 * text, or part of it cannot be hashed safely, in which case `error` says why.
 */
export function tryDeriveKey(input: KeyInput): {
	key: CacheKey | null;
	error?: unknown;
} {
	const last = input.messages.at(-1);
	if (last?.role !== "user") return { key: null };
	const text = textOf(last.content);
	if (text === null) return { key: null };

	const { content: _, ...lastWithoutContent } = last;
	const partition = {
		params: input.params ?? {},
		context: input.messages.slice(0, -1),
		last: lastWithoutContent,
	};
	let json: string;
	try {
		json = canonicalJson(partition);
	} catch (error) {
		// Unkeyable values, BigInt, cycles: bypassing is the safe side, and the call still reaches the model.
		return { key: null, error };
	}
	return {
		key: {
			model: input.model,
			paramsHash: sha256(json),
			promptHash: sha256(text),
			text,
		},
	};
}

/** tryDeriveKey without the reason. */
export function deriveKey(input: KeyInput): CacheKey | null {
	return tryDeriveKey(input).key;
}
