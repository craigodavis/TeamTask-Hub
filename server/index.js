import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { query } from './db.js';
import { authRouter } from './routes/auth.js';
import { companiesRouter } from './routes/companies.js';
import { taskListsRouter, startDailyArchiveScheduler } from './routes/taskLists.js';
import { announcementsRouter } from './routes/announcements.js';
import { foodWasteRouter } from './routes/foodWaste.js';
import { integrationsRouter, startDailySquareAutoSync, startReportScheduler } from './routes/integrations.js';
import { scheduledReportsRouter } from './routes/scheduledReports.js';
import { permissionsRouter } from './routes/permissions.js';
import { qboRouter } from './routes/qbo.js';
import { requireAuth, requireCapability } from './middleware/auth.js';
import { serviceTokensRouter } from './routes/serviceTokens.js';
import { bettyRouter } from './routes/betty.js';
import { abcRouter } from './routes/abc.js';
import { dashboardRouter } from './routes/dashboard.js';
import { emailMediaRouter } from './routes/emailMedia.js';
import { emailSubscriberRouter } from './routes/emailSubscriber.js';
import { campaignsRouter } from './routes/campaigns.js';
import { menusRouter } from './routes/menus.js';
import { loyaltyRouter, memberRouter as loyaltyMemberRouter } from './routes/loyalty.js';
import { clubNotificationsRouter } from './routes/clubNotifications.js';
import { kindredAppRouter } from './routes/kindredApp.js';
import { kindredSignupRouter } from './routes/kindredSignup.js';
import { kindredPerksRouter } from './routes/kindredPerks.js';
import { startClubPushScheduler } from './lib/clubPush.js';
import { teamRouter } from './routes/team.js';
import { skynetRouter } from './routes/skynet.js';
import { startSkynetScheduler } from './lib/skynetScheduler.js';
import { gatewayRouter } from './routes/gateway.js';
import { groundControlRouter } from './routes/groundControl.js';
import { startRachioScheduler } from './lib/rachioScheduler.js';
import { startGatewayAutoApproveScheduler } from './lib/gatewayRules.js';
import { startC7SyncScheduler } from './lib/commerce7Sync.js';
import { startFactorSyncScheduler } from './lib/factorSync.js';
import { startFeedbackScheduler } from './lib/feedbackSender.js';
import { startTalentReminderScheduler } from './lib/talentReminders.js';
import { startPromoReminderScheduler } from './lib/promoReminders.js';
import { startZeroCanaryScheduler } from './lib/qboZeroCanary.js';
import { startAbcPortalScheduler } from './lib/abcPortalScheduler.js';
import { settingsRouter } from './routes/settings.js';
import { locationsRouter } from './routes/locations.js';
import { debtRouter } from './routes/debt.js';
import { receiptsRouter } from './routes/receipts.js';
import { harvesterRouter } from './routes/harvester.js';
import { amazonOrdersRouter } from './routes/amazonOrders.js';
import { amazonSessionRouter } from './routes/amazonSession.js';
import { cardMappingsRouter } from './routes/cardMappings.js';
import { squareRouter } from './routes/square.js';
import { squareSyncRouter, startSquareSyncScheduler } from './routes/squareSync.js';
import { productsRouter } from './routes/products.js';
import { productInventoryRouter } from './routes/productInventory.js';
import { productLinesRouter } from './routes/productLines.js';
import { schedulingRouter } from './routes/scheduling.js';
import { feedbackRouter } from './routes/feedback.js';
import { eventsRouter, musiciansRouter } from './routes/events.js';
import { promoRouter } from './routes/promo.js';
import { startPromoEmailScheduler } from './lib/promoEmailSender.js';
import { startPublishWarningScheduler } from './lib/eventPublishWarning.js';
import { startEventTaskReminderScheduler } from './lib/eventTaskReminders.js';
import { commerce7SyncRouter } from './routes/commerce7Sync.js';
import { recipesRouter } from './routes/recipes.js';
import { mediaRouter } from './routes/media.js';
import { hoursRouter } from './routes/hours.js';
import reservationsRouter from './routes/reservations.js';
import eventRequestsRouter from './routes/eventRequests.js';
import { pageImagesRouter } from './routes/pageImages.js';
import { startInstagramScheduler } from './lib/instagramSync.js';
// Rebuilds the public website when anything it reads changes here.
import { websiteContentWatch } from './lib/websiteDeploy.js';
import { crewRouter } from './routes/crew.js';
import { websiteRouter } from './routes/website.js';
import { marketingRouter } from './routes/marketing.js';
import { mcpDbRouter } from './routes/mcpDb.js';
import { ensureLocationsTables } from './ensureLocationsTables.js';
import { ensureKindredWebTables } from './ensureKindredWebTables.js';
import { runMigrations } from './scripts/run-migrations.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: true, credentials: true }));
// Ahead of the global parser, and more generous than it: Commerce7 posts the
// ENTIRE changed object to the webhook, and a fat product can clear the default
// 100kb. A 413 there is counted as a delivery failure, and 48h of those makes
// Commerce7 disable the webhook permanently — it can only be recreated, not
// re-enabled. body-parser marks the request once parsed, so express.json() below
// sees this one is done and leaves it alone.
app.use('/api/website/commerce7-hook', express.json({ limit: '5mb' }));
// A truncated or malformed body must not read as a delivery failure — 48h of
// those and Commerce7 disables the webhook for good. Swallow the parse error and
// answer 200: there's nothing to act on, and the next change will tell us again.
// (This also stops Express's default handler returning a stack trace and server
// paths on a public endpoint.)
app.use('/api/website/commerce7-hook', (err, req, res, next) => {
  if (!err) return next();
  console.warn('[commerce7-hook] unparseable body:', err.message);
  res.status(200).json({ ok: true });
});
app.use(express.json());
// The Kindred app's member session is an httpOnly cookie issued by ClubSteward on
// domain .kindredvineyards.com, so it reaches this host too. The app cannot read
// it (that is the point) — the server has to.
app.use(cookieParser());

