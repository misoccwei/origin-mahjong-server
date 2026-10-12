import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { connect } from './net.js';
import './styles.css';

connect();
createRoot(document.getElementById('root')!).render(<App />);
