const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../inventory-analysis/data');
const LEDGER_FILE = path.join(DATA_DIR, 'catalog_ledger.json');
const BACKUP_FILE = path.join(DATA_DIR, 'catalog_ledger.backup.json');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

console.log('================================================================');
console.log('   PRODUCTION CATALOG LEDGER BACKUP TOOL                        ');
console.log('================================================================\n');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(BACKUPS_DIR)) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

if (!fs.existsSync(LEDGER_FILE)) {
  console.log(`[Notice] Primary ledger file not found at: ${LEDGER_FILE}`);
  console.log('         Creating empty initialized ledger with protection metadata...');
  const initData = {
    updatedAt: new Date().toISOString(),
    merges: [],
    separates: []
  };
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(initData, null, 2), 'utf8');
}

try {
  const content = fs.readFileSync(LEDGER_FILE, 'utf8');
  const parsed = JSON.parse(content);

  const mergesCount = Array.isArray(parsed.merges) ? parsed.merges.length : 0;
  const separatesCount = Array.isArray(parsed.separates) ? parsed.separates.length : 0;

  // 1. Snapshot with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = path.join(BACKUPS_DIR, `catalog_ledger_${timestamp}.json`);
  fs.writeFileSync(snapshotPath, content, 'utf8');

  // 2. Mirror backup file
  fs.writeFileSync(BACKUP_FILE, content, 'utf8');

  console.log(`  ✅ Successfully backed up Catalog Ledger.`);
  console.log(`     Primary:      ${LEDGER_FILE}`);
  console.log(`     Hot Backup:   ${BACKUP_FILE}`);
  console.log(`     Snapshot:     ${snapshotPath}`);
  console.log(`     Data Stats:   ${mergesCount} MERGE decisions, ${separatesCount} KEEP_SEPARATE decisions`);
  console.log('\n[Status] Catalog Ledger is safely backed up and protected for production.\n');
} catch (err) {
  console.error('  ❌ Error during ledger backup:', err.message);
  process.exit(1);
}
