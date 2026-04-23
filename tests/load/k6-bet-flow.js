// k6 load test: session-creation + round-read flow.
//
// Exercises the HMAC-signed operator surface (POST /v1/session,
// GET /v1/rounds/:id, GET /v1/reports/daily) against the RGS and asserts the
// SLO budget from B2B_ROADMAP.md §13:
//
//   POST /v1/session               p99 < 150 ms
//   GET  /v1/rounds/:id            p99 < 300 ms
//   GET  /v1/reports/daily         p99 < 500 ms
//
// The bet → settlement flow is driven over Socket.IO (see
// apps/rgs-server/src/socket/) which k6 does not speak natively; that lives in
// tests/e2e/ instead. This file measures the HTTP contract operators actually
// sign against.
//
// Usage:
//   # 1. Start the stack: `bun run dev`
//   # 2. Seed an operator:  `bun run db:seed`
//   # 3. Run:              `bun run load`
//
// Env overrides:
//   RGS_BASE_URL         default http://localhost:4500
//   OPERATOR_ID          default 00000000-0000-4000-8000-000000000001  (seed default)
//   API_KEY_ID           default kid_mock_dev
//   API_SECRET           default mock-dev-shared-secret
//   VUS                  default 100
//   DURATION             default 5m

import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";
import { check, sleep } from "k6";
import crypto from "k6/crypto";
import http from "k6/http";
import { Trend } from "k6/metrics";

const RGS_BASE_URL = __ENV.RGS_BASE_URL || "http://localhost:4500";
const OPERATOR_ID = __ENV.OPERATOR_ID || "00000000-0000-4000-8000-000000000001";
const API_KEY_ID = __ENV.API_KEY_ID || "kid_mock_dev";
const API_SECRET = __ENV.API_SECRET || "mock-dev-shared-secret";

const sessionLatency = new Trend("ketapola_session_ms", true);
const roundReadLatency = new Trend("ketapola_round_read_ms", true);
const reportLatency = new Trend("ketapola_report_ms", true);

export const options = {
	vus: Number(__ENV.VUS || 100),
	duration: __ENV.DURATION || "5m",
	thresholds: {
		// Map directly to §13 SLO table.
		ketapola_session_ms: ["p(99)<150"],
		ketapola_round_read_ms: ["p(99)<300"],
		ketapola_report_ms: ["p(99)<500"],
		http_req_failed: ["rate<0.001"], // 0.1% error budget
	},
};

function sign(method, path, body) {
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const bodyHash = crypto.sha256(body, "hex");
	const payload = `${method}\n${path}\n${timestamp}\n${bodyHash}`;
	const sig = crypto.hmac("sha256", API_SECRET, payload, "base64");
	return {
		"X-Yantra-Key-Id": API_KEY_ID,
		"X-Yantra-Timestamp": timestamp,
		"X-Yantra-Signature": sig,
		"Content-Type": "application/json",
	};
}

function createSession() {
	const path = "/v1/session";
	const body = JSON.stringify({
		requestUuid: uuidv4(),
		operatorId: OPERATOR_ID,
		playerRef: `load-player-${__VU}-${__ITER}`,
		gameCode: "yantra",
		currency: "LKR",
		lang: "si",
		jurisdiction: "LK",
		mode: "real",
		returnUrl: "https://example.com/lobby",
		rgLimits: { dailyLossMicro: "5000000000" },
	});

	const res = http.post(`${RGS_BASE_URL}${path}`, body, {
		headers: sign("POST", path, body),
		tags: { endpoint: "session" },
	});

	sessionLatency.add(res.timings.duration);
	check(res, {
		"session 200": (r) => r.status === 200,
		"session has sessionToken": (r) => !!r.json("sessionToken"),
	});
	return res.json();
}

function readRound(roundId) {
	const path = `/v1/rounds/${roundId}`;
	const res = http.get(`${RGS_BASE_URL}${path}`, {
		headers: sign("GET", path, ""),
		tags: { endpoint: "round_read" },
	});
	roundReadLatency.add(res.timings.duration);
	check(res, { "round read ok": (r) => r.status === 200 || r.status === 404 });
}

function readReport() {
	const date = new Date().toISOString().slice(0, 10);
	const path = `/v1/reports/daily?date=${date}&operatorId=${OPERATOR_ID}`;
	const res = http.get(`${RGS_BASE_URL}${path}`, {
		headers: sign("GET", path, ""),
		tags: { endpoint: "report" },
	});
	reportLatency.add(res.timings.duration);
	check(res, { "report 200": (r) => r.status === 200 });
}

export default function () {
	const session = createSession();
	if (session?.sessionId && session.roundId) {
		// Sessions return a first-round id if pre-created; otherwise just skip.
		readRound(session.roundId);
	}
	readReport();
	sleep(1);
}
