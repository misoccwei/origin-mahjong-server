import type { AILevel } from '../../shared/rules.js';

export const AI_LEVEL_LABEL: Record<AILevel, string> = { beginner: '初學者', easy: '簡單', normal: '普通', hard: '困難' };

/**
 * 數字輸入框。React 的受控 number input 在數值相同時不會改寫畫面上的字，
 * 所以 0 之後再打數字會變成「05」；這裡在輸入時先把開頭多餘的 0 去掉。
 */
export function NumInput({
  value,
  onChange,
  min,
  max,
  placeholder,
}: {
  value: number | undefined;
  /** 清空時為 undefined */
  onChange: (v: number | undefined) => void;
  min?: number;
  max?: number;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(e) => {
        const raw = e.target.value;
        const cleaned = raw.replace(/^0+(?=\d)/, '');
        if (cleaned !== raw) e.target.value = cleaned;
        onChange(cleaned === '' ? undefined : Number(cleaned));
      }}
    />
  );
}

export function AILevelSelect({ value, onChange, disabled }: { value: AILevel; onChange: (v: AILevel) => void; disabled?: boolean }) {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as AILevel)}>
      {(Object.keys(AI_LEVEL_LABEL) as AILevel[]).map((l) => (
        <option key={l} value={l}>
          {AI_LEVEL_LABEL[l]}
          {l === 'hard' ? '（會防守）' : ''}
        </option>
      ))}
    </select>
  );
}
