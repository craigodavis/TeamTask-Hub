import React, { useEffect, useRef } from 'react';

/**
 * The date control every dated view shares.
 *
 * ResOS puts the same thing at the top of Calendar, Schedule, List and Floor:
 * a chevron each side of the date with a picker between them. Sharing one
 * component is what makes "behave the same way" true rather than four
 * near-identical implementations that drift.
 *
 * The < and > keys work as well as the chevrons, which is what Craig asked
 * for. They are ignored while a field has focus, so typing a date or a search
 * term never jumps the day underneath you.
 */

const DAY = 86400000;

export const iso = (d) => {
  // Local, not toISOString: west of Greenwich that returns the previous day.
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
};

export const parseISO = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/** Shift an ISO date by whole days or whole months. */
export function shift(value, by, step) {
  const d = parseISO(value);
  if (step === 'month') {
    // Clamp: a month step off the 31st must not skid into the next month.
    const day = d.getDate();
    const probe = new Date(d.getFullYear(), d.getMonth() + by, 1);
    const last = new Date(probe.getFullYear(), probe.getMonth() + 1, 0).getDate();
    probe.setDate(Math.min(day, last));
    return iso(probe);
  }
  return iso(new Date(d.getTime() + by * DAY));
}

export default function DateNav({ value, onChange, step = 'day', children }) {
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  const valueRef = useRef(value);
  useEffect(() => { valueRef.current = value; }, [value]);

  const stepRef = useRef(step);
  useEffect(() => { stepRef.current = step; }, [step]);

  useEffect(() => {
    const onKey = (e) => {
      // Never steal the key from something the user is typing into.
      const el = e.target;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '<' || e.key === ',') {
        onChangeRef.current(shift(valueRef.current, -1, stepRef.current));
      } else if (e.key === '>' || e.key === '.') {
        onChangeRef.current(shift(valueRef.current, 1, stepRef.current));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const label = step === 'month'
    ? parseISO(value).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    : parseISO(value).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  return (
    <div className="rs-datenav">
      <button type="button" className="rs-chev" aria-label={`Previous ${step}`}
              onClick={() => onChange(shift(value, -1, step))}>‹</button>
      <span className="rs-datenav-label">{label}</span>
      <input type="date" value={value} aria-label="Pick a date"
             onChange={(e) => e.target.value && onChange(e.target.value)} />
      <button type="button" className="rs-chev" aria-label={`Next ${step}`}
              onClick={() => onChange(shift(value, 1, step))}>›</button>
      <button type="button" className="rs-btn" onClick={() => onChange(iso(new Date()))}>
        Today
      </button>
      {children}
    </div>
  );
}
