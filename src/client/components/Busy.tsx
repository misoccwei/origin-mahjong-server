import { useState, type ButtonHTMLAttributes } from 'react';
import { useAppState } from '../net.js';

/** 轉圈圈（行內，跟著文字大小） */
export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

/** 蓋在按鈕上的轉圈圈：稍等一下才出現，伺服器很快回覆時不會閃一下 */
export function BusyVeil() {
  return <span className="busy-veil" aria-hidden="true" />;
}

/**
 * 送出請求並等伺服器回覆：等待中 busy = true。
 * 任何請求還在等回覆時不再送出新的，避免連點或在畫面還沒更新前亂點。
 */
export function useRequest() {
  const anyPending = useAppState().pending.length > 0;
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => unknown) => {
    if (busy || anyPending) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

/** 送出請求的按鈕：run 回傳 request()／act() 的 Promise，等待中顯示轉圈圈、不能再按 */
export function ReqButton({ run: fn, className, children, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & { run: () => unknown }) {
  const { busy, run } = useRequest();
  return (
    <button className={busy ? `${className ?? ''} busy`.trim() : className} {...rest} aria-busy={busy || undefined} onClick={() => void run(fn)}>
      {children}
      {busy && <BusyVeil />}
    </button>
  );
}
