import { useState } from 'react';
import type { RoomView } from '../../shared/protocol.js';
import { useAppState } from '../net.js';
import { setDevice, setPtt, setPttDown, toggleMic, togglePeerMute, toggleSpeaker, useVoice } from '../voice.js';
import { playerName, t } from '../i18n/index.js';

const MicIcon = ({ off }: { off?: boolean }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V22h2v-3.08A7 7 0 0 0 19 12h-2Z" />
    {off && <path d="M4 4l16 16" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />}
  </svg>
);

const SpeakerIcon = ({ off }: { off?: boolean }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path fill="currentColor" d="M3 9v6h4l5 4V5L7 9H3Z" />
    {off ? <path d="M15 9l6 6m0-6l-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /> : <path fill="currentColor" d="M15.5 8.5a5 5 0 0 1 0 7l-1.4-1.4a3 3 0 0 0 0-4.2l1.4-1.4Z" />}
  </svg>
);

/** 牌桌工具列上的麥克風、喇叭開關（語音未開啟時不顯示） */
export function VoiceButtons() {
  const v = useVoice();
  const me = useAppState().userId;
  if (!v.active) return null;
  const micLive = v.micOn && v.mic === 'ok';
  return (
    <>
      <button
        className={`chip-btn icon voice-mic ${micLive ? 'on' : ''} ${micLive && !!me && v.speaking[me] ? 'speaking' : ''}`}
        aria-pressed={micLive}
        aria-label={micLive ? t('關閉麥克風') : t('開啟麥克風')}
        title={v.mic === 'denied' ? t('麥克風未授權') : v.mic === 'none' ? t('找不到麥克風') : micLive ? t('麥克風開啟') : t('麥克風關閉')}
        onClick={() => void toggleMic()}
      >
        <MicIcon off={!micLive} />
      </button>
      <button className={`chip-btn icon ${v.speakerOn ? 'on' : ''}`} aria-pressed={v.speakerOn} aria-label={v.speakerOn ? t('關閉喇叭') : t('開啟喇叭')} title={v.speakerOn ? t('喇叭開啟') : t('喇叭關閉')} onClick={toggleSpeaker}>
        <SpeakerIcon off={!v.speakerOn} />
      </button>
      {v.ptt && (
        <button
          className={`chip-btn ptt ${v.pttDown ? 'on' : ''}`}
          onPointerDown={(e) => (e.currentTarget.setPointerCapture(e.pointerId), setPttDown(true))}
          onPointerUp={() => setPttDown(false)}
          onPointerCancel={() => setPttDown(false)}
          onContextMenu={(e) => e.preventDefault()}
        >
          {t('按住說話')}
        </button>
      )}
    </>
  );
}

/** 名字旁的說話指示／靜音圖示（自己與其他玩家） */
export function VoiceMark({ userId }: { userId: string | null }) {
  const v = useVoice();
  if (!v.active || !userId) return null;
  const speaking = !!v.speaking[userId];
  const off = v.peerMic[userId] === false;
  const muted = !!v.muted[userId];
  if (!speaking && !off && !muted) return null;
  return (
    <span className={`voice-mark ${speaking ? 'speaking' : ''}`} title={muted ? t('已被你靜音') : off ? t('麥克風關閉') : t('說話中')} aria-label={muted ? t('已靜音') : off ? t('麥克風關閉') : t('說話中')}>
      {muted ? <SpeakerIcon off /> : off ? <MicIcon off /> : <MicIcon />}
    </span>
  );
}

/** 語音設定：麥克風裝置、按鍵說話、各玩家的說話狀態與單獨靜音 */
export function VoiceSettings({ room }: { room: RoomView }) {
  const v = useVoice();
  const userId = useAppState().userId;
  if (!v.active) return <p className="muted small">{t('語音會在牌局開始時開啟，直到離開房間。')}</p>;
  const others = room.players.filter((p) => p.userId && !p.isAI && p.userId !== userId);
  return (
    <div className="voice-settings">
      {v.mic === 'denied' && <p className="small warn-text">{t('麥克風未授權，目前只能收聽。請在瀏覽器網址列允許麥克風權限後，按麥克風按鈕重試。')}</p>}
      {v.mic === 'none' && <p className="small warn-text">{t('找不到麥克風，目前只能收聽。')}</p>}
      <label className="toggle row">
        {t('麥克風')}
        <select value={v.deviceId} disabled={v.devices.length === 0} onChange={(e) => void setDevice(e.target.value)}>
          {v.devices.length === 0 && <option value="">{t('（無）')}</option>}
          {v.devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={v.ptt} onChange={(e) => setPtt(e.target.checked)} />
        {t('按鍵說話（按住 V 鍵或畫面上的按鈕）')}
      </label>
      <ul className="voice-peers">
        {others.length === 0 && <li className="muted small">{t('房間裡沒有其他真人玩家')}</li>}
        {others.map((p) => (
          <li key={p.seat}>
            <span className={`voice-dot ${v.speaking[p.userId!] ? 'speaking' : ''}`} />
            <span className="nm">{playerName(p)}</span>
            {v.peerMic[p.userId!] === false && <span className="muted small">{t('麥克風關閉')}</span>}
            <button className={`link ${v.muted[p.userId!] ? 'on' : ''}`} onClick={() => togglePeerMute(p.userId!)}>
              {v.muted[p.userId!] ? t('取消靜音') : t('靜音')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 等待房間／結算畫面上的語音區塊：開關與設定 */
export function VoicePanel({ room }: { room: RoomView }) {
  const v = useVoice();
  const [open, setOpen] = useState(false);
  if (!v.active) return null;
  return (
    <div className="voice-panel">
      <div className="voice-panel-head">
        <b>{t('語音')}</b>
        <span className="voice-btns">
          <VoiceButtons />
        </span>
        <button className="link" onClick={() => setOpen((x) => !x)}>
          {open ? t('收起') : t('設定')}
        </button>
      </div>
      {open && <VoiceSettings room={room} />}
    </div>
  );
}
