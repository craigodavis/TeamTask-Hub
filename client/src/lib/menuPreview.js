/**
 * What menu would a set of grants produce, and what changes if you edit them?
 *
 * This exists so the permissions screen can answer "what would Elaine lose?"
 * before anything is saved, rather than by writing to her live account and
 * going to look.
 *
 * It does NOT re-implement the rules. It calls `visibleApps` -- the same
 * function the shell calls to draw the real sidebar -- so the preview cannot
 * drift from what the person actually gets. Nothing here grants anything;
 * every route keeps its own server-side `requireCapability`.
 *
 * It lives in its own module rather than inside the component so it can be
 * exercised against real production grants without a browser. See
 * `server/scripts/audit-menu-preview.mjs`.
 */

import { visibleApps } from './apps';
import { can, isOwner } from '../utils/can';

/**
 * The menu these grants produce, as Map<"appId|path", {app, label}>.
 *
 * Keyed by app AND path because one path can appear in two apps -- Private
 * Events sits in Floor today and may move to Marketing -- and losing it from
 * one is not the same event as losing it from the other.
 */
export function menuOf(role, capabilities) {
  const out = new Map();
  for (const { app, nav } of visibleApps({ role, capabilities }, can, isOwner)) {
    for (const item of nav) {
      out.set(`${app.id}|${item.to}`, { app: app.name, label: item.label });
    }
  }
  return out;
}

/**
 * Held vs. drafted.
 *
 * `role` is part of this and not decoration: six Floor rows are gated on being
 * an owner, so changing the role in the dropdown moves them even though no
 * checkbox did. A preview that only looked at capabilities would quietly lie
 * about exactly the change most likely to surprise someone.
 */
export function diffMenus(held, next) {
  const lost = [...held].filter(([k]) => !next.has(k)).map(([, v]) => v);
  const gained = [...next].filter(([k]) => !held.has(k)).map(([, v]) => v);

  const appsIn = (m) => new Set([...m.values()].map((v) => v.app));
  const heldApps = appsIn(held);
  const nextApps = appsIn(next);

  return {
    lost,
    gained,
    appsLost: [...heldApps].filter((a) => !nextApps.has(a)),
    appsGained: [...nextApps].filter((a) => !heldApps.has(a)),
  };
}

/** Everything the preview panel needs for one pending edit. */
export function previewFor(saved, draftRole, draftCapabilities) {
  const caps = [...draftCapabilities];
  return {
    apps: visibleApps({ role: draftRole, capabilities: caps }, can, isOwner),
    ...diffMenus(menuOf(saved.role, saved.capabilities), menuOf(draftRole, caps)),
  };
}
