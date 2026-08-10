import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { recordScanEvent, getPublicOverallCount } from '../services/analyticsService';

const router = Router();

// GET /api/analytics/overall - Public endpoint returning overall successful scan count
router.get('/analytics/overall', async (req: Request, res: Response): Promise<void> => {
  try {
    const data = await getPublicOverallCount();
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ overall: 0 });
  }
});

// GET /api/products/lookup/:barcode - Public lookup for products
router.get('/products/lookup/:barcode', async (req: Request, res: Response): Promise<void> => {
  try {
    const { barcode } = req.params;

    if (!barcode || barcode.trim().length === 0) {
      res.status(400).json({
        success: false,
        message: 'Barcode parameter is required.',
      });
      return;
    }

    const trimmedBarcode = barcode.trim();
    const barcodeWithZero = trimmedBarcode + '0';

    const db = await getDb();

    // Query database for both exact match and match with one trailing zero appended.
    // Utilizes index on barcode for high-performance lookup (< 1 second).
    const products = await db.all(
      `SELECT id, barcode, name, mrp, sale_price as salePrice, wholesale_price as wholesalePrice, wholesale_qty as wholesaleQty 
       FROM products 
       WHERE barcode = ? OR barcode = ?`,
      trimmedBarcode,
      barcodeWithZero
    );

    if (!products || products.length === 0) {
      // Record failed/no-product-found lookup event asynchronously
      recordScanEvent(trimmedBarcode, 0, null).catch(err => {
        console.error('[Analytics Error] Record scan failure:', err);
      });

      // Adhering to Article VII (Price Integrity): Clear message when product not found
      res.status(404).json({
        success: false,
        message: 'Product is unavailable or not found',
      });
      return;
    }

    // Deduplicate products based on barcode
    const uniqueProductsMap = new Map<string, any>();
    for (const prod of products) {
      uniqueProductsMap.set(prod.barcode, prod);
    }
    const combinedResults = Array.from(uniqueProductsMap.values());

    // Sort results by MRP in ascending order
    combinedResults.sort((a, b) => a.mrp - b.mrp);

    // Record successful lookup event asynchronously
    const matchedProductId = combinedResults[0]?.id || null;
    recordScanEvent(trimmedBarcode, 1, matchedProductId).catch(err => {
      console.error('[Analytics Error] Record scan success:', err);
    });

    res.json({
      multipleMatches: combinedResults.length > 1,
      products: combinedResults
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to process barcode lookup',
      error: error.message || error,
    });
  }
});

// GET /api/products/search - Autocomplete product suggestions
router.get('/products/search', async (req: Request, res: Response): Promise<void> => {
  try {
    const { q } = req.query;

    if (!q || typeof q !== 'string' || q.trim().length === 0) {
      res.status(400).json({
        success: false,
        message: 'Search query parameter "q" is required.',
      });
      return;
    }

    const query = q.trim();
    const db = await getDb();

    // Query name or barcode with prefix mapping, utilizing indices for sub-second speeds.
    const matches = await db.all(
      `SELECT barcode, name, sale_price as salePrice, mrp 
       FROM products 
       WHERE name LIKE ? OR barcode LIKE ? 
       ORDER BY name ASC 
       LIMIT 10`,
      `%${query}%`,
      `${query}%`
    );

    res.json(matches);
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Search autocomplete query failed',
      error: error.message || error,
    });
  }
});

// GET /api/products/hot-deals - Fetch precomputed top 20 hot deals (joined query)
router.get('/products/hot-deals', async (req: Request, res: Response): Promise<void> => {
  try {
    const db = await getDb();
    const deals = await db.all(
      `SELECT p.barcode, p.name, p.mrp, p.sale_price as salePrice, p.discount_percent as discountPercent,
              ((0.55 * p.discount_percent) + (0.30 * (p.mrp - p.sale_price)) + (0.15 * LOG(p.mrp + 1))) as offerScore
       FROM hot_deals hd
       JOIN products p ON hd.product_id = p.id
       ORDER BY hd.position ASC`
    );
    const today = new Date();
    const seed = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    res.json({
      success: true,
      generatedAt: today.toISOString(),
      seed: seed,
      products: deals
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve hot deals',
      error: error.message || error
    });
  }
});

export default router;
