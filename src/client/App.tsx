import { LobbyScreen, NicknameScreen } from './components/Lobby.js';
import { FinalScreen, WaitingRoom } from './components/RoomScreens.js';
import { TableScreen } from './components/Table.js';
import { ReplayScreen, useReplayRoute } from './components/Replay.js';
import { useEffect } from 'react';
import { useAppState } from './net.js';
import { Spinner } from './components/Busy.js';
import { syncVoice } from './voice.js';
import { t, useLang } from './i18n/index.js';

export function App() {
  const state = useAppState();
  const replay = useReplayRoute();
  // 切換語言時整個畫面重新渲染
  useLang();
  // 語音跟著房間：開始牌局時開啟、離開房間時關閉（切換畫面不會中斷）
  useEffect(() => syncVoice(state.room, state.userId), [state.room, state.userId]);
  let body;
  // 回放頁面不需要連線（網址 #replay）
  if (replay.active) body = <ReplayScreen file={replay.file} />;
  else if (state.fatal) body = <div className="panel narrow"><h2>{t('無法連線')}</h2><p>{t(state.fatal)}</p></div>;
  else if (!state.authed) body = <div className="panel narrow"><Spinner />{t('連線中…')}</div>;
  else if (!state.nickname) body = <NicknameScreen state={state} />;
  else if (!state.room) body = <LobbyScreen state={state} />;
  else if (state.room.status === 'waiting') body = <WaitingRoom room={state.room} />;
  else if (state.room.status === 'finished') body = <FinalScreen room={state.room} />;
  else body = <TableScreen state={state} />;
  return (
    <>
      {state.conn !== 'open' && state.authed === false && state.nickname && <div className="banner"><Spinner />{t('重新連線中…')}</div>}
      {body}
      {state.toast && <div className="toast" key={state.toast.id}>{state.toast.text}</div>}
    </>
  );
}
