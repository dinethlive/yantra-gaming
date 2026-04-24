// Daily reconciliation CLI.
//
// Runs `ReconciliationJob.reconcileAgainstOperator` against a CSV of operator
// settlement totals and prints a human-readable diff. Exit code indicates the
// outcome so cron + alerting can classify automatically.
//
// Usage:
//   bun scripts/reconcile.ts --file settlement.csv
//   bun scripts/reconcile.ts --operator op_abc123 --currency LKR \
//     --date 2026-04-22 --bets 12500000000000 --wins 11675000000000 --rollbacks 0
//
// CSV format (one header row + one or more data rows):
//   operatorId,date,currency,betsAmountMicro,winsAmountMicro,rollbacksAmountMicro
//   op_abc123,2026-04-22,LKR,12500000000000,11675000000000,0
//
// Exit codes:
//   0  — every row matched (drift == 0)
//   1  — at least one row had MINOR_DRIFT (< 0.1 %); logged as warning
//   2  — at least one row had MAJOR_DRIFT (≥ 0.1 %); page oncall
//   3  — input parse error / fatal
//
// See docs/runbook.md §9 for operational context.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { prisma } from "../apps/rgs-server/src/db.ts";
import {
	type OperatorSettlementInput,
	type ReconciliationDiff,
	reconcileAgainstOperator,
} from "../apps/rgs-server/src/services/ReconciliationJob.ts";

const FIELDS = [
	"operatorId",
	"date",
	"currency",
	"betsAmountMicro",
	"winsAmountMicro",
	"rollbacksAmountMicro",
] as const;

type CsvRow = Record<(typeof FIELDS)[number], string>;

function parseCsv(text: string): CsvRow[] {
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("#"));
	if (lines.length === 0) return [];
	const header = lines[0]!.split(",").map((s) => s.trim());
	for (const f of FIELDS) {
		if (!header.includes(f)) {
			throw new Error(
				`CSV header missing required column "${f}". Expected: ${FIELDS.join(", ")}`,
			);
		}
	}
	const rows: CsvRow[] = [];
	for (let i = 1; i < lines.length; i++) {
		const cells = lines[i]!.split(",").map((s) => s.trim());
		if (cells.length !== header.length) {
			throw new Error(
				`CSV line ${i + 1}: expected ${header.length} columns, got ${cells.length}`,
			);
		}
		const row = {} as CsvRow;
		for (const [j, col] of header.entries()) {
			(row as Record<string, string>)[col] = cells[j]!;
		}
		rows.push(row);
	}
	return rows;
}

function toInput(row: CsvRow): OperatorSettlementInput {
	const parseBig = (s: string, name: string): bigint => {
		try {
			return BigInt(s);
		} catch {
			throw new Error(`cannot parse ${name}=${s} as bigint`);
		}
	};
	if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
		throw new Error(`date "${row.date}" not in YYYY-MM-DD`);
	}
	return {
		operatorId: row.operatorId,
		date: row.date,
		currency: row.currency,
		betsAmountMicro: parseBig(row.betsAmountMicro, "betsAmountMicro"),
		winsAmountMicro: parseBig(row.winsAmountMicro, "winsAmountMicro"),
		rollbacksAmountMicro: parseBig(
			row.rollbacksAmountMicro,
			"rollbacksAmountMicro",
		),
	};
}

function fmtMicro(n: bigint): string {
	const neg = n < 0n;
	const abs = neg ? -n : n;
	const whole = abs / 100_000n;
	const frac = (abs % 100_000n).toString().padStart(5, "0");
	return `${neg ? "-" : ""}${whole.toString()}.${frac}`;
}

function renderReport(diff: ReconciliationDiff): string {
	const o = diff.totalsOurs;
	const t = diff.totalsTheirs;
	const d = diff.driftMicro;
	const lines = [
		`─ ${t.operatorId} | ${t.date} | ${t.currency} ──────────────────────`,
		`                           OURS                  THEIRS              DRIFT`,
		`  bets      ${o.betsCount.toString().padStart(8)} @  ${fmtMicro(o.betsAmountMicro).padStart(18)}  ${fmtMicro(t.betsAmountMicro).padStart(18)}  ${fmtMicro(d.bets).padStart(14)}`,
		`  wins      ${o.winsCount.toString().padStart(8)} @  ${fmtMicro(o.winsAmountMicro).padStart(18)}  ${fmtMicro(t.winsAmountMicro).padStart(18)}  ${fmtMicro(d.wins).padStart(14)}`,
		`  rollbacks ${o.rollbacksCount.toString().padStart(8)} @  ${fmtMicro(o.rollbacksAmountMicro).padStart(18)}  ${fmtMicro(t.rollbacksAmountMicro).padStart(18)}  ${fmtMicro(d.rollbacks).padStart(14)}`,
		`  net drift                                                           ${fmtMicro(d.net).padStart(14)}`,
		`  max drift %                                                         ${(diff.maxDriftPct * 100).toFixed(4)}%`,
		`  failed outbound calls (ours):   ${o.failedCallsCount}`,
		`  stuck pending jobs (ours):       ${o.pendingJobsCount}`,
		`  status: ${diff.status}`,
	];
	return lines.join("\n");
}

function statusToExit(status: string): number {
	if (status === "MATCH") return 0;
	if (status === "MINOR_DRIFT") return 1;
	if (status === "MAJOR_DRIFT") return 2;
	return 3;
}

async function main(): Promise<number> {
	const { values } = parseArgs({
		options: {
			file: { type: "string", short: "f" },
			operator: { type: "string", short: "o" },
			currency: { type: "string", short: "c" },
			date: { type: "string", short: "d" },
			bets: { type: "string" },
			wins: { type: "string" },
			rollbacks: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: false,
	});

	if (values.help) {
		console.log(`Usage:
  bun scripts/reconcile.ts --file settlement.csv
  bun scripts/reconcile.ts --operator <id> --currency <code> --date YYYY-MM-DD \\
    --bets <micro> --wins <micro> --rollbacks <micro>

Exit codes: 0 MATCH | 1 MINOR_DRIFT | 2 MAJOR_DRIFT | 3 parse error`);
		return 0;
	}

	let inputs: OperatorSettlementInput[];
	if (values.file) {
		const text = readFileSync(values.file, "utf8");
		try {
			inputs = parseCsv(text).map(toInput);
		} catch (e) {
			console.error(`parse error: ${(e as Error).message}`);
			return 3;
		}
		if (inputs.length === 0) {
			console.error("CSV has no data rows");
			return 3;
		}
	} else if (
		values.operator &&
		values.currency &&
		values.date &&
		values.bets &&
		values.wins &&
		values.rollbacks
	) {
		try {
			inputs = [
				toInput({
					operatorId: values.operator,
					currency: values.currency,
					date: values.date,
					betsAmountMicro: values.bets,
					winsAmountMicro: values.wins,
					rollbacksAmountMicro: values.rollbacks,
				}),
			];
		} catch (e) {
			console.error(`parse error: ${(e as Error).message}`);
			return 3;
		}
	} else {
		console.error(
			"supply either --file <path> or all of --operator/--currency/--date/--bets/--wins/--rollbacks",
		);
		return 3;
	}

	let worstExit = 0;
	for (const input of inputs) {
		const diff = await reconcileAgainstOperator(input);
		console.log(renderReport(diff));
		console.log();
		const code = statusToExit(diff.status);
		if (code > worstExit) worstExit = code;
	}
	await prisma.$disconnect();
	return worstExit;
}

main()
	.then((code) => process.exit(code))
	.catch((e) => {
		console.error(e);
		process.exit(3);
	});
