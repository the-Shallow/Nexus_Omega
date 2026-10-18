import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/instrument-sans';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import './index.css';
import App from './App';
import { store } from './lib/store';
import { twin } from './lib/bus';

store.start();
// Handy for demos and debugging: window.nexus.twin.get().preset('top')
(window as unknown as { nexus: unknown }).nexus = { store, twin };

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
