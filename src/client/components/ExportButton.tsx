import { useState } from 'react';
import { exportImage } from '../exportImage.js';

/** 把結算畫面匯出成圖片（手機分享／存到相簿，電腦下載） */
export function ExportButton({ render, filename }: { render: () => Promise<HTMLCanvasElement>; filename: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await exportImage(render, filename);
        setBusy(false);
      }}
    >
      {busy ? '產生中…' : '匯出圖片'}
    </button>
  );
}
