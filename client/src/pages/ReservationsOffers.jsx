import React, { useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { offersFor } from './reservationsExample';

/**
 * Reservations → Offers.
 *
 * One object for everything bookable. Regular service is an offer with a
 * weekly rule and no price; an experience is an offer with a date and a price;
 * a private buyout is an offer nobody can see. They differ by which fields are
 * filled in, not by being different kinds of record — which is what lets every
 * booking link behave the same way.
 *
 * The link is generated from the offer. Nothing is pasted in.
 */

const MODE_LABEL = {
  resos: 'ResOS decides',
  mirror: 'Ours, mirrored to ResOS',
  own: 'Ours',
};

export default function ReservationsOffers() {
  const { venue, venues } = useOutletContext() || {};

  const shown = useMemo(() => {
    const list = venue ? [venue] : (venues || []);
    return list.flatMap((v) => offersFor(v).map((o) => ({ ...o, venueName: v.name })));
  }, [venue, venues]);

  return (
    <>
      <p className="rs-stub">
        <strong>Not wired up.</strong>
        Example offers. Real ones reference a rule in the venue&apos;s hours rather than
        copying it, so an hours change never has to be made twice.
      </p>

      <div className="rs-panel">
        <div className="rs-panel-head">
          <div>
            <h2>{venue ? `${venue.name} offers` : 'Offers — both venues'}</h2>
            <p className="rs-panel-sub">
              {shown.length} bookable offers. Clear the venue above to see both at once.
            </p>
          </div>
          <button type="button" className="rs-btn primary" disabled>New offer</button>
        </div>

        <div className="rs-table-wrap">
          <table className="rs-table">
            <thead>
              <tr>
                {!venue && <th>Venue</th>}
                <th>Offer</th><th>Kind</th><th>When</th><th>Layout</th>
                <th>Party</th><th>Price</th><th>Visible</th><th>Link</th><th>Booking</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => (
                <tr key={`${o.venueName}-${o.id}`}>
                  {!venue && <td>{o.venueName}</td>}
                  <td><strong>{o.name}</strong></td>
                  <td>{o.kind}</td>
                  <td>{o.when}</td>
                  <td>
                    {o.layout?.name || '—'}
                    {o.layout?.standingCapacity > 0 && (
                      <> <span className="rs-pill standing">{o.layout.standingCapacity} standing</span></>
                    )}
                  </td>
                  <td className="rs-num">{o.party}</td>
                  <td>{o.price || '—'}</td>
                  <td>{o.visibility}</td>
                  <td>{o.slug ? <code>/{o.slug}</code> : '—'}</td>
                  <td><span className={`rs-pill ${o.mode}`}>{MODE_LABEL[o.mode]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rs-panel">
        <div className="rs-panel-head">
          <div>
            <h2>How a link gets shorter</h2>
            <p className="rs-panel-sub">
              One page, four depths. The link settles whatever it already knows and the page
              asks only for the rest, so an experience never makes a guest re-enter the date
              that was in the link they clicked.
            </p>
          </div>
        </div>
        <div className="rs-kv">
          <div><span className="k"><code>/book/estate</code></span>
            <span className="v">Party, date, time, details — a cold arrival.</span></div>
          <div><span className="k"><code>/book/estate?d=2027-02-13</code></span>
            <span className="v">Date settled. Party, time, details.</span></div>
          <div><span className="k"><code>/book/estate/70s-80s</code></span>
            <span className="v">Date and window settled. Tickets, details.</span></div>
          <div><span className="k"><code>/book/estate/70s-80s?t=19:30&amp;party=2</code></span>
            <span className="v">Name, email, phone. Nothing else.</span></div>
        </div>
      </div>
    </>
  );
}
