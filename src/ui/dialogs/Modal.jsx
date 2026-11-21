import { useEffect, useRef } from 'react';

/**
 * A modal <dialog>: opens on mount, focuses the field marked data-autofocus (or the first
 * button), and Escape asks `onDismiss` instead of closing by itself.
 */
export function Modal({ onDismiss, className = 'dialog dialog-sm', labelledBy, children, busy = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog.open) dialog.showModal();
    const first = dialog.querySelector('[data-autofocus]') || dialog.querySelector('.dialog-foot .btn-primary, .dialog-foot .btn-danger') || dialog.querySelector('button');
    first?.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      aria-labelledby={labelledBy}
      aria-busy={busy || undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onDismiss();
      }}
    >
      {children}
    </dialog>
  );
}
