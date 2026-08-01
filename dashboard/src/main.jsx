import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource/source-sans-3/400.css';
import '@fontsource/source-sans-3/500.css';
import '@fontsource/source-sans-3/600.css';
import '@fontsource/source-sans-3/700.css';
import '@fontsource/lexend/400.css';
import '@fontsource/lexend/500.css';
import '@fontsource/lexend/600.css';
import '@fontsource/lexend/700.css';
import { AuthProvider } from './auth.jsx';
import { setToken } from './api';
import App from './App.jsx';
import './index.css';

// Apply the saved theme BEFORE first paint to avoid a flash of the wrong theme.
// Optional ?theme=dark|light deep-link overrides and persists the choice.
(() => {
  const q = new URLSearchParams(window.location.search).get('theme');
  if (q === 'dark' || q === 'light') localStorage.setItem('sentroid_theme', q);
  const saved = localStorage.getItem('sentroid_theme');
  const dark = saved ? saved === 'dark'
    : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', dark);
})();

// Deep-link auth: allow ?token=<jwt> to pre-authenticate a session (used for
// local demos / deep links). The token is stored and immediately stripped from
// the URL so it does not leak via history or referrer.
const _params = new URLSearchParams(window.location.search);
const _urlToken = _params.get('token');
if (_urlToken) {
  setToken(_urlToken);
  window.history.replaceState({}, '', window.location.pathname);
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
