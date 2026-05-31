import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import { setPin } from '../api';
import { PinPad } from './PinPad';
import './SetPinModal.css';

/**
 * Modal to set or change the user's 4-digit PIN.
 * @param {object}   props
 * @param {() => void} props.onClose    Called when the modal is dismissed
 * @param {() => void} props.onSuccess  Called after PIN is saved
 * @param {boolean}  [props.required]  If true, no dismiss/skip button is shown
 */
export function SetPinModal({ onClose, onSuccess, required = false }) {
  const [step, setStep] = useState(1); // 1 = enter, 2 = confirm
  const [firstPin, setFirstPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  const handleFirst = (pin) => {
    setFirstPin(pin);
    setPinError('');
    setStep(2);
  };

  const handleConfirm = async (pin) => {
    if (pin !== firstPin) {
      setPinError("PINs don't match — try again");
      setFirstPin('');
      setStep(1);
      return;
    }
    setSaving(true);
    try {
      await setPin(pin);
      setDone(true);
      setTimeout(() => {
        onSuccess();
      }, 800);
    } catch (err) {
      setPinError(err.message || 'Failed to save PIN');
      setStep(1);
      setFirstPin('');
    } finally {
      setSaving(false);
    }
  };

  const content = (
    <div className="set-pin-modal-overlay" onClick={required ? undefined : onClose}>
      <div
        className="set-pin-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Set PIN"
      >
        {done ? (
          <div className="set-pin-modal__success">
            <span className="set-pin-modal__check">✓</span>
            <p>PIN set!</p>
          </div>
        ) : saving ? (
          <p className="set-pin-modal__saving">Saving…</p>
        ) : (
          <>
            {step === 1 && (
              <PinPad
                label="Choose a 4-digit PIN"
                onComplete={handleFirst}
                error={pinError}
              />
            )}
            {step === 2 && (
              <PinPad
                label="Confirm your PIN"
                onComplete={handleConfirm}
                error={pinError}
              />
            )}
            {!required && (
              <button
                type="button"
                className="set-pin-modal__skip link-button"
                onClick={onClose}
              >
                Skip for now
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );

  return ReactDOM.createPortal(content, document.body);
}
