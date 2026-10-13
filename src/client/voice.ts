// 房間語音：WebRTC P2P mesh（最多 4 人）。伺服器只轉送 signaling（net.ts 的 rtc 訊息）。
// 生命週期：房間開始牌局時開啟，直到離開房間（或房間關閉）才關閉；牌局結束回到等待畫面時仍保持。
// 麥克風預設關閉：開啟語音時只收聽，玩家按下麥克風按鈕時才向瀏覽器要權限。
import { t } from './i18n/index.js';
import { useSyncExternalStore } from 'react';
import type { RoomView, RtcSignal } from '../shared/protocol.js';
import { rtcListeners, send, toast } from './net.js';

export interface VoiceDevice {
  id: string;
  label: string;
}

export interface VoiceState {
  active: boolean;
  micOn: boolean;
  speakerOn: boolean;
  /** 按鍵說話：開啟時只有按住（V 鍵或畫面按鈕）才會送出聲音 */
  ptt: boolean;
  pttDown: boolean;
  /** 麥克風權限／裝置狀態：unknown = 尚未要求 */
  mic: 'unknown' | 'ok' | 'denied' | 'none';
  devices: VoiceDevice[];
  deviceId: string;
  /** 正在說話的使用者（含自己） */
  speaking: Record<string, boolean>;
  /** 對方的麥克風是否開著（未知視為開） */
  peerMic: Record<string, boolean>;
  /** 我單獨靜音的玩家 */
  muted: Record<string, boolean>;
  /** 瀏覽器擋住自動播放，需要使用者點一下 */
  needGesture: boolean;
}

const PREF_KEY = 'origin-mahjong-voice';

function loadPrefs(): { deviceId: string; ptt: boolean; muted: Record<string, boolean> } {
  try {
    const v = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}');
    return { deviceId: typeof v.deviceId === 'string' ? v.deviceId : '', ptt: !!v.ptt, muted: v.muted && typeof v.muted === 'object' ? v.muted : {} };
  } catch {
    return { deviceId: '', ptt: false, muted: {} };
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ deviceId: state.deviceId, ptt: state.ptt, muted: state.muted }));
  } catch {
    /* 無痕模式等情況無法儲存，忽略 */
  }
}

const initial = (): VoiceState => {
  const p = typeof localStorage === 'undefined' ? { deviceId: '', ptt: false, muted: {} } : loadPrefs();
  return { active: false, micOn: false, speakerOn: true, ptt: p.ptt, pttDown: false, mic: 'unknown', devices: [], deviceId: p.deviceId, speaking: {}, peerMic: {}, muted: p.muted, needGesture: false };
};

let state: VoiceState = initial();
const listeners = new Set<() => void>();

function set(patch: Partial<VoiceState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useVoice(): VoiceState {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
    () => state,
  );
}

// ---- 內部狀態 ----

interface Peer {
  id: string;
  sid: string | null;
  pc: RTCPeerConnection | null;
  audio: HTMLAudioElement | null;
  pending: RTCIceCandidateInit[];
  retry: ReturnType<typeof setTimeout> | null;
}

const sid = Math.random().toString(36).slice(2, 12);
let myId: string | null = null;
let roomId: string | null = null;
let stream: MediaStream | null = null;
let track: MediaStreamTrack | null = null;
let iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
const peers = new Map<string, Peer>();
let audioCtx: AudioContext | null = null;
const analysers = new Map<string, { node: AnalyserNode; buf: Float32Array<ArrayBuffer>; last: number }>();
let meter: ReturnType<typeof setInterval> | null = null;

const supported = () => typeof window !== 'undefined' && typeof RTCPeerConnection !== 'undefined' && !!navigator.mediaDevices;

/** 實際送出聲音：麥克風開著，且（非 PTT 或正按住） */
function transmitting() {
  return state.micOn && state.mic === 'ok' && (!state.ptt || state.pttDown);
}

function applyTrack() {
  if (track) track.enabled = transmitting();
}

function signal(to: string, data: RtcSignal) {
  send({ t: 'rtc', to, data });
}

