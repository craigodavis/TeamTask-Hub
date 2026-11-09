/**
 * The apps TeamHub is divided into, and which one a URL belongs to.
 *
 * See docs/APPS.md for the reasoning. Two rules carry the whole design:
 *
 * 1. An app is DERIVED from capabilities, never granted. There is no `app`
 *    column and no app checkbox, for the same reason containers never had one
 *    (docs/PERMISSIONS.md): a gate on the container can only produce the
 *    failure where a granted child is invisible, or worse, where the two checks
 *    disagree and nobody can tell which won. An app appears when you hold any
 *    item in it. Nothing here grants anything -- every route keeps its own
 *    server-side `requireCapability`, untouched.
 *
 * 2. The current app is a function of the URL, not a piece of state. Picking an
 *    app navigates; the shell then reads the path back. That is what makes a
 *    pasted deep link land in the right app with the right menu, and it means
 *    there is no "current app" that can drift out of step with what is on
 *    screen.
 *
 * Paths are exactly what the router already serves. Moving `/events` under
 *    `/marketing` and `/quickbooks` under `/kitchen` is worth doing -- it is
 *    phase 1 in docs/APPS.md -- but it is a separate change, and this file is
 *    what makes it safe to do later: the groupings live here rather than in six
 *    hand-maintained path predicates.
 */

/** Stroke icons, 24x24, drawn on `currentColor`. No emoji: they render as
 *  somebody else's typeface at somebody else's size and cannot take a colour. */
const I = {
  gauge: 'M12 13a1 1 0 100-2 1 1 0 000 2zM12.7 11.3L16 8M4.5 18a9 9 0 1115 0',
  check: 'M9 11l2 2 4-4M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z',
  listCheck: 'M4 6h2l1 1 2-2M4 12h2l1 1 2-2M4 18h2l1 1 2-2M13 6h7M13 12h7M13 18h7',
  megaphone: 'M3 11v2a1 1 0 001 1h2l5 4V6L6 10H4a1 1 0 00-1 1zM16 8a5 5 0 010 8',
  calendar: 'M3 9h18M7 3v4M17 3v4M4 5h16a1 1 0 011 1v13a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1z',
  book: 'M4 5a2 2 0 012-2h13v18H6a2 2 0 01-2-2V5zM8 7h8M8 11h6',
  people: 'M16 19v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 10.5a3 3 0 100-6 3 3 0 000 6zM21 19v-1a4 4 0 00-3-3.9',
  table: 'M3 10h18M3 6h18v12H3zM9 10v8M15 10v8',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  layers: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5',
  rows: 'M4 7h16M6 7v12M18 7v12M4 13h16',
  tag: 'M20 12l-8 8-8-8V4h8l8 8zM8 8h.01',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  menuCard: 'M6 3h12v18H6zM10 7v10M14 7v10',
  star: 'M12 3l2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.4l6.1-.8z',
  cart: 'M3 4h2l2.5 11h10L20 7H6M9.5 20a1 1 0 100-2 1 1 0 000 2zM17 20a1 1 0 100-2 1 1 0 000 2z',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4V7zM3 7l9 4 9-4M12 11v10',
  chef: 'M6 20h12M7 16h10l1-5H6l1 5zM12 11V7M9 7a3 3 0 016 0',
  leaf: 'M4 20C4 10 10 4 20 4c0 10-6 16-16 16zM9 15l7-7',
  catalog: 'M4 5h4v4H4zM12 6h8M12 9h5M4 15h4v4H4zM12 16h8M12 19h5',
  scan: 'M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3M7 12h10',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6',
  inbox: 'M3 13h5l1 3h6l1-3h5M5 5h14l2 8v6H3v-6z',
  droplet: 'M12 3s6 6.5 6 10.5a6 6 0 11-12 0C6 9.5 12 3 12 3z',
  lines: 'M4 6h16M4 12h10M4 18h7',
  bottle: 'M10 3h4v4l2 3v11H8V10l2-3V3zM8 14h8',
  doc: 'M6 3h8l4 4v14H6V3zM14 3v4h4M9 13h6M9 17h6',
  stamp: 'M5 21h14M8 17h8v-3a4 4 0 00-8 0zM12 10V6',
  mic: 'M12 15a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3zM5 11a7 7 0 0014 0M12 18v3',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  phone: 'M8 2h8a1 1 0 011 1v18a1 1 0 01-1 1H8a1 1 0 01-1-1V3a1 1 0 011-1zM10 19h4',
  image: 'M3 5h18v14H3zM3 15l5-5 4 4 3-3 6 6M7 9h.01',
  folder: 'M3 7h6l2 2h10v10H3V7z',
  quote: 'M8 7H5a2 2 0 00-2 2v3a2 2 0 002 2h3V7zM19 7h-3a2 2 0 00-2 2v3a2 2 0 002 2h3V7zM8 14c0 2-1 3-3 3M19 14c0 2-1 3-3 3',
  window: 'M3 5h18v14H3zM3 9h18M6 7h.01M9 7h.01',
  globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3a14 14 0 000 18 14 14 0 000-18z',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 13a7.6 7.6 0 000-2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 00-1.7-1L15 3.5h-4l-.4 2.6a7.6 7.6 0 00-1.7 1l-2.3-1-2 3.4L4.6 11a7.6 7.6 0 000 2l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 001.7 1l.4 2.6h4l.4-2.6a7.6 7.6 0 001.7-1l2.3 1 2-3.4-2-1.5z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9.5 12l1.8 1.8 3.2-3.4',
  chart: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  chat: 'M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  ledger: 'M4 5a2 2 0 012-2h13v18H6a2 2 0 01-2-2V5zM9 8h7M9 12h5M9 16h7',
  gate: 'M4 20V9l8-5 8 5v11M9 20v-6h6v6',
  bot: 'M7 8h10a2 2 0 012 2v7a2 2 0 01-2 2H7a2 2 0 01-2-2v-7a2 2 0 012-2zM12 5V3M9.5 13h.01M14.5 13h.01',
};

