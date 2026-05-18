import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });
import express from 'express';
import cors from 'cors';
import { authRouter } from './routes/auth.js';
import { companiesRouter } from './routes/companies.js';
import { taskListsRouter } from './routes/taskLists.js';
import { announcementsRouter } from './routes/announcements.js';
import { foodWasteRouter } from './routes/foodWaste.js';
import { integrationsRouter, startDailySquareAutoSync, startReportScheduler } from './routes/integrations.js';
import { scheduledReportsRouter } from './routes/scheduledReports.js';
import { queryActionsRouter } from './routes/queryActions.js';
import { qboRouter } from './routes/qbo.js';
import { requireAuth, requireManager } from './middleware/auth.js';
import { settingsRouter } from './routes/settings.js';
import { locationsRouter } from './routes/locations.js';
import { debtRouter } from './routes/debt.js';
import { receiptsRouter } from './routes/receipts.js';
import { amazonOrdersRouter } from './routes/amazonOrders.js';
import { cardMappingsRouter } from './routes/cardMappings.js';
import { squareRouter } from './routes/square.js';
import { productsRouter } from './routes/products.js';
import { ensureLocationsTables } from './ensureLocationsTables.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

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
app.use('/api/amazon-orders', requireAuth, amazonOrdersRouter);
app.use('/api/card-mappings', requireAuth, cardMappingsRouter);
app.use('/api/square', requireAuth, requireManager, squareRouter);
app.use('/api/products', requireAuth, productsRouter);
app.use('/api/reports/view', scheduledReportsRouter);          // public — no auth
app.use('/api/reports/scheduled', requireAuth, requireManager, scheduledReportsRouter);
app.use('/api/reports/scheduled/:reportId/actions', requireAuth, requireManager, queryActionsRouter);

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

ensureLocationsTables()
  .then(() => {
    console.log('Schema checks (locations / migration 008) finished.');
    startDailySquareAutoSync();
    startReportScheduler();
  })
  .catch((err) => {
    console.error('ensureLocationsTables failed:', err);
    startDailySquareAutoSync();
    startReportScheduler();
  });