function broadcastStatus() {
  const mic = state.micOn && state.mic === 'ok';
  peers.forEach((p) => signal(p.id, { k: 'status', sid, mic }));
}

// ---- 說話偵測 ----

function watch(id: string, s: MediaStream) {
  if (!audioCtx) return;
  try {
    const node = audioCtx.createAnalyser();
    node.fftSize = 512;
    audioCtx.createMediaStreamSource(s).connect(node);
    analysers.set(id, { node, buf: new Float32Array(node.fftSize) as Float32Array<ArrayBuffer>, last: 0 });
  } catch {
    /* 無法偵測說話，只是不顯示指示 */
  }
}

function startMeter() {
  if (meter) return;
  meter = setInterval(() => {
    const now = Date.now();
    const next: Record<string, boolean> = {};
    analysers.forEach((a, id) => {
      a.node.getFloatTimeDomainData(a.buf);
      let sum = 0;
      for (const v of a.buf) sum += v * v;
      if (Math.sqrt(sum / a.buf.length) > 0.02) a.last = now;
      if (now - a.last < 400) next[id] = true;
    });
    const cur = state.speaking;
    const same = Object.keys(next).length === Object.keys(cur).length && Object.keys(next).every((k) => cur[k]);
    if (!same) set({ speaking: next });
  }, 100);
}

// ---- 麥克風 ----

async function listDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const devices = all.filter((d) => d.kind === 'audioinput' && d.deviceId).map((d, i) => ({ id: d.deviceId, label: d.label || t('麥克風 {n}', { n: i + 1 }) }));
    set({ devices });
  } catch {
    /* 忽略 */
  }
}

async function acquireMic(deviceId = state.deviceId): Promise<boolean> {
  if (!supported()) {
    set({ mic: 'none', micOn: false });
    return false;
  }
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (!state.active) {
      s.getTracks().forEach((t) => t.stop());
      return false;
    }
    const old = stream;
    stream = s;
    track = s.getAudioTracks()[0] ?? null;
    old?.getTracks().forEach((t) => t.stop());
    analysers.delete(myId ?? '');
    if (myId) watch(myId, s);
    const settingsId = track?.getSettings().deviceId;
    set({ mic: 'ok', deviceId: settingsId ?? deviceId });
    applyTrack();
    // 已建立的連線直接換軌道，不需要重新協商
    for (const p of peers.values()) await p.pc?.getSenders().find((x) => x.track?.kind === 'audio' || x.track === null)?.replaceTrack(track);
    await listDevices();
    broadcastStatus();
    return true;
  } catch (e) {
    const name = (e as DOMException)?.name;
    // 記住的裝置已不存在時，退回預設裝置再試一次
    if (deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) return acquireMic('');
    set({ mic: name === 'NotFoundError' ? 'none' : 'denied', micOn: false });
    return false;
  }
}

// ---- 連線 ----

function closePeerConn(p: Peer) {
  if (p.retry) clearTimeout(p.retry);
  p.retry = null;
  analysers.delete(p.id);
  if (p.pc) {
    p.pc.ontrack = p.pc.onicecandidate = p.pc.onconnectionstatechange = null;
    p.pc.close();
  }
  p.pc = null;
  if (p.audio) {
    p.audio.srcObject = null;
    p.audio.remove();
  }
  p.audio = null;
  p.pending = [];
}

function applyMute(p: Peer) {
  if (p.audio) p.audio.muted = !state.speakerOn || !!state.muted[p.id];
}

function playAudio(p: Peer) {
  p.audio?.play().then(
    () => state.needGesture && set({ needGesture: false }),
    () => set({ needGesture: true }),
  );
}

