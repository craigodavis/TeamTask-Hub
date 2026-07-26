/**
 * Read the FileBird folder structure straight from WordPress's MySQL database,
 * so imported images land in the same folders they're organized into in WP.
 *
 * WordPress runs on this same cPanel box, so we read its wp-config.php from disk
 * to get the DB login (no credentials to paste anywhere), connect to the local
 * MySQL, and load FileBird's tables:
 *   {prefix}fbv                    → folder tree (id, name, parent)
 *   {prefix}fbv_attachment_folder  → which attachment is in which folder
 *
 * Everything here is optional + read-only: if wp-config.php can't be found or the
 * tables don't exist, we return null and the importer just skips folder mapping.
 */
import fs from 'fs';
import mysql from 'mysql2/promise';

// Candidate wp-config.php locations (override with WP_CONFIG_PATH).
const CONFIG_CANDIDATES = [
  process.env.WP_CONFIG_PATH,
  '/home/kindredv/public_html/wp-config.php',
  '/home/kindredv/kindredvineyards.com/wp-config.php',
  '/home/kindredv/www/wp-config.php',
].filter(Boolean);

function parseWpConfig() {
  const tried = [];
  for (const p of CONFIG_CANDIDATES) {
    try {
      if (!fs.existsSync(p)) { tried.push(`${p} (not found)`); continue; }
      const txt = fs.readFileSync(p, 'utf8');
      const grab = (key) => {
        const m = txt.match(new RegExp(`define\\(\\s*['"]${key}['"]\\s*,\\s*['"]([^'"]*)['"]`));
        return m ? m[1] : null;
      };
      const prefixM = txt.match(/\$table_prefix\s*=\s*['"]([^'"]+)['"]/);
      const cfg = {
        path: p,
        database: grab('DB_NAME'),
        user: grab('DB_USER'),
        password: grab('DB_PASSWORD'),
        host: grab('DB_HOST') || 'localhost',
        prefix: prefixM ? prefixM[1] : 'wp_',
      };
      if (cfg.database && cfg.user != null) return { cfg, tried };
      tried.push(`${p} (unparseable)`);
    } catch (e) {
      tried.push(`${p} (${e.message})`);
    }
  }
  return { cfg: null, tried };
}

// DB_HOST can be "localhost", "localhost:3306", or "localhost:/path/to/socket".
function connectOptions(cfg) {
  const opts = { user: cfg.user, password: cfg.password, database: cfg.database };
  const host = cfg.host || 'localhost';
  if (host.includes(':')) {
    const [h, portOrSock] = host.split(':');
    if (/^\d+$/.test(portOrSock)) { opts.host = h; opts.port = Number(portOrSock); }
    else { opts.socketPath = portOrSock; }
  } else {
    opts.host = host;
  }
  return opts;
}

/**
 * Build a map of WP attachment id → folder path (e.g. "Wines/Estate Reds").
 * @returns {Promise<{ map: Map<number,string>, folderCount: number, source: string } | { error: string }>}
 */
export async function loadFileBirdFolders() {
  const { cfg, tried } = parseWpConfig();
  if (!cfg) {
    return { error: `wp-config.php not found/parseable. Tried: ${tried.join('; ')}. Set WP_CONFIG_PATH.` };
  }

  let conn;
  try {
    conn = await mysql.createConnection(connectOptions(cfg));
    const [folders] = await conn.execute(`SELECT id, name, parent FROM \`${cfg.prefix}fbv\``);
    const [links] = await conn.execute(`SELECT folder_id, attachment_id FROM \`${cfg.prefix}fbv_attachment_folder\``);

    // Resolve each folder id to its full path by walking parents.
    const byId = new Map(folders.map((f) => [Number(f.id), { name: f.name, parent: Number(f.parent) }]));
    const pathCache = new Map();
    const pathFor = (id, guard = 0) => {
      if (pathCache.has(id)) return pathCache.get(id);
      const node = byId.get(id);
      if (!node || guard > 20) return null;
      const parentPath = node.parent > 0 ? pathFor(node.parent, guard + 1) : null;
      const full = parentPath ? `${parentPath}/${node.name}` : node.name;
      pathCache.set(id, full);
      return full;
    };

    const map = new Map();
    for (const l of links) {
      const p = pathFor(Number(l.folder_id));
      if (p) map.set(Number(l.attachment_id), p);
    }
    return { map, folderCount: folders.length, source: cfg.path };
  } catch (e) {
    return { error: `WP DB read failed (${cfg.path}): ${e.message}` };
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}
