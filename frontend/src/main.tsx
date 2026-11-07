import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// self-hosted fonts: the CSP allows styles and fonts from 'self' only
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/jetbrains-mono';
import './index.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
