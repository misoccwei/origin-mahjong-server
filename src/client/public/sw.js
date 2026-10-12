// 最小的 Service Worker：讓瀏覽器把網站當成可安裝的 App（加到主畫面後全螢幕開啟）。
// 不做任何快取，所有請求都直接走網路：避免舊版網頁被快取住而與伺服器版本不一致。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // 不攔截：交給瀏覽器照常處理
});
