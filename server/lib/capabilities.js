/**
 * The permissions catalogue: what can be granted, and what each role grants.
 *
 * See docs/PERMISSIONS.md for the design. Two rules matter most here:
 *
 * 1. A role is a PRESET, not a live link. Choosing one stamps its capabilities
 *    onto the person; editing a preset later does not retroactively change
 *    anyone. `isCustomized()` is how the UI shows that someone has drifted.
 *
 * 2. Container menus are DERIVED, never granted. Kitchen, Wine, Marketing and
 *    Tasting Room are headers with no page behind them, so they carry no
 *    capability -- `visibleContainers()` works them out from the children a
 *    person holds. That is what lets a submenu be granted without its parent
 *    while staying reachable in the nav.
 *
 * This file is the single source of truth for both the server guards and the
 * matrix UI. It deliberately lives in code rather than a table: a capability
 * only means something because a route checks it, so the list must not be able
 * to drift away from the code that enforces it.
 */

/** Containers. Not grantable -- shown when any child is held. */
export const CONTAINERS = {
  kitchen:     { label: 'Kitchen' },
  wine:        { label: 'Wine' },
  marketing:   { label: 'Marketing' },
  tastingroom: { label: 'Tasting Room' },
};

/**
 * Every grantable capability, in menu order.
 * `container` names the parent header; absent means top level.
 */
export const CAPABILITIES = [
  { key: 'dashboard.view',           label: 'Dashboard',          path: '/dashboard' },
  { key: 'tasks.own',                label: 'Tasks',              path: '/' },
  { key: 'tasks.manage',             label: 'Manage Tasks',       path: '/manage?tab=tasks' },
  { key: 'announcements.manage',     label: 'Announcements',      path: '/manage?tab=announcements' },
  { key: 'policies.read',            label: 'Policies',           path: '/policies' },
  { key: 'crew.profile',             label: 'The Crew',           path: '/crew' },
  { key: 'scheduling.manage',        label: 'Scheduling',         path: '/scheduling' },
  { key: 'ai.use',                   label: 'Kindred AI',         path: '/square' },
  { key: 'kindredapp.manage',        label: 'Kindred App',        path: '/kindred-app' },
  { key: 'skynet.view',              label: 'Skynet',             path: '/skynet' },

  { key: 'marketing.events',         label: 'Events',             path: '/events',              container: 'marketing' },
  { key: 'marketing.campaigns',      label: 'Campaigns',          path: '/marketing/campaigns', container: 'marketing' },
  { key: 'marketing.media',          label: 'Media Library',      path: '/marketing/media',     container: 'marketing' },
  { key: 'marketing.hours',          label: 'Store Hours',        path: '/marketing/hours',     container: 'marketing' },
  { key: 'marketing.loyalty',        label: 'Loyalty',            path: '/marketing/loyalty',   container: 'marketing' },
  { key: 'marketing.website',        label: 'Website Settings',   path: '/marketing/settings',  container: 'marketing' },

  { key: 'kitchen.receipts.scan',    label: 'Scan Receipt',       path: '/recipes/scan',        container: 'kitchen' },
  { key: 'kitchen.receipts',         label: 'Receipts',           path: '/quickbooks',          container: 'kitchen' },
  { key: 'kitchen.receipt_sources',  label: 'Receipt Sources',    path: '/kitchen/sources',     container: 'kitchen' },
  { key: 'kitchen.catalog',          label: 'Item Catalog',       path: '/recipes/catalog',     container: 'kitchen' },
  { key: 'kitchen.ingredients',      label: 'Ingredients',        path: '/recipes/ingredients', container: 'kitchen' },
  { key: 'kitchen.inventory',        label: 'Kitchen Inventory',  path: '/kitchen/inventory',   container: 'kitchen' },
  { key: 'kitchen.recipes',          label: 'Recipes',            path: '/recipes/list',        container: 'kitchen' },
  { key: 'kitchen.shopping',         label: 'Shopping',           path: '/food',                container: 'kitchen' },

  { key: 'tastingroom.menus',        label: 'Menus',              path: '/tasting-room/menus',        container: 'tastingroom' },
  { key: 'tastingroom.reservations', label: 'Reservations',       path: '/tasting-room/reservations', container: 'tastingroom' },

  { key: 'wine.lines',               label: 'Product Lines',      path: '/product-lines',              container: 'wine' },
  { key: 'wine.products',            label: 'Products',           path: '/products',                   container: 'wine' },
  { key: 'wine.inventory',           label: 'Wine Inventory',     path: '/products/inventory',         container: 'wine' },
  { key: 'wine.reports',             label: 'Wine Reports',       path: '/products/inventory/report',  container: 'wine' },

  { key: 'betty.use',                label: 'Betty Bookkeeper',   path: '/betty' },
  { key: 'gateway.use',              label: 'Gateway',            path: '/gateway' },
  { key: 'groundcontrol.use',        label: 'Ground Control',     path: '/ground-control' },
  { key: 'reports.scheduled',        label: 'Scheduled Reports',  path: '/manage?tab=reports' },
  { key: 'reports.operational',      label: 'Operational Reports (waste, tasks, debt, AI usage)', path: '/manage?tab=reports' },
  { key: 'sms.send',                 label: 'SMS Send',           path: '/manage?tab=integrations' },
  { key: 'users.manage',             label: 'Users & Permissions', path: '/settings?tab=users' },
];

