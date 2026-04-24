interface Props {
  value: boolean;
  onChange(next: boolean): void;
}

export function TestToggle({ value, onChange }: Props) {
  return (
    <label className="test-toggle" title="Test-mode operators are excluded from production reports and billing.">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>Include test operators</span>
    </label>
  );
}
