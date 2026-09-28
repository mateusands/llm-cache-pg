/*
 * Contract: the partition is the whole request except the last user message's text, which is the
 * only part compared by vector. Anything left out of the partition can produce a false hit, which
 * is the failure this library exists to avoid.
 */
import { describe, expect, it } from "vitest";
import { canonicalJson, deriveKey, type KeyInput } from "../../src/key.ts";

const base: KeyInput = {
	model: "gpt-4.1-mini",
	messages: [
		{ role: "system", content: "You are a support bot." },
		{ role: "user", content: "How do I reset my password?" },
	],
	params: { temperature: 0 },
};

function key(overrides: Partial<KeyInput>) {
	const k = deriveKey({ ...base, ...overrides });
	if (!k) throw new Error("expected a cacheable request");
	return k;
}

describe("canonicalJson", () => {
	it("should produce the same string when object keys come in a different order", () => {
		expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
			canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
		);
	});

	it("should treat an undefined property as absent", () => {
		expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
	});

	it("should keep array order significant", () => {
		expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
	});
});

describe("deriveKey", () => {
	it("should use the last user message as the semantic text", () => {
		expect(key({}).text).toBe("How do I reset my password?");
	});

	it("should give the same keys for the same request", () => {
		expect(key({})).toEqual(key({}));
	});

	it("should change the partition when the system prompt changes", () => {
		const other = key({
			messages: [
				{ role: "system", content: "You are a pirate." },
				{ role: "user", content: "How do I reset my password?" },
			],
		});
		expect(other.paramsHash).not.toBe(key({}).paramsHash);
		expect(other.promptHash).toBe(key({}).promptHash);
	});

	it("should change the partition when earlier turns differ", () => {
		const other = key({
			messages: [
				{ role: "system", content: "You are a support bot." },
				{ role: "user", content: "I use the mobile app." },
				{ role: "assistant", content: "Got it." },
				{ role: "user", content: "How do I reset my password?" },
			],
		});
		expect(other.paramsHash).not.toBe(key({}).paramsHash);
	});

	it("should change the partition when a generation param changes", () => {
		expect(key({ params: { temperature: 0.7 } }).paramsHash).not.toBe(
			key({}).paramsHash,
		);
	});

	it("should change the partition when the request gains a field it has never seen", () => {
		expect(
			key({ params: { temperature: 0, some_future_field: true } }).paramsHash,
		).not.toBe(key({}).paramsHash);
	});

	it("should change the partition when other fields of the last message change", () => {
		const named = {
			role: "user",
			content: "How do I reset my password?",
			name: "alice",
		};
		const other = key({
			messages: [{ role: "system", content: "You are a support bot." }, named],
		});
		expect(other.paramsHash).not.toBe(key({}).paramsHash);
	});

	it("should keep the model out of the params hash, since it is a column of its own", () => {
		expect(key({ model: "gpt-4.1" }).paramsHash).toBe(key({}).paramsHash);
		expect(key({ model: "gpt-4.1" }).model).toBe("gpt-4.1");
	});

	it("should join text parts when the content is an array of parts", () => {
		const k = key({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "a" },
						{ type: "text", text: "b" },
					],
				},
			],
		});
		expect(k.text).toBe("a\nb");
	});

	it("should not be cacheable when the last message has a non-text part", () => {
		const k = deriveKey({
			...base,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "what is this?" },
						{ type: "image_url", image_url: { url: "x" } },
					],
				},
			],
		});
		expect(k).toBeNull();
	});

	it("should not be cacheable when the last message is not from the user", () => {
		const k = deriveKey({
			...base,
			messages: [...base.messages, { role: "assistant", content: "Sure," }],
		});
		expect(k).toBeNull();
	});

	it("should not be cacheable when there are no messages or the text is empty", () => {
		expect(deriveKey({ ...base, messages: [] })).toBeNull();
		expect(
			deriveKey({ ...base, messages: [{ role: "user", content: "   " }] }),
		).toBeNull();
	});
});
