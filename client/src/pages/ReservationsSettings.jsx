import React from 'react';
import { useOutletContext } from 'react-router-dom';

/**
 * Reservations → Settings.
 *
 * Two kinds of setting. The booking mode is per venue, and deliberately shown
 * for every venue at once: that dial is how the new system comes up beside
 * ResOS one notch at a time, and seeing both rows together is the point.
 *
 * The Square references are company-wide. They are pinned by id rather than by
 * name because the catalogue has duplicate category names, and the existing
 * wine push resolves its category and tax by name and takes the first match.
 */

const MODES = [
  {
    key: 'resos', label: 'ResOS',
    blurb: 'ResOS decides availability and writes the booking. Ours only reads, so it can be compared against a live day with nothing at stake.',
  },
  {
    key: 'mirror', label: 'Mirror',
    blurb: 'Ours takes the booking and pushes it into ResOS. ResOS still holds the only availability answer, and staff keep the one floor view they already use.',
  },
  {
    key: 'own', label: 'Ours',
    blurb: 'Ours decides and writes. Nothing reaches ResOS. Only once the floor view, guest history and the Google feed are in place.',
  },
];

export default function ReservationsSettings() {
  const { venues } = useOutletContext() || {};
  const list = venues || [];

  return (
    <>
      <p className="rs-stub">
        <strong>Not wired up — and structurally unable to be.</strong>
        ResOS decides every booking at both venues, and nothing on this screen can
        change that. There is no save endpoint, no <code>booking_mode</code> column in
        the database, and this file imports nothing that can write anywhere. The dial
        is a picture of the plan, not a switch.
      </p>

      <div className="rs-panel">
        <div className="rs-panel-head">
          <div>
            <h2>Booking mode</h2>
            <p className="rs-panel-sub">
              Per venue, and overridable per offer. Exactly one system decides whether a slot
              is free at any moment, which is what makes running both at once safe.
            </p>
          </div>
        </div>

        <div className="rs-table-wrap">
          <table className="rs-table">
            <thead>
              <tr><th>Venue</th><th>Mode</th><th>Reserve with Google</th><th /></tr>
            </thead>
            <tbody>
              {list.length === 0 && (
                <tr><td colSpan={4}><span className="rs-panel-sub">Loading venues…</span></td></tr>
              )}
              {list.map((v) => (
                <tr key={v.id}>
                  <td><strong>{v.name}</strong></td>
                  <td>
                    {/* A segmented control rather than a dropdown: which system is
                        deciding is the single most consequential fact on this screen,
                        and it should be readable without opening anything. */}
                    <div className="rs-seg" role="group" aria-label={`${v.name} booking mode`}>
                      {MODES.map((m) => (
                        <button key={m.key} type="button" disabled
                                className={m.key === 'resos' ? 'on' : ''}>
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td><span className="rs-pill resos">Pointed at ResOS</span></td>
                  <td><span className="rs-live"><i />Live</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rs-kv" style={{ marginTop: '0.9rem' }}>
          {MODES.map((m) => (
            <div key={m.key}>
              <span className="k"><span className={`rs-pill ${m.key}`}>{m.label}</span></span>
              <span className="v">{m.blurb}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="rs-panel">
        <div className="rs-panel-head">
          <div>
            <h2>Square</h2>
            <p className="rs-panel-sub">
              What an event&apos;s price creates in the catalogue. Pinned by id: the
              catalogue has more than one category called Tickets, Pizza, Food and Drinks,
              and a name lookup takes whichever it finds first.
            </p>
          </div>
        </div>
        <div className="rs-kv">
          <div>
            <span className="k">Ticket category</span>
            <span className="v">
              <select defaultValue="event" disabled>
                <option value="event">Event</option>
              </select>{' '}
              <code>EYUFCNOZYFR4UBSV2ZN5Z3TC</code>
              <div className="rs-panel-sub">
                Set as the item&apos;s reporting category, not just its category. Net Sales
                reaches the category through the reporting one, and Event is already excluded
                there — leave it unset and ticket revenue lands in the labor&nbsp;% denominator.
              </div>
            </span>
          </div>
          <div>
            <span className="k">Tax</span>
            <span className="v">
              <select defaultValue="idaho" disabled>
                <option value="idaho">Idaho Sales Tax — 6%</option>
              </select>{' '}
              <code>MIVKWVJX6AKP5RFONMNRQ2EZ</code>
              <div className="rs-panel-sub">
                The only tax in the catalogue today. The wine push takes &ldquo;the first
                enabled tax&rdquo;, so it is right by luck; both should read this setting.
              </div>
            </span>
          </div>
          <div>
            <span className="k">Item identity</span>
            <span className="v">
              SKU built from the event id, so renaming an event updates its item instead of
              adding another to a catalogue that already holds 439 deleted objects.
            </span>
          </div>
          <div>
            <span className="k">On cancel</span>
            <span className="v">Archive the item, never delete it — sales history survives and it is reversible.</span>
          </div>
        </div>
      </div>

      <div className="rs-panel">
        <div className="rs-panel-head">
          <div>
            <h2>Limits</h2>
            <p className="rs-panel-sub">
              The defaults for online booking. Any period on Hours &amp; Limits can
              override them, which is the cascade ResOS uses and the reason these are
              defaults rather than rules.
            </p>
          </div>
        </div>

        <h3 className="rs-sub-h">People</h3>
        <div className="rs-controls">
          <label>Max people on an online booking
            <input type="number" defaultValue={8} disabled /></label>
          <label>Min people on an online booking
            <input type="number" defaultValue={1} disabled /></label>
        </div>
        <div className="rs-kv" style={{ marginTop: '0.6rem' }}>
          <div>
            <span className="k">Above max notice</span>
            <span className="v">
              For groups over 8 people, please call us at 208-504-2127.
              <div className="rs-panel-sub">
                Shown when a guest asks for more than the maximum. Without one, the
                booking flow simply hides the option and the guest is told nothing.
              </div>
            </span>
          </div>
        </div>

        <h3 className="rs-sub-h">New online bookings</h3>
        <div className="rs-controls">
          <label>Minimum time in advance
            <input type="text" defaultValue="2:00" disabled /></label>
          <label>Max time in advance
            <input type="text" defaultValue="6 months" disabled /></label>
        </div>
        <p className="rs-panel-sub" style={{ marginTop: '0.5rem' }}>
          These are the values the live ResOS account runs on today, so a switch of
          booking mode does not quietly change what guests can do.
        </p>
      </div>
    </>
  );
}