/** A nav item is shown when its `cap` is held, or its `show(user)` says so. */
const cap = (c) => (user, can) => can(user, c);
const capAny = (...cs) => (user, can) => cs.some((c) => can(user, c));

/**
 * The apps, in switcher order. `color` is [light, dark] -- the accents have to
 * invert rather than darken, because a hue that reads on paper disappears on
 * near-black. Every pair here was measured against all three surfaces of its
 * own theme and clears 5.3:1 on the worst of them.
 */
export const APPS = [
  {
    id: 'team',
    name: 'Team',
    blurb: 'Tasks, schedule, policies, your profile',
    color: ['#55544f', '#b9b7ad'],
    icon: I.people,
    nav: [
      { to: '/dashboard', label: 'Dashboard', icon: I.gauge, when: cap('dashboard.view') },
      { to: '/tasks', label: 'Tasks', icon: I.check, when: cap('tasks.own'), alsoMatches: ['/'] },
      { to: '/manage?tab=tasks', label: 'Manage Tasks', icon: I.listCheck, when: cap('tasks.manage') },
      { to: '/manage?tab=announcements', label: 'Announcements', icon: I.megaphone, when: cap('announcements.manage') },
      { to: '/scheduling', label: 'Scheduling', icon: I.calendar, when: cap('scheduling.manage') },
      { to: '/policies', label: 'Policies', icon: I.book, when: cap('policies.read') },
      { to: '/crew', label: 'The Crew', icon: I.people, when: cap('crew.profile') },
    ],
  },
  {
    id: 'floor',
    name: 'Floor',
    blurb: 'The tasting room, during service',
    color: ['#9c4a21', '#e9a07a'],
    icon: I.table,
    nav: [
      { to: '/tasting-room/reservations', label: 'Bookings', icon: I.table, when: cap('tastingroom.reservations'), exact: true },
      { to: '/tasting-room/reservations/floor', label: 'Floor Plan', icon: I.grid, when: (u, c, isOwner) => isOwner(u) },
      { to: '/tasting-room/reservations/layouts', label: 'Layouts', icon: I.layers, when: (u, c, isOwner) => isOwner(u) },
      { to: '/tasting-room/reservations/tables', label: 'Areas & Tables', icon: I.rows, when: (u, c, isOwner) => isOwner(u) },
      { to: '/tasting-room/reservations/offers', label: 'Offers', icon: I.tag, when: (u, c, isOwner) => isOwner(u) },
      { to: '/tasting-room/reservations/hours', label: 'Hours & Limits', icon: I.clock, when: (u, c, isOwner) => isOwner(u) },
      { to: '/tasting-room/reservations/settings', label: 'Booking Settings', icon: I.gear, when: (u, c, isOwner) => isOwner(u) },
      { to: '/tasting-room/menus', label: 'Menus', icon: I.menuCard, when: cap('tastingroom.menus') },
      // Private Events never became a capability; it is still gated on the role
      // in App.jsx. Mirrored rather than invented, so the menu cannot offer
      // something the route will bounce.
      { to: '/marketing/private-events', label: 'Private Events', icon: I.star, when: (u) => u?.role === 'owner' || u?.role === 'manager' },
    ],
  },
  {
    id: 'kitchen',
    name: 'Kitchen',
    blurb: 'Food cost, from delivery to plate to bin',
    color: ['#4a6b2a', '#a9c983'],
    icon: I.chef,
    nav: [
      { to: '/food', label: 'Shopping & Waste', icon: I.cart, when: cap('kitchen.shopping') },
      { to: '/kitchen/inventory', label: 'Inventory', icon: I.box, when: capAny('kitchen.inventory', 'kitchen.settings') },
      { to: '/recipes/list', label: 'Recipes', icon: I.chef, when: cap('kitchen.recipes') },
      { to: '/recipes/ingredients', label: 'Ingredients', icon: I.leaf, when: cap('kitchen.ingredients') },
      { to: '/recipes/catalog', label: 'Item Catalog', icon: I.catalog, when: cap('kitchen.catalog') },
      { to: '/recipes/scan', label: 'Scan Receipt', icon: I.scan, when: cap('kitchen.receipts.scan') },
      { to: '/quickbooks', label: 'Receipts', icon: I.receipt, when: cap('kitchen.receipts') },
      { to: '/kitchen/sources', label: 'Receipt Sources', icon: I.inbox, when: cap('kitchen.receipt_sources') },
    ],
  },
  {
    id: 'cellar',
    name: 'Cellar',
    blurb: 'Vineyard, harvest, wine and compliance',
    color: ['#7a3156', '#dba3c0'],
    icon: I.bottle,
    nav: [
      { to: '/ground-control', label: 'Vineyard', icon: I.droplet, when: cap('groundcontrol.use') },
      { to: '/product-lines', label: 'Product Lines', icon: I.lines, when: cap('wine.lines') },
      { to: '/products', label: 'Products', icon: I.bottle, when: cap('wine.products'), exact: true },
      { to: '/products/inventory', label: 'Wine Inventory', icon: I.box, when: cap('wine.inventory'), exact: true },
      { to: '/products/inventory/report', label: 'Wine Reports', icon: I.doc, when: cap('wine.reports') },
      { to: '/abc', label: 'ABC Filing', icon: I.stamp, when: cap('reports.operational') },
    ],
  },
  {
    id: 'marketing',
    name: 'Marketing',
    blurb: 'Events, talent, campaigns and the club',
    color: ['#0c447c', '#9cc5ef'],
    icon: I.megaphone,
    nav: [
      { to: '/events', label: 'Events & Talent', icon: I.mic, when: cap('marketing.events') },
      { to: '/marketing/campaigns', label: 'Campaigns', icon: I.mail, when: cap('marketing.campaigns') },
      { to: '/marketing/loyalty', label: 'Loyalty', icon: I.star, when: cap('marketing.loyalty') },
      { to: '/kindred-app', label: 'Kindred App', icon: I.phone, when: cap('kindredapp.manage') },
    ],
  },
  {
    id: 'website',
    name: 'Website',
    blurb: 'What the public sees, and how it ships',
    color: ['#115c66', '#8fcdd6'],
    icon: I.globe,
    nav: [
      { to: '/marketing/images', label: 'Pages & Images', icon: I.image, when: cap('marketing.media') },
      { to: '/marketing/media', label: 'Media Library', icon: I.folder, when: cap('marketing.media'), exact: true },
      { to: '/marketing/website/testimonials', label: 'Testimonials', icon: I.quote, when: cap('marketing.website') },
      { to: '/marketing/website/popup', label: 'Home Popup', icon: I.window, when: cap('marketing.website') },
      { to: '/marketing/hours', label: 'Store Hours', icon: I.clock, when: cap('marketing.hours') },
      { to: '/marketing/website/settings', label: 'Website Settings', icon: I.gear, when: cap('marketing.website') },
    ],
  },
  {
    id: 'admin',
    name: 'Admin',
    blurb: 'People, books, integrations and agents',
    color: ['#3f3e39', '#a8a69d'],
    icon: I.gear,
    nav: [
      { to: '/settings', label: 'Users & Settings', icon: I.shield, when: cap('users.assist') },
      { to: '/manage?tab=reports', label: 'Reports', icon: I.chart, when: capAny('reports.scheduled', 'reports.operational') },
      { to: '/manage?tab=integrations', label: 'SMS Send', icon: I.chat, when: cap('sms.send') },
      { to: '/square', label: 'Kindred AI', icon: I.spark, when: cap('ai.use'), exact: true },
      { to: '/betty', label: 'Betty Bookkeeper', icon: I.ledger, when: cap('betty.use') },
      { to: '/gateway', label: 'Gateway', icon: I.gate, when: cap('gateway.use') },
      { to: '/skynet', label: 'Skynet', icon: I.bot, when: cap('skynet.view') },
    ],
  },
];

