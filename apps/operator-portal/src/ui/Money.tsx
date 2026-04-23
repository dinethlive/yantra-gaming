// Money is stored and transmitted as BigInt micro-units (value × 100_000 —
// Hub88 convention). Display as the currency's natural unit with locale
// formatting. Always render inside <code> for consistent monospace alignment.

const MICRO = 100_000n;

interface Props {
  micro: string | bigint | number | null | undefined;
  currency: string;
  signed?: boolean;
  fractionDigits?: number;
}

export function microToDecimal(micro: string | bigint | number, fractionDigits = 2): string {
  const m = typeof micro === 'bigint' ? micro : BigInt(String(micro));
  const negative = m < 0n;
  const abs = negative ? -m : m;
  const whole = abs / MICRO;
  const frac = abs % MICRO;
  // Pad frac to 5 digits, then trim/extend to requested fraction.
  const fracStr = frac.toString().padStart(5, '0').slice(0, Math.max(0, fractionDigits));
  const wholeStr = whole.toString();
  const result = fractionDigits > 0 ? `${wholeStr}.${fracStr}` : wholeStr;
  return negative ? `-${result}` : result;
}

export default function Money({ micro, currency, signed, fractionDigits = 2 }: Props) {
  if (micro === null || micro === undefined) {
    return <code className="mono mono--muted">—</code>;
  }

  let decimal: string;
  try {
    decimal = microToDecimal(micro, fractionDigits);
  } catch {
    return <code className="mono mono--muted">invalid</code>;
  }

  const negative = decimal.startsWith('-');
  const display =
    signed && !negative && decimal !== '0' && !decimal.startsWith('0.00')
      ? `+${decimal}`
      : decimal;

  return (
    <code className={`mono money${negative ? ' money--neg' : ''}`}>
      {display} <span className="money__ccy">{currency}</span>
    </code>
  );
}
