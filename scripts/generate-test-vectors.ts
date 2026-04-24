// Generates deterministic RNG test vectors from the production RNG code.
//
// Run:  bun scripts/generate-test-vectors.ts
//
// The output is meant for docs/rng-test-vectors.md — any cert lab, OSS
// reviewer, or operator can independently verify the RNG by recomputing the
// outcomes with the same (serverSeed, clientSeed, nonce, lowWeight, highWeight)
// inputs.

import { determineOutcome } from "../games/ketapola-dice/src/index.ts";

interface Vector {
	serverSeed: string;
	clientSeed: string;
	nonce: number;
	lowWeight: number;
	highWeight: number;
	expected: { outcomeSide: "LOW" | "HIGH"; outcomeSum: number };
}

const inputs: Array<Omit<Vector, "expected">> = [
	// Fixed 32-byte server seeds (hex). Deterministically picked so anyone can
	// reproduce locally. These are NOT session-derived — they are test inputs.
	{
		serverSeed:
			"0000000000000000000000000000000000000000000000000000000000000000",
		clientSeed: "client-seed-a",
		nonce: 0,
		lowWeight: 48,
		highWeight: 48,
	},
	{
		serverSeed:
			"0000000000000000000000000000000000000000000000000000000000000000",
		clientSeed: "client-seed-a",
		nonce: 1,
		lowWeight: 48,
		highWeight: 48,
	},
	{
		serverSeed:
			"0000000000000000000000000000000000000000000000000000000000000000",
		clientSeed: "client-seed-a",
		nonce: 2,
		lowWeight: 48,
		highWeight: 48,
	},
	{
		serverSeed:
			"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		clientSeed: "client-seed-b",
		nonce: 0,
		lowWeight: 48,
		highWeight: 48,
	},
	{
		serverSeed:
			"deadbeefcafef00d0000000000000000000000000000000000000000deadbeef",
		clientSeed: "operator-provided",
		nonce: 0,
		lowWeight: 48,
		highWeight: 48,
	},
	{
		serverSeed:
			"deadbeefcafef00d0000000000000000000000000000000000000000deadbeef",
		clientSeed: "operator-provided",
		nonce: 100,
		lowWeight: 48,
		highWeight: 48,
	},
	{
		serverSeed:
			"deadbeefcafef00d0000000000000000000000000000000000000000deadbeef",
		clientSeed: "operator-provided",
		nonce: 1_000_000,
		lowWeight: 48,
		highWeight: 48,
	},
	// Asymmetric weights: LOW favoured 60:40
	{
		serverSeed:
			"1111111111111111111111111111111111111111111111111111111111111111",
		clientSeed: "asymmetric-low",
		nonce: 0,
		lowWeight: 60,
		highWeight: 40,
	},
	{
		serverSeed:
			"1111111111111111111111111111111111111111111111111111111111111111",
		clientSeed: "asymmetric-low",
		nonce: 1,
		lowWeight: 60,
		highWeight: 40,
	},
	// Asymmetric: HIGH favoured 40:60
	{
		serverSeed:
			"2222222222222222222222222222222222222222222222222222222222222222",
		clientSeed: "asymmetric-high",
		nonce: 0,
		lowWeight: 40,
		highWeight: 60,
	},
	// Long client seeds
	{
		serverSeed:
			"3333333333333333333333333333333333333333333333333333333333333333",
		clientSeed:
			"a-much-longer-client-seed-that-exceeds-the-default-16-bytes-by-a-wide-margin",
		nonce: 0,
		lowWeight: 48,
		highWeight: 48,
	},
	// Unicode client seed
	{
		serverSeed:
			"4444444444444444444444444444444444444444444444444444444444444444",
		clientSeed: "කැටපොල",
		nonce: 0,
		lowWeight: 48,
		highWeight: 48,
	},
];

const vectors: Vector[] = inputs.map((inp) => {
	const out = determineOutcome(
		inp.serverSeed,
		inp.clientSeed,
		inp.nonce,
		inp.lowWeight,
		inp.highWeight,
	);
	return {
		...inp,
		expected: { outcomeSide: out.outcomeSide, outcomeSum: out.outcomeSum },
	};
});

console.log(JSON.stringify(vectors, null, 2));
