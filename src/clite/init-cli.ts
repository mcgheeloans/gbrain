/**
 * C-lite init CLI: standalone command to initialize a C-lite SQLite database.
 *
 * Usage:
 *   bun run src/clite/init-cli.ts [path]
 *
 * Default path: ./gbrain-clite.db
 */

import { bootstrap, listTables } from './bootstrap.ts';

const dbPath = process.argv[2] || './gbrain-clite.db';

console.log(`C-lite: initializing database at ${dbPath}...`);

try {
  const result = bootstrap(dbPath);

  if (result.created) {
    console.log(`Created new database: ${result.path}`);
  } else {
    console.log(`Database already exists, schema verified: ${result.path}`);
  }

  const tables = listTables(result.db);
  console.log(`Tables (${tables.length}): ${tables.join(', ')}`);

  // Quick sanity check: read the meta values
  const meta = result.db.query('SELECT key, value FROM clite_meta').all() as { key: string; value: string }[];
  for (const row of meta) {
    console.log(`  ${row.key} = ${row.value}`);
  }

  result.db.close();
  console.log('Done.');
} catch (err) {
  console.error('Failed to initialize C-lite database:', err);
  process.exit(1);
}
