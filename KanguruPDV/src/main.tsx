import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { UpdateGate } from './app/UpdateNotice';
import { OfflineBanner } from './app/OfflineBanner';
import './styles/global.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OfflineBanner />
    <App />
    <UpdateGate />
  </StrictMode>,
);