import { useEffect, useRef } from 'react';
import '../styles/vintly.css';
import './Drawer.css';

/**
 * Slide-over edit drawer — Vintly's "right window open" pattern, and a bottom sheet
 * on phones.
 *
 * Beyond Vintly's version this handles the things a modal has to get right or it
 * traps people: Escape closes it, the page behind stops scrolling while it is open
 * (otherwise a phone scrolls the list under the sheet as you drag), and focus moves
 * into the panel so a keyboard user is not still tabbing the page behind.
 */
export default function Drawer({ open, title, onClose, children, footer }) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="vin-drawer-overlay" onClick={onClose}>
      {/* stopPropagation so a click inside never reaches the overlay's close. */}
      <div
        className="vin-drawer-panel"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="vin-drawer-header">
          <h3>{title}</h3>
          <button type="button" className="vin-drawer-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="vin-drawer-body">{children}</div>
        {footer && <div className="vin-drawer-footer">{footer}</div>}
      </div>
    </div>
  );
}