// Serve uploaded files (announcement images, etc.)
// /api/uploads is used for production (nginx proxies /api/* to Express)
// /uploads kept for backward compat with existing announcement image URLs
const uploadsStatic = express.static(path.join(__dirname, 'uploads'));
app.use('/api/uploads', uploadsStatic);
app.use('/uploads', uploadsStatic);

const clientDist = path.join(__dirname, '..', 'client', 'dist');
const servingClient = fs.existsSync(clientDist);

if (!servingClient) {
  app.get('/', (req, res) => {
    res.json({ name: 'TeamTask Hub API', docs: 'Use /api/* routes. Health: GET /api/health' });
  });
}

app.use('/api/auth', authRouter);
app.use('/api/companies', requireAuth, companiesRouter);
app.use('/api/task-lists', requireAuth, taskListsRouter);
app.use('/api/announcements', requireAuth, announcementsRouter);
app.use('/api/food-waste', requireAuth, foodWasteRouter);
app.use('/api/integrations/qbo', qboRouter);
app.use('/api/integrations', requireAuth, requireCapability('sms.send'), integrationsRouter);
app.use('/api/settings', requireAuth, settingsRouter);
app.use('/api/locations', requireAuth, websiteContentWatch, locationsRouter);
app.use('/api/debt', requireAuth, debtRouter);
app.use('/api/receipts', requireAuth, receiptsRouter);
app.use('/api/harvester', requireAuth, harvesterRouter);
app.use('/api/amazon-orders', requireAuth, amazonOrdersRouter);
app.use('/api/amazon-session', requireAuth, amazonSessionRouter);
app.use('/api/card-mappings', requireAuth, cardMappingsRouter);
app.use('/api/square', requireAuth, requireCapability('ai.use'), squareRouter);
app.use('/api/square/sync', requireAuth, requireCapability('wine.products'), squareSyncRouter);
// Mounted before /api/products so it isn't swallowed by that router's GET /:id.
app.use('/api/products/inventory', requireAuth, productInventoryRouter);
app.use('/api/scheduling', requireAuth, requireCapability('scheduling.manage'), schedulingRouter);
app.use('/api/feedback', feedbackRouter);                        // public — token + PIN, no login
app.use('/api/events', requireAuth, requireCapability('marketing.events'), websiteContentWatch, eventsRouter);
app.use('/api/musicians', requireAuth, requireCapability('marketing.events'), websiteContentWatch, musiciansRouter);
app.use('/api/promo', requireAuth, requireCapability('marketing.events'), promoRouter);
app.use('/api/product-lines', requireAuth, productLinesRouter);
app.use('/api/products', requireAuth, productsRouter);
app.use('/api/recipes', requireAuth, recipesRouter);
app.use('/api/media', requireAuth, websiteContentWatch, mediaRouter);
app.use('/api/hours', requireAuth, websiteContentWatch, hoursRouter);
app.use('/api/reservations', requireAuth, reservationsRouter);
app.use('/api/event-requests', requireAuth, eventRequestsRouter);
app.use('/api/page-images', requireAuth, websiteContentWatch, pageImagesRouter);
app.use('/api/crew', requireAuth, websiteContentWatch, crewRouter);
app.use('/api/website', websiteRouter); // public, read-only — no auth
app.use('/api/marketing', requireAuth, requireCapability('marketing.website'), websiteContentWatch, marketingRouter);
app.use('/api/commerce7/sync', requireAuth, requireCapability('wine.products'), commerce7SyncRouter);
app.use('/api/service-tokens', requireAuth, serviceTokensRouter);
app.use('/api/betty', requireAuth, bettyRouter);  // owner enforced in UI; any authed user can list their own
app.use('/api/abc', requireAuth, abcRouter);       // Idaho ABC wine report — prepares only, never submits
app.use('/api/dashboard', requireAuth, dashboardRouter);  // manager/owner overview; role enforced in the router
// Deliberately NOT behind requireAuth: mail clients fetch images with no session.
// Reachable by anyone, so it resolves records rather than paths — see the router.
app.use('/email-media', emailMediaRouter);
// Email-list gateway for ClubSteward. No session — the caller is a server, so it
// authenticates with the X-Sync-Secret shared secret inside the router, which
// refuses everything when SYNC_SECRET is unset.
app.use('/api/email', emailSubscriberRouter);
app.use('/api/campaigns', requireAuth, campaignsRouter);
app.use('/api/menus', requireAuth, menusRouter);           // tasting-room print menus
app.use('/api/loyalty', loyaltyRouter);           // points: staff admin + cost model
// Club 77 push. Mounted WITHOUT requireAuth: the staff routes guard themselves,
// and the /me/* routes authenticate as a club member, not a TeamHub user.
app.use('/api/club-notifications', clubNotificationsRouter);
app.use('/api/kindred-app', kindredSignupRouter);  // POST /signup — public, creates the account
app.use('/api/kindred-app', kindredPerksRouter);   // perks: member reads, staff redeems with a PIN
app.use('/api/kindred-app', loyaltyMemberRouter);  // member reads their own points balance
app.use('/api/kindred-app', kindredAppRouter);     // members report, settings, activity beacon
app.use('/api/team', requireAuth, teamRouter);
app.use('/api/skynet', requireAuth, requireCapability('skynet.view'), skynetRouter);
app.use('/api/gateway', requireAuth, gatewayRouter);
app.use('/api/ground-control', requireAuth, groundControlRouter);
app.use('/api/reports/view', scheduledReportsRouter);          // public — no auth
app.use('/api/reports/scheduled', requireAuth, requireCapability('reports.scheduled'), scheduledReportsRouter);
app.use('/api/permissions', requireAuth, permissionsRouter);

