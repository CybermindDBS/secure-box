import { ICONS } from './icons.js';

/** A stroked 24px icon. Decorative unless `label` is given. */
export function Icon({ name, size = 18, label, className = '' }) {
  const paths = ICONS[name] || [];
  return (
    <svg
      className={`icon ${className}`.trim()}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : 'true'}
      aria-label={label}
      role={label ? 'img' : undefined}
      focusable="false"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export function Spinner({ small = false, label }) {
  return <span className={`spinner${small ? ' spinner-sm' : ''}`} role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : 'true'} />;
}

function hueOf(text) {
  let hash = 0;
  for (const ch of text.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return hash % 360;
}

/** The round badge of a password item: its first letter, or a note icon. */
export function Avatar({ item, size = '' }) {
  return (
    <span className={`avatar${size ? ` avatar-${size}` : ''}`} style={{ '--hue': String(hueOf(item.title || '?')) }} aria-hidden="true">
      {item.type === 'note' ? <Icon name="note" size={size === 'lg' ? 22 : 16} /> : ([...item.title.trim()][0] || '?').toUpperCase()}
    </span>
  );
}
