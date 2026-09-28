import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/openai.ts",
		"src/anthropic.ts",
		"src/prometheus.ts",
	],
	format: ["esm", "cjs"],
	platform: "node",
	target: "node22",
	tsconfig: "tsconfig.build.json",
	dts: true,
	publint: true,
	attw: { profile: "node16", level: "error" },
});
