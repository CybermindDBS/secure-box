import { useEffect, useState } from 'react';
import { dismissToast, toasts } from '../../session/bridge.js';
import { useStore } from '../hooks.js';
import { Icon } from './Icon.jsx';

function Toast({ toast }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div className={`toast toast-${toast.tone}${shown ? ' is-in' : ''}`} role={toast.tone === 'error' ? 'alert' : 'status'} onClick={() => dismissToast(toast.id)}>
      <Icon name={toast.tone === 'error' ? 'alert' : 'check'} size={16} />
      <span>{toast.message}</span>
    </div>
  );
}

export function Toasts() {
  const list = useStore(toasts);
  return (
    <div className="toasts" aria-live="polite">
      {list.map((toast) => (
        <Toast key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
