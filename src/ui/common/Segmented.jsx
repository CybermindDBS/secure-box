import { useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';

/** A small switch between a few modes, with a thumb that slides to the chosen one. */
export function Segmented({ options, value, onChange, label, className = '' }) {
  const ref = useRef(null);
  const [box, setBox] = useState(null);
  useLayoutEffect(() => {
    const host = ref.current;
    const measure = () => {
      const on = host.querySelector('[aria-checked="true"]');
      setBox(on ? { left: on.offsetLeft, width: on.offsetWidth } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [value]);
  const move = (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const index = options.findIndex((o) => o.id === value);
    const next = options[(index + step + options.length) % options.length];
    onChange(next.id);
    requestAnimationFrame(() => ref.current?.querySelector('[aria-checked="true"]')?.focus());
  };
  return (
    <div ref={ref} className={`seg ${className}`.trim()} role="radiogroup" aria-label={label} onKeyDown={move}>
      <span className={`seg-thumb${box ? ' is-on' : ''}`} aria-hidden="true" style={box ? { transform: `translateX(${box.left}px)`, width: `${box.width}px` } : undefined} />
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" className="seg-option" aria-checked={value === o.id} tabIndex={value === o.id ? 0 : -1} onClick={() => onChange(o.id)}>
          {o.icon ? <Icon name={o.icon} size={16} /> : null}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}
