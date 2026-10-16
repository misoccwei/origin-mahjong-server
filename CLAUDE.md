# CLAUDE.md：給 AI 的專案上手指南

《原點麻將》多人連線伺服器＋網頁客戶端（TypeScript，Node 單一 process，無資料庫，React 前端）。
規則細節、玩家看得到的功能說明在 `README.md`；這份檔案只寫**改程式時需要知道的事**。

> **維護規則（必做）**：每次改動程式時，若影響到這份檔案描述的任何內容（架構、檔案位置、慣例、陷阱、指令、協定版本、測試結構），
> 在同一個 commit 裡一起更新這份檔案；新增功能時在「功能地圖」補一行。README 也一樣要跟著更新。

## 與使用者合作的方式

- 一律用**繁體中文**回覆；程式註解、README、commit message 也用繁體中文。
- 使用者常一次列出多個需求並要求「分成多個 commit」：**一個需求一個 commit**，訊息**言簡意賅**（一行、不加句號），結尾加上系統要求的 `Co-Authored-By` 行。只在使用者要求時才 commit；不要 push。
- 每個 commit 前：`npm run typecheck` 與 `npm test` 都要過；有畫面改動時實際開瀏覽器看（見下方「手動驗證」）。

## 指令

```bash
npm run dev          # 後端 :3000（tsx watch）
npm run dev:client   # 前端 :5173，/ws proxy 到 :3000
npm run build        # 型別檢查 + vite build 到 dist/client
npm start            # 正式模式，提供 dist/client；改程式或 build 後要重啟
npm test             # 全部測試（約 20 秒，最慢的是 AI 整場模擬）
npm run test:fast    # 略過 test/server/engine/simulation.test.ts（約 7 秒）
npm run typecheck
```

環境變數：`PORT`、`HOST`、`STATIC_DIR`、`AI_DELAY_MS`（預設 700）、`ICE_SERVERS`。

## 架構

```
src/shared/      前後端共用的純函式（無 I/O）
  tiles.ts       牌：TileKind 0–33（0–8 萬、9–17 筒、18–26 索、27–30 東南西北、31–33 中發白）；TileId = kind*4+copy（0–135）
  rules.ts       RuleSettings、defaultSettings、sanitizeSettings（所有設定都經過它驗證）、baseScoreFor、Meld 型別
  scoring.ts     YAKU 牌型表（id 如 '8.1'，系列＝前兩段）、evaluateWin、waitingKinds、bestTenpaiScore、scoreByWait
  settlement.ts  加分式／零和式結算
  shanten.ts     向聽數（一般形可處理不足 13 張、pairFixed）、七對子、十三么九
  recommend.ts   推薦牌型（普通型）：buildTargets 各牌型評估函式（evaluate 向聽數、chance 特定牌的和牌率）、winProbability、recommendYaku、suggestPass、fastestWin
  outcome.ts     推薦牌型（進階型）：展開摸／碰／吃到和牌，逐巡算和牌率與期望得分（只算 ≤2 向聽），可帶 claim 比較鳴與不鳴
  protocol.ts    WebSocket 訊息與快照型別、PROTOCOL_VERSION
  replaySchema.ts 回放檔格式（只有型別與 REPLAY_SCHEMA_VERSION，不 import 任何東西）
  replay.ts      回放檔讀取（parseReplay：檢查、MIGRATIONS 舊版轉換）、匿名、播放（replayFrame：從配牌套用前 N 個事件）
  yakuInfo.ts    牌型表的說明與牌例
src/server/
  engine/hand.ts   一局的狀態機（配牌、換三張、摸打、吃碰槓、搶槓、嶺上、流局、結果）
  engine/match.ts  一場：局數、起始玩家輪替、累計分數、小牌限制、加圈
  engine/ai.ts     AI（beginner/easy/normal/hard）與 autoAction（自動摸打／自動和牌／不鳴牌）
  room.ts          房間：座位、房主、準備、計時、AI 排程、暫停、隨機座位、重看資料與回放紀錄（replays、replayFile）、快照（roomView/gameView）
  replay.ts        replayHandOf：把引擎的一局（hand.deal、hand.replayLog、result）轉成回放檔格式
  server.ts        HTTP 靜態檔 + /ws；把訊息分派給 Room；錯誤訊息是固定中文字串
  users.ts / identity.ts  暱稱、公鑰簽章登入
src/client/
  net.ts           連線與全域狀態（useAppState）、toast、request（等伺服器回覆）
  i18n/            多國語言（index.ts：t/tn/setLang/useLang/tileLabel/windShort/playerName；en.ts、ja.ts 字典）
  components/Table.tsx      牌桌（直式／橫式兩種版面）、操作按鈕、提示、推薦牌型面板、局結果（ResultBody 可重用）
  components/RoomScreens.tsx 等待房間、最終結算（含重看各局 ReplayModal）、各局紀錄
  components/Lobby.tsx      暱稱、大廳、規則設定表單 SettingsForm、LangSelect
  components/Replay.tsx     回放頁面（#replay 路由、選擇檔案、播放控制；轉成 RoomView/GameView 交給 Table.tsx 的 Board，faceUp 讓手牌正面朝上）
  exportImage.ts   結算畫面用 canvas 畫成 PNG（手機分享、電腦下載）
  voice.ts / components/Voice.tsx  WebRTC 語音
```

