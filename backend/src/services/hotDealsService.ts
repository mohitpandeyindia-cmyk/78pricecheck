import { Database } from 'sqlite';

/**
 * This service determines promotional product collections based on configurable business rules.
 * Future promotional collections (Seasonal Deals, Festival Offers, Manager Picks, etc.) should be implemented here.
 */

/**
 * Regenerates the precomputed Top 20 Hot Deals list transactionally.
 * Ranking Criteria:
 *  1. Highest Discount Percentage (discount_percent DESC)
 *  2. Highest Absolute Savings (mrp - sale_price DESC)
 *  3. Product Name Alphabetically (name ASC)
 *  4. Product Barcode Fallback (barcode ASC)
 *
 * Positions are stored using a 1-based convention (1 to 20).
 */
export async function refreshHotDeals(db: Database): Promise<void> {
  // Execute the entire cache refresh within a single atomic database transaction
  await db.run('BEGIN TRANSACTION');
  try {
    // 1. Clear existing cached Hot Deals
    await db.run('DELETE FROM hot_deals');

    // 2. Fetch the top 20 ranked deals based on the promotional algorithm
    const topDeals = await db.all(`
      SELECT barcode 
      FROM products 
      ORDER BY discount_percent DESC, (mrp - sale_price) DESC, name ASC, barcode ASC 
      LIMIT 20
    `);

    // 3. Insert ranked references into the precomputed cache table with 1-based position numbers
    const insertStmt = await db.prepare(
      `INSERT INTO hot_deals (barcode, position) VALUES (?, ?)`
    );

    for (let index = 0; index < topDeals.length; index++) {
      const position = index + 1; // 1-based ranking position (1-20)
      await insertStmt.run(topDeals[index].barcode, position);
    }

    await insertStmt.finalize();
    await db.run('COMMIT');
    console.log(`[HotDealsService] Successfully refreshed ${topDeals.length} hot deals.`);
  } catch (error) {
    await db.run('ROLLBACK');
    console.error('[HotDealsService] Failed to refresh hot deals, transaction rolled back:', error);
    throw error;
  }
}
