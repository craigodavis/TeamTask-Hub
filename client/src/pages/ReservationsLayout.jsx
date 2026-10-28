import React, { useState, useEffect, useMemo } from 'react';
import { NavLink, Outlet, useLocation, useOutletContext } from 'react-router-dom';
import { getHours } from '../api';
import './ReservationsLayout.css';

/**
 * Tasting Room → Reservations.
 *
 * The section shell for the ResOS replacement. Everything underneath it is
 * scoped by the venue picker in this header, which is the whole point: tables,
 * areas and layouts differ per venue, but nobody should have to sign in as
 * Creek to manage Creek. Venue is a scope control, never an identity.
 *
 * Venues come from getHours(), which already returns both of them with their
 * regular and special hours in one call — the same hours an offer references
 * rather than copies.
 */

const VENUE_KEY = 'teamhub_reservations_venue';

// Screens that draw or edit one physical room. A floor plan belongs to a room,
// so "Both venues" has no meaning on these and the picker says so.
const SINGLE_VENUE = ['/tasting-room/reservations/floor',
                      '/tasting-room/reservations/layouts',
                      '/tasting-room/reservations/tables'];

const TABS = [
  { to: '/tasting-room/reservations',         label: 'Bookings', end: true },
  { to: '/tasting-room/reservations/floor',   label: 'Floor' },
  { to: '/tasting-room/reservations/layouts', label: 'Layouts' },
  { to: '/tasting-room/reservations/tables',  label: 'Areas & Tables' },
  { to: '/tasting-room/reservations/offers',  label: 'Offers' },
  { to: '/tasting-room/reservations/hours',   label: 'Hours & Limits' },
  { to: '/tasting-room/reservations/settings', label: 'Settings' },
];

export function ReservationsLayout() {
  const outletContext = useOutletContext();
  const location = useLocation();

  const [venues, setVenues] = useState([]);
  const [venueId, setVenueId] = useState(() => {
    try { return localStorage.getItem(VENUE_KEY) || ''; } catch { return ''; }
  });
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    getHours()
      .then((d) => { if (alive) setVenues(d.locations || []); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);

  const needsOne = SINGLE_VENUE.includes(location.pathname);

  // On a single-room screen an empty scope ("Both") falls back to the first
  // venue rather than rendering a floor that belongs to nobody.
  const effectiveId = useMemo(() => {
    if (!needsOne) return venueId;
    if (venueId) return venueId;
    return venues[0]?.id || '';
  }, [needsOne, venueId, venues]);

  const forced = needsOne && !venueId && Boolean(effectiveId);
  const venue = venues.find((v) => v.id === effectiveId) || null;

  const pick = (id) => {
    setVenueId(id);
    try { id ? localStorage.setItem(VENUE_KEY, id) : localStorage.removeItem(VENUE_KEY); } catch { /* ignore */ }
  };

  return (
    <div className="rs-layout">
      <header className="rs-head">
        <h1 className="rs-title">Reservations</h1>
        <label className="rs-venue">
          <span className="rs-venue-label">Venue</span>
          <select value={effectiveId} onChange={(e) => pick(e.target.value)}>
            <option value="" disabled={needsOne}>
              {needsOne ? 'Both venues — not for one room' : 'Both venues'}
            </option>
            {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
      </header>

      {error && <p className="rs-error">Could not load venues: {error}</p>}
      {forced && (
        <p className="rs-scope-note">
          Showing <strong>{venue?.name}</strong>. A floor plan belongs to one room, so this
          screen needs a single venue — switch above to manage the other one.
        </p>
      )}

      <nav className="rs-tabs" aria-label="Reservations sections">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end}
            className={({ isActive }) => (isActive ? 'active' : '')}>
            {t.label}
          </NavLink>
        ))}
      </nav>

      <Outlet context={{ ...outletContext, venues, venue, venueId: effectiveId }} />
    </div>
  );
}

export default ReservationsLayout;
