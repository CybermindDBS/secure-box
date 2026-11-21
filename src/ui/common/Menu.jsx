import { useEffect, useId, useRef } from 'react';

/**
 * A pop-up menu (the browser's popover) that opens under its button: by the button's right edge,
 * or its left edge with `align="left"`. Choosing an item closes it.
 */
export function Menu({ button, children, className = '', align = 'right', label }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const menuRef = useRef(null);
  const buttonRef = useRef(null);
  useEffect(() => {
    const menu = menuRef.current;
    const place = (event) => {
      if (event.newState !== 'open') return;
      const rect = buttonRef.current.getBoundingClientRect();
      menu.style.top = `${Math.round(rect.bottom + 8)}px`;
      if (align === 'left') {
        menu.style.left = `${Math.round(Math.max(8, rect.left))}px`;
        menu.style.right = 'auto';
      } else {
        menu.style.right = `${Math.round(Math.max(8, window.innerWidth - rect.right))}px`;
        menu.style.left = 'auto';
      }
    };
    menu.addEventListener('beforetoggle', place);
    return () => menu.removeEventListener('beforetoggle', place);
  }, [align]);
  const close = () => {
    if (menuRef.current?.matches(':popover-open')) menuRef.current.hidePopover();
  };
  return (
    <>
      {button({ ref: buttonRef, popoverTarget: `menu-${id}`, 'aria-haspopup': 'menu' })}
      <div
        ref={menuRef}
        id={`menu-${id}`}
        className={`menu ${className}`.trim()}
        popover="auto"
        role="menu"
        aria-label={label}
        onClick={(event) => {
          if (event.target.closest('[role="menuitem"]:not(:disabled)')) close();
        }}
      >
        {children}
      </div>
    </>
  );
}

export function MenuItem({ icon: IconEl = null, children, onSelect, danger = false, disabled = false, href }) {
  if (href) {
    return (
      <a className="menu-item" role="menuitem" href={href} target="_blank" rel="noopener noreferrer">
        {IconEl}
        {children}
      </a>
    );
  }
  return (
    <button type="button" className={`menu-item${danger ? ' menu-danger' : ''}`} role="menuitem" disabled={disabled} onClick={onSelect}>
      {IconEl}
      {children}
    </button>
  );
}

export const MenuSeparator = () => <div className="menu-sep" role="separator" />;
