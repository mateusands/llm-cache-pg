import { describe, expect, it } from "vitest";
import { redact } from "../../src/cli.ts";

describe("redact", () => {
	const url = "postgres://admin:p%40ss@db.internal:5432/cache";

	it("should remove the whole URL and the decoded password from a message", () => {
		const message = `could not connect to ${url} as admin with password p@ss`;

		const clean = redact(message, url);

		expect(clean).not.toContain(url);
		expect(clean).not.toContain("p@ss");
		expect(clean).toContain("<url>");
	});

	it("should leave a message alone when there is no URL", () => {
		expect(redact("connection refused", undefined)).toBe("connection refused");
	});
});
