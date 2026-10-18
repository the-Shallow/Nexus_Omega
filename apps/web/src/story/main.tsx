// Story mode entry. A scripted mockup: no WebSocket, no backend.
// ?specimen shows the block grammar; anything else plays the story.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/instrument-sans';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '../index.css';
import './story.css';
import Specimen from './Specimen';
import StoryApp from './StoryApp';

const specimen = new URLSearchParams(location.search).has('specimen');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {specimen ? <Specimen /> : <StoryApp />}
  </StrictMode>,
);