// Read-only Postgres over MCP. Mounted at the site root rather than under
// /api because PassengerBaseURI is '/' — Apache hands the whole path space
// to this app, so /api is only a convention here, not a requirement.
//
// Must sit ABOVE the static handler and the app.get('*') SPA fallback below,
// or the catch-all answers it with index.html.
//
// The path segment is the only thing guarding this endpoint: it carries no
// requireAuth, by design, because MCP clients cannot present a TeamHub JWT.
app.use(`/mcp/${process.env.MCP_PATH_SECRET}`, mcpDbRouter);

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

if (servingClient) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Listen immediately so the dev proxy (Vite → :3001) works while DB connects or migrations run.
// Previously we awaited ensureLocationsTables() before listen(); slow/unreachable DB caused ECONNREFUSED on /api/*.
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// Every scheduler in one place — the list was duplicated across the success and
// failure paths below, so one could drift from the other.
//
// DISABLE_SCHEDULERS=1 starts the API without them. A local dev server points at
// the production database, so without this a second instance double-fires the
// SMS senders, promo emails, syncs and gateway auto-approve alongside the real
// one. Set it whenever you run this app to look at the UI.
function startSchedulers() {
  if (process.env.DISABLE_SCHEDULERS === '1') {
    console.log('Schedulers DISABLED (DISABLE_SCHEDULERS=1) — API only, no timers.');
    return;
  }
  startDailySquareAutoSync();
  startSquareSyncScheduler();
  startReportScheduler();
  startGatewayAutoApproveScheduler();
  startC7SyncScheduler();
  startSkynetScheduler();
  startDailyArchiveScheduler();
  startRachioScheduler();
  startFactorSyncScheduler();
  startFeedbackScheduler();
  startClubPushScheduler();
  startTalentReminderScheduler();
  startPromoReminderScheduler();
  startInstagramScheduler();
  startPromoEmailScheduler();
  startPublishWarningScheduler();
  startEventTaskReminderScheduler();
  startZeroCanaryScheduler();
  startAbcPortalScheduler();
}

runMigrations()
  .catch((err) => console.error('Migration error (non-fatal):', err.message))
  .finally(() => {
    // Any sync stuck in 'running' from before the server stopped is now stale — reset it.
    query(`UPDATE square_sync_objects SET last_sync_status = NULL WHERE last_sync_status = 'running'`)
      .catch((e) => console.warn('Could not reset stuck Square sync statuses:', e.message));
    query(`UPDATE teamtask_hub.commerce7_sync_objects SET last_sync_status = NULL WHERE last_sync_status = 'running'`)
      .catch((e) => console.warn('Could not reset stuck C7 sync statuses:', e.message));
    return ensureLocationsTables().then(() => ensureKindredWebTables());
  })
  .then(() => {
    console.log('Schema checks (locations / migration 008 / kindred_web) finished.');
    startSchedulers();
  })
  .catch((err) => {
    console.error('ensureLocationsTables failed:', err);
    startSchedulers();
  });
