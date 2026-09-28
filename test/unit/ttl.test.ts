import { describe, expect, it } from "vitest";
import { parseTtl, type Ttl } from "../../src/ttl.ts";

describe("parseTtl", () => {
	it.each([
		["500ms", 500],
		["30s", 30_000],
		["15m", 900_000],
		["2h", 7_200_000],
		["7d", 604_800_000],
		[60_000, 60_000],
	] as [Ttl, number][])("should read %j as %d ms", (input, ms) => {
		expect(parseTtl(input)).toBe(ms);
	});

	it("should read null and undefined as no expiry", () => {
		expect(parseTtl(null)).toBeNull();
		expect(parseTtl(undefined)).toBeNull();
	});

	it.each([
		"7",
		"7 d",
		"1w",
		"-1d",
		"0d",
		0,
		-5,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("should reject %j", (input) => {
		expect(() => parseTtl(input as never)).toThrow(/ttl/);
	});
});
