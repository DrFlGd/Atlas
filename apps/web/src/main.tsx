import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installAndroidBars } from './androidBars';
import { App } from './App';
import { installController } from './controller';
import { desktop, openLinksOutside } from './desktop';
import './styles/theme.css';
import './styles/app.css';
import './styles/pad.css';

// In the desktop app, links to other sites open in the system browser.
if (desktop) openLinksOutside(desktop);
// In the Android app, the page keeps clear of the system bars.
installAndroidBars();
// The arrow keys, Enter and a gamepad move around the app (see `controller.ts`).
installController();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