伺服器握有全部狀態；每位玩家只拿到自己能看的快照（他人手牌與暗槓遮蔽、局結果只公開和牌／聽牌／主動展示者）。改 `gameView`/`roomView` 時注意不要洩漏手牌（`server.test.ts` 有測）。

## 必須遵守的慣例與陷阱

- **協定版本**：改了 `protocol.ts` 的程式（訊息、快照欄位），或改了快照裡的 `RuleSettings` 形狀，就把 `PROTOCOL_VERSION` 加一，並依 `test/shared/protocol.test.ts` 失敗訊息更新 `RECORDED`（version 與 hash）。只改註解不必加版本（hash 已去掉註解）。目前版本：**20**。
- **回放檔格式**：分享出去的檔案會留很久。`replaySchema.ts` 的程式（註解除外）一改，`test/shared/replay.test.ts` 就會失敗：
  把 `REPLAY_SCHEMA_VERSION` 加一、在 `replay.ts` 的 `MIGRATIONS` 寫舊版 → 新版的轉換、放新版範例檔 `test/fixtures/replay-vN.json`（舊的保留），再更新 `RECORDED`。
  回放只記事件、不重跑規則，所以改規則／計分／AI／協定**不必**動回放版本；但引擎新增會改變牌桌的動作時，要在 `hand.ts` 推進 `replayLog`、在 `replayFrame` 處理（`test/server/replay.test.ts` 會檢查每一步牌數守恆、播完與局結果一致）。
- **新增規則設定**：`rules.ts` 的 `RuleSettings`＋`defaultSettings`＋`sanitizeSettings`（範圍檢查）→ `Lobby.tsx` 的 `SettingsForm` → 需要時 `RoomScreens.tsx` 的 `rulesSummary` → `test/shared/rules.test.ts` → 翻譯 → README → 協定版本加一。
- **多國語言（最常踩的坑）**：
  - 所有看得到的字都要包 `t('繁中原文')`；含元件（例如牌）的用 `tn('打出 {tile}', { tile: <Tile …/> })`；變數用 `{name}`，不要用字串串接拼句子（語序不同）。
  - 新增／修改任何中文字串都要在 `src/client/i18n/en.ts`、`ja.ts` 補翻譯；`test/client/i18n.test.tsx` 會掃描整個 `src/client`、伺服器訊息（`fail('…')`、`message:`、`reason:`、`error:`、hand.act 的 `return '…'`）、共用模組的 `new ReplayError('…')`、牌型名稱／說明，缺翻譯、`{變數}` 不一致、字典有多餘字串都會失敗，也會渲染英文畫面檢查沒有殘留漢字。
  - 伺服器錯誤訊息必須是**固定字串**（不要用模板字串），網頁端才能翻譯。
  - 電腦玩家名字由伺服器取為「電腦 N」，顯示一律用 `playerName(p)`；牌名用 `tileLabel(k)`；門風用 `windShort(k)`。
  - 不要在模組最外層呼叫 `t()`（只會在載入時算一次，切換語言不會更新）。
  - **變數名不要叫 `t`**：Table.tsx 等檔案已匯入翻譯函式 `t`，區域變數會遮蔽它（曾因 `const t = tenpaiOf(s)` 出錯，現在用 `tp`）。
- **版面**：手機直式工具列寬度很緊（320px 也要放得下）；新增按鈕或長文字時三種語言都要檢查不超出畫面。直式／橫式由 `(min-aspect-ratio: 5/4)` 切換，CSS 以 `.table.portrait` / `.table.landscape` 區分。
- **推薦牌型的向聽數必須同時符合和牌形與牌型條件**：
  - 需要特定面子的牌型用 `required([...])`：向聽數＝指定面子缺的張數＋其餘牌的 `shantenStandard(rest, 面子數, pairFixed)`，兩者**相加**，不要取最大值。
  - 限定牌種的牌型用 `restricted()`；「缺幾張」是要摸的張數＝向聽數＋1，別混用。
  - 會用 `unseen`（4 − 看得到的張數）排除已經不可能的牌型。
  - `test/shared/recommendShape.test.ts` 用隨機手牌驗證（聽牌就和得出來、牌例算聽牌、每一步都能前進）；新增牌型目標時一定要讓它通過。