export const ALL_CAPABILITIES = CAPABILITIES.map((c) => c.key);

/** Owner-only. Never in another preset, even admin's. */
export const OWNER_ONLY = ['kitchen.receipt_sources', 'users.manage'];

/** What everyone gets, including a brand-new user. Carly's world today. */
const MEMBER = ['tasks.own', 'policies.read', 'crew.profile', 'kitchen.shopping'];

const MARKETING = [
  ...MEMBER,
  'marketing.events', 'marketing.campaigns', 'marketing.media',
  'marketing.hours', 'marketing.loyalty', 'marketing.website',
  'announcements.manage', 'kindredapp.manage', 'ai.use', 'reports.scheduled',
];

const OPERATIONAL = ALL_CAPABILITIES.filter((k) => !OWNER_ONLY.includes(k));

export const PRESETS = {
  member:    MEMBER,
  marketing: MARKETING,
  manager:   OPERATIONAL,
  admin:     OPERATIONAL,
  owner:     ALL_CAPABILITIES,
};

/**
 * The legacy roles, mapped onto grants that reproduce exactly what each one can
 * reach today. `inventory` is the interesting one and the proof the model
 * works: two people who are neither members nor managers, expressed as a member
 * plus the two inventory screens.
 *
 * `schedule` and `gc` were never granted to anybody -- they are here so the
 * backfill is total rather than because any row uses them.
 */
export const LEGACY_ROLE_GRANTS = {
  member:    MEMBER,
  manager:   PRESETS.manager,
  admin:     PRESETS.admin,
  marketing: MARKETING,
  owner:     PRESETS.owner,
  // wine.reports belongs here because the old requireInventoryAccess gated
  // /products/inventory/report too, and Wine ▸ Reports sat behind
  // canAccessInventory in the nav. Leaving it out silently took the report away
  // from Tristan and Zoë -- caught by exercising the real routes as each user,
  // which a grants-only diff could never have shown, since both sides of that
  // comparison read this same map.
  inventory: [...MEMBER, 'wine.inventory', 'wine.reports', 'kitchen.inventory'],
  schedule:  [...MEMBER, 'scheduling.manage', 'marketing.events'],
  gc:        [...MEMBER, 'groundcontrol.use'],
};

export function capabilitiesForRole(role) {
  return PRESETS[role] || LEGACY_ROLE_GRANTS[role] || MEMBER;
}

/** Has this person been edited away from their role's preset? */
export function isCustomized(role, grants) {
  const preset = new Set(capabilitiesForRole(role));
  const held = new Set(grants);
  if (preset.size !== held.size) return true;
  for (const k of preset) if (!held.has(k)) return true;
  return false;
}

/** Container headers to render, worked out from the children held. */
export function visibleContainers(grants) {
  const held = new Set(grants);
  const out = new Set();
  for (const c of CAPABILITIES) {
    if (c.container && held.has(c.key)) out.add(c.container);
  }
  return [...out];
}
