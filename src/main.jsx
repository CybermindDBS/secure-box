import { createRoot } from 'react-dom/client';
import { isAuthPopupReturn, relayAuthPopupReturn } from './core/google.js';

// Clickjacking defence. Firebase also sends frame-ancestors and X-Frame-Options; the page refuses frames itself too.
if (window.top !== window.self) {
  document.documentElement.replaceChildren();
  throw new Error('Secure Box refuses to run inside a frame.');
}
// A sign-in pop-up lands here: hand the tokens to the Secure Box tab and close.
if (isAuthPopupReturn()) {
  relayAuthPopupReturn();
  throw new Error('Sign-in window: done.');
}

// The session runs on its own, outside React; the components only show it.
const [{ boot }, { default: App }] = await Promise.all([import('./session/vaults.js'), import('./ui/App.jsx')]);
createRoot(document.getElementById('root')).render(<App />);
boot().catch((err) => {
  console.error(err);
  import('./session/vaults.js').then(({ showError }) =>
    showError({ title: 'Secure Box could not start', message: err.message || String(err), action: 'reload', actionLabel: 'Reload' }),
  );
});