- **推薦牌型的和牌率**：一般模型（`winProbability`）的參數 `TENPAI_UKEIRE`／`UKEIRE_DECAY`／`RESTRICTED_TENPAI_UKEIRE` 是用模擬自摸打牌擬合的；
  一定要拿到特定牌的牌型要給 `chance`（特定牌拿得到的機率 × 其餘部分），只看有效牌會嚴重高估（anyOf 合併有效牌、其餘部分的牌被算進來）。
  同一牌型的不同做法要分開成多個目標（id 相同），不要合併。改模型時用模擬比對預測與實際和牌率（單人模擬時記得吃碰要關掉：`players: 1`）。
- **進階型的效能**：`outcome.ts` 最壞約 0.5 秒（2 向聽、手上 14 張）。為了做牌而鳴（向聽數不變）只在一向聽以內展開、改聽只在目前已聽牌時展開，放寬會讓局面數暴增；前端在 `useEffect` 裡算，不要改回 `useMemo`。
- **效能**：AI（normal/hard）每一步都呼叫 `recommendYaku`；評估函式會被呼叫上千次，避免在裡面配置陣列或產生字串。`shantenStandard` 以 5 進位整數為快取 key。改了之後看 `simulation.test.ts` 的「4人困難 AI」時間（約 10 秒，明顯變慢要處理）。
- **等伺服器回覆的按鈕**：用 `Busy.tsx` 的 `ReqButton`（`run` 回傳 `request()`／`act()` 的 Promise）或 `useRequest`；`request()` 會帶 `rid`，伺服器處理完回 `done`。等待中按鈕轉圈圈、其他請求按鈕點了沒作用。定時自動送的訊息（`listRooms`、語音 `rtc`）用 `send()`，不要用 `request()`（否則會一直擋住按鈕）。
- **計時與測試**：`RoomDeps.resultMs` 只給測試用來縮短結算倒數；正式由 `settings.resultSeconds` 決定（0 = 等所有人按下一局）。
- **單人對 AI**：只有一位真人、其餘全是 AI 時（`Room.isSolo()`）不限時（含結算不倒數；換三張亮牌照常倒數 3 秒）、局結束公開 AI 手牌、可以「交給 AI 打完」（`fastFinish`，只管一局；每步不間隔、過程中不推送，打完才 notify）或「電腦代打」（`Seat.aiPlay`，照正常速度、持續到自己關掉）。測試要驗證限時、逾時或手牌遮蔽時，房間裡至少要有兩位真人（`server.test.ts` 的 `duoRoom`），否則會落入單人模式。
- **隨機座位預設開啟**：WebSocket 測試客戶端建立房間時預設送 `randomSeats: false`（`test/support/wsClient.ts`），測試要固定座位才不會亂。
- **自動功能**：自動摸打、自動和牌只維持一局（局一結束，`schedule` 進入結果時就關掉，所以最後一局後加一圈不會沿用）；`fastFinish` 在 `advanceHand` 清掉、電腦代打（`aiPlay`）整場結束時清掉；不鳴牌（`noCall`）持續有效。自動和只在和牌分數達到這副聽牌的最高分（`winPreview().best`）時才自動，否則 `autoAction` 回傳 null 交給玩家；沒有時限的測試要用 `answerAutoStop` 替玩家回答。

## 測試結構（對應 src）

```
test/shared/        scoring、settlement、rules、recommend、recommendShape、outcome、yakuInfo、protocol、replay（格式版本、讀取、範例檔）
test/server/engine/ hand（指定牌山情境）、match、ai（AI 決策與 autoAction）、simulation（AI 整場模擬，慢）
test/server/        room（Room 單元測試，vi.useFakeTimers＋固定亂數）、server（WebSocket 整合）、replay（回放紀錄重現每一步）
test/client/        table、result、screens、yakuTable、replay、i18n（伺服器渲染快照）
test/fixtures/      每一版回放檔格式的範例檔
test/support/       tiles（uni('🀇🀈') 牌、meld()）、hand（buildWall/makeHand/autoplayUntil/seededRng/playMatch）、
                    wsClient（Client、newKey、waitMyTurn、answerAutoStop）、snapshots（room()/game()/player()/render()/text()/appState()）、i18nKeys
```

