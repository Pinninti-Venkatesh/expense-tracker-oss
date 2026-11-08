import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted: the server's Content-Security-Policy allows fonts from this origin only.
import '@fontsource-variable/rubik';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
