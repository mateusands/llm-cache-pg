import { describe, expect, it } from "vitest";
import {
	renderMigrationSql,
	supportsIterativeScan,
} from "../../src/migrate.ts";

describe("renderMigrationSql", () => {
	it("should use the table name and dimensions it is given", () => {
		const sql = renderMigrationSql({ table: "my_cache", dimensions: 768 });
		expect(sql).toContain("CREATE TABLE IF NOT EXISTS my_cache (");
		expect(sql).toContain("vector(768)");
	});

	it("should default to llm_cache_entries with 1536 dimensions", () => {
		const sql = renderMigrationSql();
		expect(sql).toContain("CREATE TABLE IF NOT EXISTS llm_cache_entries (");
		expect(sql).toContain("vector(1536)");
	});

	it.each(["Cache", "cache;drop table users", "1cache", "a".repeat(49), ""])(
		"should reject %j as a table name",
		(table) => {
			expect(() => renderMigrationSql({ table })).toThrow(/table/);
		},
	);

	it.each([0, -1, 1.5, 2001])("should reject %j dimensions", (dimensions) => {
		expect(() => renderMigrationSql({ dimensions })).toThrow(/dimensions/);
	});

	it("should put key_version in the unique key so a new key format never collides with old rows", () => {
		expect(renderMigrationSql()).toMatch(
			/UNIQUE INDEX IF NOT EXISTS \w+ ON \w+ \(namespace, model, key_version, params_hash, prompt_hash\)/,
		);
	});
});

describe("supportsIterativeScan", () => {
	it.each([
		["0.8.0", true],
		["0.8.6", true],
		["1.0.0", true],
		["0.7.4", false],
		["0.5.1", false],
	])("should return %s -> %s", (version, expected) => {
		expect(supportsIterativeScan(version)).toBe(expected);
	});
});
