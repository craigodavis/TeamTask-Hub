# TeamTask Hub

Multi-tenant task lists, announcements with read acknowledgment, and food waste tracking. Integrates with Square (Team API) and Twilio (SMS).

## Setup

1. **Database**  
   You already ran the DDL. If your schema has no `password_hash` on `users`, run:
   ```bash
   psql $YOUR_CONNECTION -f server/migrations/001_add_password_hash.sql
   ```
   (Use the same schema as your DDL, e.g. set `search_path` to `teamtask_hub` if needed.)

2. **Backend env**  
   Copy `server/.env.example` to `server/.env` and set:
   - `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USER`, `DB_PASSWORD`, `DB_SCHEMA` (e.g. `teamtask_hub`). You can copy `admin/.env` from clubsteward and set `DB_SCHEMA=teamtask_hub`, `PORT=3001`, and `JWT_SECRET`.
   - `JWT_SECRET` (min 32 chars)
   - Optional: `SQUARE_ACCESS_TOKEN`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`

3. **First company and user**  
   Insert a company and a manager user (with password hash). Example (adjust schema/schema name):
   ```sql
   INSERT INTO companies (name, slug) VALUES ('My Company', 'my-company');
   -- Then register via POST /api/auth/register with company_id = that company id, role = 'manager',
   -- or insert user + password_hash (bcrypt) manually.
   ```

4. **Install and run**
   ```bash
   npm install
   cd server && npm install && cd ..
   cd client && npm install && cd ..
   npm run server   # in one terminal, port 3001
   npm run client   # in another, port 5173; proxy /api to 3001
   ```
   Or `npm run dev` to run both (if concurrently is installed).

5. **Login**  
   Open http://localhost:5173, sign in with the manager user. Create task list templates and assign them to days from Manage → Tasks. Staff see tasks on the dashboard and check them off; announcements appear on the right (or top on mobile) with “Confirm read”.

## Features

- **Dashboard**: Date picker, task list(s) for the day with check-off toggles; announcements with “Confirm read”. Link to Food waste.
- **Manage** (managers): Task list templates and assignments; announcements CRUD and “Who read”; food waste ingredients and entries; Square sync (team members); Twilio SMS to team and SMS log.
- **Food waste**: List of entries (last 7 days); open an entry to add items (ingredient + weight). Who discarded and when is logged.

## Tech

- Node.js 22 LTS, Express, PostgreSQL (schema via `DB_SCHEMA`), JWT auth.
- React 18, Vite, React Router. Responsive, touch-friendly layout.
