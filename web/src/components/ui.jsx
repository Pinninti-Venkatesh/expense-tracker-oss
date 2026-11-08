import { useEffect, useRef, useState } from 'react';
import { initials, pastel } from '../lib/format.js';

/* ---------- icons ---------- */

const PATHS = {
  home: <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1v-9.5Z" />,
  list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" strokeWidth="2.2" />,
  loan: <path d="M3 10 12 4l9 6M5 10v9M19 10v9M10 10v9M14 10v9M3 21h18" />,
  people: <><circle cx="9" cy="8" r="3.2" /><path d="M3 20c.9-3.3 3.2-5 6-5s5.1 1.7 6 5M16 5.2A3.2 3.2 0 0 1 17 11M18 14.6c1.6.7 2.6 2.3 3 5.4" /></>,
  plus: <path d="M12 5v14M5 12h14" strokeWidth="2.4" />,
  eye: <><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" /><circle cx="12" cy="12" r="2.8" /></>,
  eyeOff: <><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" /><circle cx="12" cy="12" r="2.8" /><path d="M4 20 20 4" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  chev: <path d="m9 5 7 7-7 7" />,
  back: <path d="m15 5-7 7 7 7" strokeWidth="2.4" />,
  arrow: <path d="M20 12H5m6-6-6 6 6 6" strokeWidth="2.2" />,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="3" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>,
  doc: <path d="M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5" />,
  swap: <path d="M5 8h13l-3-3M19 16H6l3 3" />,
  drive: <path d="M8.5 4h7l5.5 9.5-3.5 6h-11L3 13.5zM8.5 4l5.5 9.5H21M6.5 19.5 12 10" />,
  tag: <><path d="M3 12V4h8l10 10-8 8z" /><circle cx="7.5" cy="8.5" r="1.2" fill="currentColor" /></>,
  mail: <><rect x="3" y="5.5" width="18" height="13" rx="2.5" /><path d="m4 7 8 6 8-6" /></>,
  star: <path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.8z" />,
  refresh: <path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4" />,
  share: <path d="M12 15V4m0 0L8 8m4-4 4 4M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6" />,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" strokeWidth="2.4" />,
  download: <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" />,
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" />,
  card: <><rect x="3" y="5.5" width="18" height="13" rx="2.5" /><path d="M3 10h18" /></>,
  logout: <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10" />,
  backspace: <><path d="M9 5h11v14H9l-6-7z" /><path d="m12 9 5 6m0-6-5 6" /></>,
  pot: <path d="M4 9h16l-1.5 10h-13zM8 9V6a4 4 0 0 1 8 0v3" />,
  shield: <path d="M12 3l7 3v5.5c0 4.3-2.9 7.8-7 9.5-4.1-1.7-7-5.2-7-9.5V6l7-3Z" />,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
};

export function Icon({ name, size = 20, className, ...rest }) {
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className={className}
      fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}

/** Android draws back as an arrow; iOS as a chevron. Everything else is the same brand. */
export const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

export function BackButton({ onClick, label = 'Back' }) {
  return (
    <button type="button" className="icon-btn ghost" onClick={onClick} aria-label={label}>
      <Icon name={isAndroid ? 'arrow' : 'back'} />
    </button>
  );
}

/* ---------- small pieces ---------- */

export function Avatar({ name, round = false, size }) {
  return (
    <span
      className={`av${round ? ' round' : ''}`}
      style={{ background: pastel(name), ...(size ? { width: size, height: size, fontSize: size * 0.34 } : {}) }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

export function Seg({ options, value, onChange, label, className = '' }) {
  return (
    <div className={`seg ${className}`} role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id} type="button" role="tab" aria-selected={value === o.id}
          className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)}
        >
          {o.label}
          {o.sub != null && <small className="num">{o.sub}</small>}
        </button>
      ))}
    </div>
  );
}

export function Chip({ on = false, children, onClick, disabled, className = '', title }) {
  return (
    <button
      type="button" className={`chip${on ? ' on' : ''} ${className}`} aria-pressed={on}
      onClick={onClick} disabled={disabled} title={title}
    >
      {children}
    </button>
  );
}

export function Toggle({ checked, onChange, label, disabled, id }) {
  return (
    <button
      type="button" id={id} role="switch" aria-checked={checked} aria-label={label}
      className={`switch${checked ? ' on' : ''}`} onClick={() => onChange(!checked)} disabled={disabled}
    />
  );
}

export function ScreenHead({ title, onBack, right, sub, children }) {
  return (
    <header className="screen-head">
      {onBack && <BackButton onClick={onBack} />}
      {children}
      <div className="screen-title">
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {right}
    </header>
  );
}

export function Field({ label, htmlFor, hint, children, className = '' }) {
  return (
    <div className={`field ${className}`}>
      <label className="field-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

export function Empty({ title, children, action }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/**
 * A destructive button that asks twice: the first tap turns it into
 * "Tap again to …", which reverts after a few seconds.
 */
export function ConfirmButton({ label, confirmLabel, onConfirm, className = 'btn soft danger', disabled }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const click = async () => {
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    clearTimeout(timer.current);
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  return (
    <button type="button" className={`${className}${armed ? ' armed' : ''}`} onClick={click} disabled={disabled || busy}>
      {busy ? 'Working…' : armed ? confirmLabel : label}
    </button>
  );
}

/* ---------- sheet ---------- */

/**
 * A bottom sheet on phones and a centred dialog on wide screens. Escape and a
 * tap outside close it; Android back is handled by the navigation stack.
 */
export function Sheet({ title, onClose, children, footer, className = '' }) {
  const panel = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    // Focus the panel, not the first field, so the keyboard doesn't jump up
    // unasked on a phone.
    panel.current?.focus({ preventScroll: true });
    document.body.classList.add('sheet-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('sheet-open');
      previous?.focus?.({ preventScroll: true });
    };
  }, []);

  return (
    <div className="sheet-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) closeRef.current(); }}>
      <div className={`sheet ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panel}>
        <span className="grab" aria-hidden="true" />
        {title && (
          <div className="sheet-head">
            <h2>{title}</h2>
            <button type="button" className="icon-btn ghost" onClick={() => closeRef.current()} aria-label="Close">
              <Icon name="x" />
            </button>
          </div>
        )}
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}
