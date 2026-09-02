import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DATABASE_PATH || path.resolve(__dirname, '../../database/78pricecheck.db');

let dbInstance: Database | null = null;

export async function getDb(): Promise<Database> {
  if (dbInstance) {
    return dbInstance;
  }

  // Ensure the database directory exists
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  dbInstance = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });

  // Enable foreign keys, WAL journal mode, and busy timeout for high concurrency
  await dbInstance.run('PRAGMA foreign_keys = ON');
  await dbInstance.run('PRAGMA journal_mode = WAL');
  await dbInstance.run('PRAGMA busy_timeout = 5000');

  // Ensure database tables exist
  await initializeDatabase(false);

  return dbInstance;
}

export async function closeDb(): Promise<void> {
  if (dbInstance) {
    await dbInstance.close();
    dbInstance = null;
  }
}

export async function resetDatabase(): Promise<void> {
  const db = await getDb();
  await db.exec('DROP TABLE IF EXISTS hot_deals;');
  await db.exec('DROP TABLE IF EXISTS upload_history;');
  await db.exec('DROP TABLE IF EXISTS products;');
  await initializeDatabase(true);
}

export async function initializeDatabase(seedData = false): Promise<void> {
  const db = await getDb();

  // Create tables if they do not exist
  await db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barcode TEXT NOT NULL,
      name TEXT NOT NULL,
      mrp REAL NOT NULL,
      sale_price REAL NOT NULL,
      wholesale_price REAL NULL,
      wholesale_qty INTEGER NULL,
      discount_percent REAL NOT NULL DEFAULT 0.0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS hot_deals (
      product_id INTEGER PRIMARY KEY,
      position INTEGER NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS upload_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      uploaded_by TEXT NOT NULL,
      total_rows INTEGER NOT NULL,
      successful_rows INTEGER NOT NULL,
      failed_rows INTEGER NOT NULL,
      status TEXT NOT NULL,
      processing_time_ms INTEGER NOT NULL,
      error_details TEXT,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (uploaded_by) REFERENCES admins(username) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scan_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barcode TEXT NOT NULL,
      product_found INTEGER NOT NULL,
      product_id INTEGER,
      scanned_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS diagnostic_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_by TEXT NOT NULL DEFAULT 'admin',
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME,
      total_scans INTEGER DEFAULT 0,
      successful_scans INTEGER DEFAULT 0,
      failed_events INTEGER DEFAULT 0,
      ios_count INTEGER DEFAULT 0,
      android_count INTEGER DEFAULT 0,
      other_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS device_registry (
      device_id TEXT PRIMARY KEY,
      first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      first_seen_session_id TEXT NOT NULL,
      device_os TEXT,
      browser TEXT,
      user_agent TEXT,
      platform TEXT,
      device_pixel_ratio REAL,
      viewport_width INTEGER,
      viewport_height INTEGER,
      cpu_cores INTEGER,
      device_memory_gb REAL,
      gpu_renderer TEXT
    );

    CREATE TABLE IF NOT EXISTS diagnostic_device_telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      device_id TEXT,
      device_id_hash TEXT,
      os TEXT,
      browser TEXT,
      user_agent TEXT,
      platform TEXT,
      device_pixel_ratio REAL,
      viewport_width INTEGER,
      viewport_height INTEGER,
      classification TEXT,
      facing_mode TEXT,
      camera_label TEXT,
      video_width INTEGER,
      video_height INTEGER,
      aspect_ratio REAL,
      actual_fps REAL,
      zoom_supported INTEGER,
      zoom_min REAL,
      zoom_max REAL,
      zoom_step REAL,
      focus_mode_supported INTEGER,
      available_focus_modes TEXT,
      focus_distance_supported INTEGER,
      torch_supported INTEGER,
      exposure_supported INTEGER,
      cpu_cores INTEGER,
      device_memory_gb REAL,
      gpu_renderer TEXT,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES diagnostic_sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS diagnostic_scan_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      barcode TEXT NOT NULL,
      device_id TEXT,
      format TEXT,
      device_os TEXT,
      browser TEXT,
      video_width INTEGER,
      video_height INTEGER,
      time_since_start_ms INTEGER,
      time_since_prev_scan_ms INTEGER,
      decode_attempts_since_prev INTEGER,
      bbox_width INTEGER,
      bbox_height INTEGER,
      bbox_center_x INTEGER,
      bbox_center_y INTEGER,
      bbox_pct_w REAL,
      bbox_pct_h REAL,
      FOREIGN KEY (session_id) REFERENCES diagnostic_sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS diagnostic_events_and_aggregates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      device_id TEXT,
      device_id_hash TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      event_type TEXT NOT NULL,
      classification TEXT,
      error_message TEXT,
      decode_attempts INTEGER,
      successful_decodes INTEGER,
      failed_attempts INTEGER,
      avg_fps REAL,
      duration_sec INTEGER,
      cpu_cores INTEGER,
      device_memory_gb REAL,
      gpu_renderer TEXT,
      tab_visible INTEGER,
      nudge_var_before REAL,
      nudge_var_after REAL,
      nudge_decode_success INTEGER,
      FOREIGN KEY (session_id) REFERENCES diagnostic_sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
    CREATE INDEX IF NOT EXISTS idx_scan_events_scanned_at ON scan_events(scanned_at);
    CREATE INDEX IF NOT EXISTS idx_scan_events_barcode ON scan_events(barcode);
    CREATE INDEX IF NOT EXISTS idx_scan_events_product_id ON scan_events(product_id);
    CREATE INDEX IF NOT EXISTS idx_diag_sessions_status ON diagnostic_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_diag_scan_events_session ON diagnostic_scan_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_diag_device_telemetry_session ON diagnostic_device_telemetry(session_id);
    CREATE INDEX IF NOT EXISTS idx_diag_events_aggregates_session ON diagnostic_events_and_aggregates(session_id);
    CREATE INDEX IF NOT EXISTS idx_device_registry_first_seen_session ON device_registry(first_seen_session_id);
    CREATE INDEX IF NOT EXISTS idx_device_registry_first_seen ON device_registry(first_seen_at);
    CREATE INDEX IF NOT EXISTS idx_device_registry_last_seen ON device_registry(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_device_registry_os ON device_registry(device_os);
  `);

  try { await db.exec(`ALTER TABLE device_registry ADD COLUMN cpu_cores INTEGER;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE device_registry ADD COLUMN device_memory_gb REAL;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE device_registry ADD COLUMN gpu_renderer TEXT;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE device_registry ADD COLUMN focus_mode_supported INTEGER;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE device_registry ADD COLUMN available_focus_modes TEXT;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE device_registry ADD COLUMN focus_distance_supported INTEGER;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE device_registry ADD COLUMN zoom_supported INTEGER;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE device_registry ADD COLUMN zoom_min REAL;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE device_registry ADD COLUMN zoom_max REAL;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE device_registry ADD COLUMN zoom_step REAL;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE device_registry ADD COLUMN torch_supported INTEGER;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE device_registry ADD COLUMN exposure_supported INTEGER;`); } catch (e) {}

  try { await db.exec(`ALTER TABLE diagnostic_device_telemetry ADD COLUMN device_id TEXT;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE diagnostic_device_telemetry ADD COLUMN cpu_cores INTEGER;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE diagnostic_device_telemetry ADD COLUMN device_memory_gb REAL;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE diagnostic_device_telemetry ADD COLUMN gpu_renderer TEXT;`); } catch (e) {}

  try { await db.exec(`ALTER TABLE diagnostic_scan_events ADD COLUMN device_id TEXT;`); } catch (e) {}

  try { await db.exec(`ALTER TABLE diagnostic_events_and_aggregates ADD COLUMN device_id TEXT;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE diagnostic_events_and_aggregates ADD COLUMN device_id_hash TEXT;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE diagnostic_events_and_aggregates ADD COLUMN cpu_cores INTEGER;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE diagnostic_events_and_aggregates ADD COLUMN device_memory_gb REAL;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE diagnostic_events_and_aggregates ADD COLUMN gpu_renderer TEXT;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE diagnostic_events_and_aggregates ADD COLUMN tab_visible INTEGER;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE diagnostic_events_and_aggregates ADD COLUMN nudge_var_before REAL;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE diagnostic_events_and_aggregates ADD COLUMN nudge_var_after REAL;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE diagnostic_events_and_aggregates ADD COLUMN nudge_decode_success INTEGER;`); } catch (e) {}

  // Initialize setup status setting if not present
  const setupSetting = await db.get(
    'SELECT value FROM system_settings WHERE key = ?',
    'setup_completed'
  );

  if (!setupSetting) {
    await db.run(
      'INSERT INTO system_settings (key, value) VALUES (?, ?)',
      'setup_completed',
      '0'
    );
  }

  if (seedData) {
    await seedSampleData(db);
    // Dynamic import to avoid circular dependency
    const { refreshHotDeals } = require('./services/hotDealsService');
    await refreshHotDeals(db);
  }
}

async function seedSampleData(db: Database): Promise<void> {
  const sampleProducts = [
    {
      barcode: '7800000000014',
      name: 'Fresh Whole Milk 1L',
      sale_price: 2.49,
      mrp: 2.49,
    },
    {
      barcode: '7800000000021',
      name: 'Artisanal White Bread 500g',
      sale_price: 1.89,
      mrp: 2.20,
    },
    {
      barcode: '7800000000038',
      name: 'Organic Red Apples 1kg',
      sale_price: 3.99,
      mrp: 3.99,
    },
    {
      barcode: '7800000000045',
      name: 'Sparkling Soda Cola 330ml',
      sale_price: 0.99,
      mrp: 1.25,
    },
    {
      barcode: '7800000000052',
      name: 'Chocolate Chip Cookies 200g',
      sale_price: 2.75,
      mrp: 3.49,
    },
  ];

  await db.run('BEGIN TRANSACTION');
  try {

    for (const p of sampleProducts) {
      const discountPercent = p.mrp > 0 ? Math.round(((p.mrp - p.sale_price) / p.mrp) * 100 * 10) / 10 : 0.0;
      await db.run(
        `INSERT INTO products 
         (barcode, name, sale_price, mrp, discount_percent, updated_at) 
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        p.barcode,
        p.name,
        p.sale_price,
        p.mrp,
        discountPercent
      );
    }

    await db.run(
      'INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)',
      'setup_completed',
      '1'
    );

    await db.run(
      'INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)',
      'last_setup_date',
      new Date().toISOString()
    );

    await db.run('COMMIT');
  } catch (error) {
    await db.run('ROLLBACK');
    throw error;
  }
}
