import { LobbyScreen, NicknameScreen } from './components/Lobby.js';
import { FinalScreen, WaitingRoom } from './components/RoomScreens.js';
import { TableScreen } from './components/Table.js';
import { useAppState } from './net.js';

export function App() {
  const state = useAppState();
  let body;
  if (state.fatal) body = <div className="panel narrow"><h2>無法連線</h2><p>{state.fatal}</p></div>;
  else if (!state.authed) body = <div className="panel narrow">連線中…</div>;
  else if (!state.nickname) body = <NicknameScreen state={state} />;
  else if (!state.room) body = <LobbyScreen state={state} />;
  else if (state.room.status === 'waiting') body = <WaitingRoom room={state.room} />;
  else if (state.room.status === 'finished') body = <FinalScreen room={state.room} />;
  else body = <TableScreen state={state} />;
  return (
    <>
      {state.conn !== 'open' && state.authed === false && state.nickname && <div className="banner">重新連線中…</div>}
      {body}
      {state.toast && <div className="toast" key={state.toast.id}>{state.toast.text}</div>}
    </>
  );
}