function makePc(p: Peer): RTCPeerConnection {
  closePeerConn(p);
  const pc = new RTCPeerConnection({ iceServers });
  p.pc = pc;
  // 一律建立雙向的 audio transceiver：沒有麥克風時也能收聽，之後取得麥克風只要 replaceTrack
  if (track) pc.addTrack(track, stream!);
  else pc.addTransceiver('audio', { direction: 'sendrecv' });
  pc.onicecandidate = (e) => {
    if (e.candidate) signal(p.id, { k: 'ice', sid, candidate: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex } });
  };
  pc.ontrack = (e) => {
    const remote = e.streams[0] ?? new MediaStream([e.track]);
    if (!p.audio) {
      p.audio = document.createElement('audio');
      p.audio.autoplay = true;
      p.audio.style.display = 'none';
      document.body.appendChild(p.audio);
    }
    p.audio.srcObject = remote;
    applyMute(p);
    watch(p.id, remote);
    playAudio(p);
  };
  pc.onconnectionstatechange = () => {
    // 連線失敗時由 offer 端重新協商；answer 端等對方的新 offer
    if (pc.connectionState === 'failed' && p.pc === pc && isOfferer(p.id)) {
      p.retry = setTimeout(() => state.active && p.pc === pc && void startOffer(p), 1500);
    }
  };
  return pc;
}

/** userId 較小的一方負責送 offer */
const isOfferer = (other: string) => !!myId && myId < other;

async function startOffer(p: Peer) {
  if (!p.sid) return;
  const pc = makePc(p);
  try {
    await pc.setLocalDescription(await pc.createOffer());
    signal(p.id, { k: 'offer', sid, sdp: pc.localDescription!.sdp });
  } catch {
    /* 連線失敗會由 connectionstatechange 重試 */
  }
}

function getPeer(id: string): Peer {
  let p = peers.get(id);
  if (!p) {
    p = { id, sid: null, pc: null, audio: null, pending: [], retry: null };
    peers.set(id, p);
    signal(id, { k: 'hello', sid, mic: state.micOn && state.mic === 'ok' });
  }
  return p;
}

async function onSignal(from: string, data: RtcSignal) {
  if (!state.active || !ready || !peers.has(from)) return;
  const p = peers.get(from)!;
  if (data.k === 'hello') {
    if (p.sid === data.sid) return;
    // 對方重新整理過（或第一次出現）：丟掉舊連線，通知對方我在線上
    closePeerConn(p);
    p.sid = data.sid;
    set({ peerMic: { ...state.peerMic, [from]: data.mic } });
    signal(from, { k: 'hello', sid, mic: state.micOn && state.mic === 'ok' });
    if (isOfferer(from)) await startOffer(p);
    return;
  }
  if (p.sid !== data.sid) return;
  if (data.k === 'status') return set({ peerMic: { ...state.peerMic, [from]: data.mic } });
  try {
    if (data.k === 'offer') {
      const pc = makePc(p);
      await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      signal(from, { k: 'answer', sid, sdp: pc.localDescription!.sdp });
      await flush(p);
    } else if (data.k === 'answer') {
      if (p.pc?.signalingState === 'have-local-offer') {
        await p.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        await flush(p);
      }
    } else if (data.k === 'ice') {
      if (p.pc?.remoteDescription) await p.pc.addIceCandidate(data.candidate);
      else p.pending.push(data.candidate);
    }
  } catch {
    /* 過期的協商訊息，忽略 */
  }
}

async function flush(p: Peer) {
  const list = p.pending;
  p.pending = [];
  for (const c of list) await p.pc?.addIceCandidate(c).catch(() => {});
}

// ---- 生命週期 ----

async function start() {
  set({ ...initial(), active: true, speakerOn: true });
  if (!supported()) {
    set({ mic: 'none', micOn: false });
    toast(t('這個瀏覽器不支援語音（需要 HTTPS 或 localhost）'));
    return;
  }
  try {
    const r = await fetch('/ice-servers');
    if (r.ok) iceServers = await r.json();
  } catch {
    /* 用預設 STUN */
  }
  if (!state.active) return;
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  try {
    audioCtx = Ctx ? new Ctx() : null;
  } catch {
    audioCtx = null;
  }
  void audioCtx?.resume().catch(() => {});
  startMeter();
  await listDevices();
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', releasePtt);
  document.addEventListener('pointerdown', onGesture);
  navigator.mediaDevices.addEventListener?.('devicechange', listDevices);
  ready = true;
  syncPeers();
}

