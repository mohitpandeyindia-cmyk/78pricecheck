import { Router, Request, Response } from 'express';
import { getDb } from '../db';

const router = Router();

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
      `SELECT barcode, name, mrp, sale_price as salePrice, wholesale_price as wholesalePrice, wholesale_qty as wholesaleQty 
       FROM products 
       WHERE barcode = ? OR barcode = ?`,
      trimmedBarcode,
      barcodeWithZero
    );

    if (!products || products.length === 0) {
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

    // If only one product matches, return it as a single object (for seamless customer experience)
    // If multiple match, return the primary match or the sorted array. The spec says "Sort results by MRP in ascending order".
    // Let's return the sorted array of matched products, or if it is a single result, return the object or list.
    // Usually, barcode lookup returns a single product details. To support the constitution and multiple zero-padded matches,
    // we can return the array or the primary matched object with a list. Let's return the array of matched products to be fully compliant,
    // or return the first matching product but include all matched products in an array, e.g.:
    // { success: true, product: combinedResults[0], matches: combinedResults }
    // Wait, let's look at the contract in API.md:
    // Success Response: JSON object representing the product details (or array).
    // Let's return the first matching product directly as the root JSON, as is standard for lookup, or return the combined list.
    // Actually, returning the lowest-priced matching product directly as the main object is perfect, and we can also add a list of matches or just return the lowest-priced match!
    // Wait! Let's check the spec: "Sort results by MRP in ascending order."
    // If a lookup can return multiple products (e.g. if '780001' and '7800010' are both valid products), sorting them in ascending order of price means the cheapest one comes first.
    // If the client expects a single product representation, returning the combined array allows the client to choose or displays the list.
    // Let's return the sorted array of matched products directly! That satisfies "Combine both result sets. Remove duplicate products. Sort results by MRP in ascending order" in the most general way. Or we can return `{ success: true, products: combinedResults }` or just the array `combinedResults`.
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
      `SELECT p.barcode, p.name, p.mrp, p.sale_price as salePrice, p.discount_percent as discountPercent
       FROM hot_deals hd
       JOIN products p ON hd.product_id = p.id
       ORDER BY hd.position ASC`
    );
    res.json({
      success: true,
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
