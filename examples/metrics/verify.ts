// Checks the running demo end to end: every metric reached Prometheus, and every dashboard panel
// returns data through Grafana. Run after the demo has sent traffic for a minute:
// node examples/metrics/verify.ts
const PROMETHEUS = "http://localhost:9090";
const GRAFANA = "http://localhost:3000";
const AUTH = `Basic ${Buffer.from("admin:admin").toString("base64")}`;

const METRICS = [
	"llm_cache_requests_total",
	"llm_cache_tokens_saved_total",
	"llm_cache_lookup_duration_seconds_count",
	"llm_cache_similarity_count",
	"llm_cache_errors_total",
	"llm_cache_shadow_lookups_total",
	"llm_cache_entries",
];

let failed = false;
const check = (ok: boolean, label: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
	if (!ok) failed = true;
};

for (const metric of METRICS) {
	const res = await fetch(
		`${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(`sum(${metric})`)}`,
	);
	const body = (await res.json()) as {
		data: { result: { value: [number, string] }[] };
	};
	const value = Number(body.data.result[0]?.value[1] ?? 0);
	check(value > 0, `prometheus ${metric} = ${value}`);
}

interface Target {
	expr: string;
	format?: string;
	instant?: boolean;
}
const dash = (await (
	await fetch(`${GRAFANA}/api/dashboards/uid/llm-cache-pg`, {
		headers: { Authorization: AUTH },
	})
).json()) as {
	dashboard: { panels: { title: string; targets: Target[] }[] };
};
const now = Date.now();
for (const panel of dash.dashboard.panels) {
	const queries = panel.targets.map((t, i) => ({
		refId: String.fromCharCode(65 + i),
		datasource: { type: "prometheus", uid: "prometheus" },
		// What Grafana substitutes for the dashboard variables when "All" is selected.
		expr: t.expr.replaceAll("$namespace", ".*"),
		format: t.format ?? "time_series",
		instant: t.instant ?? false,
		range: !t.instant,
		intervalMs: 15000,
	}));
	const res = await fetch(`${GRAFANA}/api/ds/query`, {
		method: "POST",
		headers: { Authorization: AUTH, "Content-Type": "application/json" },
		body: JSON.stringify({
			from: String(now - 5 * 60_000),
			to: String(now),
			queries,
		}),
	});
	const body = (await res.json()) as {
		results?: Record<
			string,
			{ frames?: { data?: { values?: unknown[][] } }[]; error?: string }
		>;
	};
	const results = Object.values(body.results ?? {});
	const withData = results.filter(
		(r) =>
			!r.error && r.frames?.some((f) => (f.data?.values?.[1]?.length ?? 0) > 0),
	);
	check(
		res.ok && withData.length === queries.length,
		`grafana panel "${panel.title}" (${withData.length}/${queries.length} queries with data)`,
	);
}

process.exit(failed ? 1 : 0);
