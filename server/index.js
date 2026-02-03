import dotenv from 'dotenv';
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
import { integrationsRouter } from './routes/integrations.js';
import { requireAuth, requireManager, requireOwner } from './middleware/auth.js';
import { settingsRouter } from './routes/settings.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ name: 'TeamTask Hub API', docs: 'Use /api/* routes. Health: GET /api/health' });
});

app.use('/api/auth', authRouter);
app.use('/api/companies', requireAuth, companiesRouter);
app.use('/api/task-lists', requireAuth, taskListsRouter);
app.use('/api/announcements', requireAuth, announcementsRouter);
app.use('/api/food-waste', requireAuth, foodWasteRouter);
app.use('/api/integrations', requireAuth, requireManager, integrationsRouter);
app.use('/api/settings', requireAuth, settingsRouter);

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
