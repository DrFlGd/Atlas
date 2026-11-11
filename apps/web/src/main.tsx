import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installAndroidBars } from './androidBars';
import { App } from './App';
import { desktop, openLinksOutside } from './desktop';
import './styles/theme.css';
import './styles/app.css';

// In the desktop app, links to other sites open in the system browser.
if (desktop) openLinksOutside(desktop);
// In the Android app, the page keeps clear of the system bars.
installAndroidBars();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
