import { MICRO_PER_UNIT, fromMicro, toMicro } from '@yantra/wallet-spec';

export { MICRO_PER_UNIT, fromMicro, toMicro };

export function assertNonNegativeMicro(v: bigint, label = 'amount'): void {
  if (v < 0n) throw new Error(`${label} must be non-negative micro-units (got ${v})`);
}

export function assertPositiveMicro(v: bigint, label = 'amount'): void {
  if (v <= 0n) throw new Error(`${label} must be positive micro-units (got ${v})`);
}

export function clampMicro(v: bigint, min: bigint, max: bigint): bigint {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}
