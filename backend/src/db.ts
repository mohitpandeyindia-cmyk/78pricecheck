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

  // Enable foreign keys
  await dbInstance.run('PRAGMA foreign_keys = ON');

  return dbInstance;
}

export async function initializeDatabase(seedData = false): Promise<void> {
  const db = await getDb();

  // Drop old tables to apply schema updates
  await db.exec('DROP TABLE IF EXISTS products;');
  await db.exec('DROP TABLE IF EXISTS upload_history;');

  // Create tables
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
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
  `);

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
      await db.run(
        `INSERT INTO products 
         (barcode, name, sale_price, mrp, updated_at) 
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        p.barcode,
        p.name,
        p.sale_price,
        p.mrp
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
