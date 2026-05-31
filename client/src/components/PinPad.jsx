import React, { useState, useEffect } from 'react';
import './PinPad.css';

/**
 * 4-digit PIN pad.
 * @param {object} props
 * @param {(pin: string) => void} props.onComplete  Called when 4th digit is entered
 * @param {() => void}            props.onClear     Called when user clears all digits
 * @param {string}                [props.label]
 * @param {string}                [props.error]
 */
export function PinPad({ onComplete, onClear, label, error }) {
  const [digits, setDigits] = useState('');

  // Reset internal state when error changes (parent wants us to start over)
  useEffect(() => {
    if (error) setDigits('');
  }, [error]);

  const press = (char) => {
    if (char === 'backspace') {
      const next = digits.slice(0, -1);
      setDigits(next);
      if (next.length === 0 && onClear) onClear();
      return;
    }
    if (digits.length >= 4) return;
    const next = digits + char;
    setDigits(next);
    if (next.length === 4) {
      // Small timeout so last dot renders before callback
      setTimeout(() => {
        onComplete(next);
        setDigits('');
      }, 120);
    }
  };

  const dots = Array.from({ length: 4 }, (_, i) => (
    <span key={i} className={`pin-dot ${i < digits.length ? 'pin-dot--filled' : ''}`} />
  ));

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'backspace'];

  return (
    <div className="pin-pad">
      {label && <p className="pin-pad__label">{label}</p>}
      <div className="pin-pad__dots">{dots}</div>
      {error && <p className="pin-pad__error">{error}</p>}
      <div className="pin-pad__grid">
        {keys.map((k, i) => {
          if (k === '') {
            return <span key={i} className="pin-pad__key pin-pad__key--empty" />;
          }
          if (k === 'backspace') {
            return (
              <button
                key={i}
                type="button"
                className="pin-pad__key pin-pad__key--backspace"
                onClick={() => press('backspace')}
                aria-label="Backspace"
              >
                ⌫
              </button>
            );
          }
          return (
            <button
              key={i}
              type="button"
              className="pin-pad__key"
              onClick={() => press(k)}
            >
              {k}
            </button>
          );
        })}
      </div>
    </div>
  );
}
