import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });
import express from 'express';
import cors from 'cors';
import { query } from './db.js';
import { authRouter } from './routes/auth.js';
import { companiesRouter } from './routes/companies.js';
import { taskListsRouter, startDailyArchiveScheduler } from './routes/taskLists.js';
import { announcementsRouter } from './routes/announcements.js';
import { foodWasteRouter } from './routes/foodWaste.js';
import { integrationsRouter, startDailySquareAutoSync, startReportScheduler } from './routes/integrations.js';
import { scheduledReportsRouter } from './routes/scheduledReports.js';
import { qboRouter } from './routes/qbo.js';
import { requireAuth, requireManager, requireScheduleAccess } from './middleware/auth.js';
import { serviceTokensRouter } from './routes/serviceTokens.js';
import { bettyRouter } from './routes/betty.js';
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
import { schedulingRouter } from './routes/scheduling.js';
import { feedbackRouter } from './routes/feedback.js';
import { eventsRouter, musiciansRouter } from './routes/events.js';
import { commerce7SyncRouter } from './routes/commerce7Sync.js';
import { recipesRouter } from './routes/recipes.js';
import { ensureLocationsTables } from './ensureLocationsTables.js';
import { runMigrations } from './scripts/run-migrations.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

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
app.use('/api/integrations', requireAuth, requireManager, integrationsRouter);
app.use('/api/settings', requireAuth, settingsRouter);
app.use('/api/locations', requireAuth, locationsRouter);
app.use('/api/debt', requireAuth, debtRouter);
app.use('/api/receipts', requireAuth, receiptsRouter);
app.use('/api/harvester', requireAuth, harvesterRouter);
app.use('/api/amazon-orders', requireAuth, amazonOrdersRouter);
app.use('/api/amazon-session', requireAuth, amazonSessionRouter);
app.use('/api/card-mappings', requireAuth, cardMappingsRouter);
app.use('/api/square', requireAuth, requireManager, squareRouter);
app.use('/api/square/sync', requireAuth, requireManager, squareSyncRouter);
// Mounted before /api/products so it isn't swallowed by that router's GET /:id.
app.use('/api/products/inventory', requireAuth, productInventoryRouter);
app.use('/api/scheduling', requireAuth, requireScheduleAccess, schedulingRouter);
app.use('/api/feedback', feedbackRouter);                        // public — token + PIN, no login
app.use('/api/events', requireAuth, requireScheduleAccess, eventsRouter);
app.use('/api/musicians', requireAuth, requireScheduleAccess, musiciansRouter);
app.use('/api/products', requireAuth, productsRouter);
app.use('/api/recipes', requireAuth, recipesRouter);
app.use('/api/commerce7/sync', requireAuth, requireManager, commerce7SyncRouter);
app.use('/api/service-tokens', requireAuth, serviceTokensRouter);
app.use('/api/betty', requireAuth, bettyRouter);  // owner enforced in UI; any authed user can list their own
app.use('/api/team', requireAuth, teamRouter);
app.use('/api/skynet', requireAuth, requireManager, skynetRouter);
app.use('/api/gateway', requireAuth, gatewayRouter);
app.use('/api/ground-control', requireAuth, groundControlRouter);
app.use('/api/reports/view', scheduledReportsRouter);          // public — no auth
app.use('/api/reports/scheduled', requireAuth, requireManager, scheduledReportsRouter);

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

runMigrations()
  .catch((err) => console.error('Migration error (non-fatal):', err.message))
  .finally(() => {
    // Any sync stuck in 'running' from before the server stopped is now stale — reset it.
    query(`UPDATE square_sync_objects SET last_sync_status = NULL WHERE last_sync_status = 'running'`)
      .catch((e) => console.warn('Could not reset stuck Square sync statuses:', e.message));
    query(`UPDATE teamtask_hub.commerce7_sync_objects SET last_sync_status = NULL WHERE last_sync_status = 'running'`)
      .catch((e) => console.warn('Could not reset stuck C7 sync statuses:', e.message));
    return ensureLocationsTables();
  })
  .then(() => {
    console.log('Schema checks (locations / migration 008) finished.');
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
    startTalentReminderScheduler();
  })
  .catch((err) => {
    console.error('ensureLocationsTables failed:', err);
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
    startTalentReminderScheduler();
  });
