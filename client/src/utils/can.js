/**
 * What may this person do?
 *
 * The menu and the routes ask this instead of reading `user.role`, so the
 * sidebar and the API reason from the same facts. When they disagree you get
 * the two failure modes that make a permissions screen feel broken: a granted
 * page that never appears in the nav, and a visible link that 403s when you
 * click it.
 *
 * Capabilities come from /api/auth/me. The server is still the authority --
 * this only decides what to draw.
 */

/** Does this user hold the capability? */
export function can(user, capability) {
  return Boolean(user?.capabilities?.includes(capability));
}

/** Any one of them — for a container that shows when any child is held. */
export function canAny(user, ...capabilities) {
  return capabilities.some((c) => can(user, c));
}

/**
 * Owner-only things that never became capabilities: billing, company settings,
 * integration credentials. See docs/PERMISSIONS.md.
 */
export function isOwner(user) {
  return user?.role === 'owner';
}