- 畫面測試用 `text(html)` 比對看得到的文字，不要比對 React 的 `<!-- -->` 標記。
- 引擎情境：`makeHand([座位0, 座位1, …手牌], '之後依序摸的牌', settings)`，手牌用 Unicode 麻將字元。
- 房間的時間相關行為優先寫在 `room.test.ts`（快、可控），跨連線的行為才放 `server.test.ts`。

## 手動驗證（瀏覽器）

有 chrome-devtools MCP 時：
1. `npm run build`，背景啟動 `PORT=3456 AI_DELAY_MS=300 npm start`（輸出導到 scratchpad）。
2. `new_page http://localhost:3456`（可用 `isolatedContext`），`emulate` 手機尺寸，例如 `390x844x2,mobile,touch`、`844x390x2,mobile,touch,landscape`、`1280x800x1`。
3. 用 `evaluate_script` 自動走流程：填暱稱（用原生 setter + `input` 事件）→「建立房間」→「加入 AI」×3 →「開始」→「不換」；可以開「自動摸打」快速打到結算。語言可設 `localStorage.lang = 'en'|'ja'|'zh'` 後重新整理，或用右上角 ⚙ 選單的語言選單即時切換。
4. 檢查超出畫面：比較元素 `getBoundingClientRect()` 與 `document.documentElement.clientWidth`。
5. 只改前端時 `npx vite build` 後重新整理即可（伺服器不用重啟，牌局狀態會保留）；改後端要重啟伺服器（狀態會清空）。
6. 結束時停掉伺服器（`pkill -f "tsx src/server/index.ts"`）。

## 功能地圖（找程式從這裡開始）

| 功能 | 主要位置 |
| --- | --- |
| 打牌、鳴牌按鈕（含固定位置的「打出」） | Table.tsx `CallOverlay`、`useMyArea` |
| 鳴牌排列（轉橫的牌朝向來源座位） | rules.ts `meldTileOrder`、Table.tsx `MeldView` |
| 聽牌／打出前提示每張聽牌的牌型與分數（依分數高到低排列） | Table.tsx `Waits`/`DiscardWaits`/`WaitList`（`waitRows` 自摸、銃和分開算並排序）；局結果的聽牌順序來自 scoring.ts `bestTenpaiScore` |
| 自摸／和按鈕上的分數與牌型 | hand.ts `winScoreView`（`AvailableActions.winScore`）、Table.tsx `winLabel` |
| 推薦牌型（普通型／進階型切換、鳴牌時比較鳴與不鳴；「劃掉的牌 → 要的牌」圖示） | Table.tsx `RecoPanel`/`BasicReco`/`OutcomeReco`/`DrawPlan`、recommend.ts（`wanted` 只在最後選出的推薦上算）、outcome.ts |
| AI 策略（依和牌最低分數、換三張） | ai.ts `decideAction`（`recInput`、`needsYaku`、`suggestPass`） |
| 不鳴牌、自動摸打、自動和牌 | ai.ts `autoAction`、room.ts `setAuto`/`autoOpts`、Table.tsx `useMyArea`（工具列） |
| ⚙ 選單（右上角，與局數、倒數同一排） | Table.tsx `ToolsMenu`/`TopBar` |
| 結算倒數、局結果、重看各局 | room.ts `schedule`/`advanceHand`/`resultView`/`replays`、Table.tsx `ResultBody`、RoomScreens.tsx `ReplayModal` |
| 匯出結算圖片 | exportImage.ts、components/ExportButton.tsx |
| 隨機座位 | room.ts `shuffleSeats`（房主、讓分跟著人走） |
| 觀戰 | room.ts `spectate`/`spectators`、Table.tsx `SpectatorLayout` |
| 四角名牌（門風、分數）、中央餘牌與打出的牌、局數與倒數（直式最上面、橫式右上） | Table.tsx `NamePlate`/`Center`/`TopBar`、styles.css `.table.landscape` |
| 多國語言 | src/client/i18n/、`LangSelect` |
| 語音 | voice.ts、components/Voice.tsx、server.ts `rtc` 轉送 |
| 等待伺服器回覆（轉圈圈、防連點） | net.ts `request`、components/Busy.tsx、server.ts `done` |
| 單人對 AI（不限時、公開 AI 手牌、交給 AI 打完這一局、電腦代打） | room.ts `isSolo`/`finishHandByAI`/`setAIPlay`/`decidedByAI`、Table.tsx `FastFinish`、`ToolsMenu`、`useMyArea`（代打中的工具列） |
| 斷線暫停、AI 代打 | room.ts `updatePause`/`decide` |
| 牌局回放（儲存回放檔、#replay 回放頁面） | replaySchema.ts、replay.ts（shared／server）、hand.ts `replayLog`、room.ts `replayFile`、RoomScreens.tsx `SaveReplay`、Replay.tsx |
