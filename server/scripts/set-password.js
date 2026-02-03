/**
 * One-off script to set a user's password. Uses same DB and bcrypt as the app.
 * Run from server/: node scripts/set-password.js <email> <password>
 * Example: node scripts/set-password.js craig@kindredvineyards.com 'N3h3miah1!'
 */
import { query } from '../db.js';
import bcrypt from 'bcryptjs';

const email = process.argv[2];
const password = process.argv[3];

if (!email || !password) {
  console.error('Usage: node scripts/set-password.js <email> <password>');
  process.exit(1);
}

const emailLower = email.toLowerCase().trim();

async function main() {
  const hash = await bcrypt.hash(password, 10);
  const r = await query(
    `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE email = $2 RETURNING id, email`,
    [hash, emailLower]
  );
  if (r.rows.length === 0) {
    console.error('No user found with email:', emailLower);
    process.exit(1);
  }
  console.log('Password updated for:', r.rows[0].email);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