/** Paths the router serves that are a detail view of a nav item, not their own
 *  entry. Listed so the sidebar still highlights the right row while you are
 *  three levels into something. */
const DETAIL_OF = [
  ['/products/new', '/products'],
  ['/products/', '/products'],
  ['/product-lines/', '/product-lines'],
  ['/recipes/', '/recipes/list'],
  ['/food/', '/food'],
  ['/square/reconcile', '/square'],
  ['/waste', '/food'],
  ['/marketing/event-requests', '/marketing/private-events'],
  ['/marketing/settings', '/marketing/website/settings'],
  ['/sync-users', '/settings'],
];

const qs = (search) => {
  try { return new URLSearchParams(search || '').get('tab'); } catch { return null; }
};

/** Split "/manage?tab=reports" into its parts. */
function parseTo(to) {
  const i = to.indexOf('?');
  if (i === -1) return { path: to, tab: null };
  return { path: to.slice(0, i), tab: qs(to.slice(i)) };
}

/**
 * The nav items this person may see in one app. Empty means the app is not
 * theirs -- there is no separate test, which is what keeps the switcher and the
 * sidebar from ever disagreeing about whether an app exists.
 */
export function navFor(app, user, can, isOwner) {
  return app.nav.filter((item) => {
    try { return !!item.when(user, can, isOwner); } catch { return false; }
  });
}

