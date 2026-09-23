import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyStoredPreferences } from './lib/preferences';
import './styles/app.css';

// Before the first render, so the interface never flashes light and then
// switches to dark, or renders at the wrong text size for a moment.
applyStoredPreferences();

const container = document.getElementById('root');
if (!container) throw new Error('The #root element is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
