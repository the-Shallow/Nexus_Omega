import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/unbounded';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import './index.css';
import App from './App';
import { twin } from './lib/bus';
import { fleet } from './lib/fleet';
import { store } from './lib/store';

store.start();
// Handy for demos and debugging: window.nexus.fleet.start('run-8bf1324b')
(window as unknown as { nexus: unknown }).nexus = { store, twin, fleet };

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