/** Every app this person holds at least one item in, in switcher order. */
export function visibleApps(user, can, isOwner) {
  return APPS
    .map((app) => ({ app, nav: navFor(app, user, can, isOwner) }))
    .filter(({ nav }) => nav.length > 0);
}

/**
 * Which app owns this URL, and which of its items is current.
 *
 * Longest match wins, so `/products/inventory` picks Wine Inventory rather than
 * Products, and an `exact` item never swallows a deeper sibling. This replaces
 * the six hand-maintained `isKitchenPath`-style predicates that had to be
 * remembered separately from the routes themselves.
 */
export function matchPath(pathname, search) {
  const tab = qs(search);
  let best = null;

  const consider = (app, item, score) => {
    if (!best || score > best.score) best = { app, item, score };
  };

  for (const app of APPS) {
    for (const item of app.nav) {
      const { path, tab: wantTab } = parseTo(item.to);
      if (wantTab) {
        if (pathname === path && tab === wantTab) consider(app, item, 1000 + path.length);
        continue;
      }
      if (pathname === path) { consider(app, item, 900 + path.length); continue; }
      if (item.alsoMatches?.includes(pathname)) { consider(app, item, 900 + path.length); continue; }
      if (item.exact) continue;
      if (pathname.startsWith(path.endsWith('/') ? path : path + '/')) {
        consider(app, item, 100 + path.length);
      }
    }
  }

  if (best) return best;

  // A detail route: /products/abc123 belongs to Products even though no nav
  // item spells it out.
  for (const [prefix, target] of DETAIL_OF) {
    if (pathname === prefix || pathname.startsWith(prefix)) {
      for (const app of APPS) {
        const item = app.nav.find((n) => n.to === target);
        if (item) return { app, item, score: 1 };
      }
    }
  }
  return null;
}

/** The app a URL belongs to, or null when nothing claims it. */
export const appForPath = (pathname, search) => matchPath(pathname, search)?.app || null;

/** Where picking an app in the switcher should take you. */
export const landingFor = (app, user, can, isOwner) => navFor(app, user, can, isOwner)[0]?.to || '/';

/** The accent for an app in the theme currently painted. */
export const accentFor = (app, dark) => (dark ? app.color[1] : app.color[0]);
