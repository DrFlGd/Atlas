import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// The Atlas viewer's colours and fonts, shared so both apps look alike.
import '../../web/src/styles/theme.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
