import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import fs from 'fs';
import path from 'path';

const router = Router();

// Authoritative version loaded dynamically from package.json
let packageVersion = '0.1.0';
try {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')
  );
  packageVersion = packageJson.version || '0.1.0';
} catch (e) {
  // Suppress trace logs
}

// GET /api/version - Returns application and system versions
router.get('/version', async (req: Request, res: Response): Promise<void> => {
  try {
    const db = await getDb();
    const lastUpload = await db.get(
      `SELECT id, uploaded_at 
       FROM upload_history 
       WHERE status = 'Success' 
       ORDER BY id DESC LIMIT 1`
    );

    let catalogVersion = 'empty';
    let lastCatalogUpload: string | null = null;

    if (lastUpload) {
      // SQLite default format: YYYY-MM-DD HH:MM:SS
      const datePart = lastUpload.uploaded_at.split(' ')[0].replace(/-/g, ''); // YYYYMMDD
      const sequence = String(lastUpload.id).padStart(3, '0');
      catalogVersion = `${datePart}-${sequence}`;
      
      // Convert SQLite UTC date to ISO string
      lastCatalogUpload = new Date(lastUpload.uploaded_at + ' UTC').toISOString();
    }

    const countRow = await db.get('SELECT COUNT(*) as count FROM products');
    const productsCount = countRow ? countRow.count : 0;

    res.json({
      application: '78 PriceCheck',
      version: packageVersion,
      databaseVersion: '3',
      catalogVersion,
      lastCatalogUpload,
      productsCount
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve version info',
      error: error.message || error
    });
  }
});

export default router;
