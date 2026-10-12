import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { connect } from './net.js';
import './styles.css';

connect();
createRoot(document.getElementById('root')!).render(<App />);

// 註冊 Service Worker：讓網站可以「加到主畫面」，以全螢幕 App 的方式開啟（不受瀏覽器介面限制）
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