function stop() {
  ready = false;
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('keyup', onKey);
  window.removeEventListener('blur', releasePtt);
  document.removeEventListener('pointerdown', onGesture);
  navigator.mediaDevices?.removeEventListener?.('devicechange', listDevices);
  peers.forEach(closePeerConn);
  peers.clear();
  stream?.getTracks().forEach((t) => t.stop());
  stream = track = null;
  analysers.clear();
  if (meter) clearInterval(meter);
  meter = null;
  void audioCtx?.close().catch(() => {});
  audioCtx = null;
  state = { ...initial(), muted: state.muted, ptt: state.ptt, deviceId: state.deviceId };
  listeners.forEach((l) => l());
}

let wanted: string[] = [];
/** start() 完成（ICE servers 與麥克風都處理完）後才開始與他人建立連線 */
let ready = false;

/** 依房間成員增減連線 */
function syncPeers() {
  if (!state.active || !ready) return;
  const want = new Set(wanted);
  for (const [id, p] of peers) {
    if (!want.has(id)) {
      closePeerConn(p);
      peers.delete(id);
    }
  }
  for (const id of want) getPeer(id);
}

/**
 * 由 App 在房間狀態變動時呼叫。房間開始牌局時開啟語音，離開房間（或房間換了）才關閉。
 * 等待中的新房間不會自動開啟；牌局結束回到等待畫面時保持原狀。
 */
export function syncVoice(room: RoomView | null, userId: string | null) {
  myId = userId;
  if (!room || !userId || room.mySeat === null) {
    if (roomId !== null || state.active) {
      roomId = null;
      if (state.active) stop();
    }
    return;
  }
  if (roomId !== room.id) {
    if (state.active) stop();
    roomId = null;
  }
  if (!state.active && room.status === 'playing' && roomId === null) {
    roomId = room.id;
    void start();
  }
  if (roomId !== room.id) return;
  wanted = room.players.filter((p) => p.userId && !p.isAI && !p.left && p.userId !== userId).map((p) => p.userId!);
  syncPeers();
}

rtcListeners.add((from, data) => void onSignal(from, data));

// ---- 使用者操作 ----

export async function toggleMic() {
  if (!state.active) return;
  if (state.mic !== 'ok') {
    set({ micOn: true });
    if (!(await acquireMic())) toast(t(state.mic === 'denied' ? '無法使用麥克風：請在瀏覽器網址列允許麥克風權限' : '找不到麥克風'));
    return;
  }
  set({ micOn: !state.micOn });
  applyTrack();
  broadcastStatus();
}

export function toggleSpeaker() {
  set({ speakerOn: !state.speakerOn });
  peers.forEach(applyMute);
  if (state.speakerOn) peers.forEach(playAudio);
}

export function setPtt(on: boolean) {
  set({ ptt: on, pttDown: false });
  savePrefs();
  applyTrack();
}

export function setPttDown(down: boolean) {
  if (state.pttDown === down) return;
  set({ pttDown: down });
  applyTrack();
}

export async function setDevice(id: string) {
  set({ deviceId: id });
  savePrefs();
  // 還沒開過麥克風時只記下選擇，等按下麥克風按鈕才要權限
  if (state.active && state.mic === 'ok') await acquireMic(id);
}

export function togglePeerMute(id: string) {
  set({ muted: { ...state.muted, [id]: !state.muted[id] } });
  savePrefs();
  const p = peers.get(id);
  if (p) applyMute(p);
}

function releasePtt() {
  setPttDown(false);
}

function onGesture() {
  if (audioCtx?.state === 'suspended') void audioCtx.resume().catch(() => {});
  if (state.needGesture) peers.forEach(playAudio);
}

function onKey(e: KeyboardEvent) {
  if (!state.ptt || e.code !== 'KeyV' || e.repeat) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  setPttDown(e.type === 'keydown');
}
