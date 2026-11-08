import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import PwaShell from './components/PwaShell';
import { startSessionGuard } from './db/sessionGuard';
import './index.css';

startSessionGuard();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <PwaShell />
  </StrictMode>,
);
