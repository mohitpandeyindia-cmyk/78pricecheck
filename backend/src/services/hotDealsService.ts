import { Database } from 'sqlite';

/**
 * This service determines promotional product collections based on configurable business rules.
 * Future promotional collections (Seasonal Deals, Festival Offers, Manager Picks, etc.) should be implemented here.
 */

/**
 * Regenerates the precomputed Hot Deals list transactionally.
 * Selection Algorithm:
 *  1. Sort catalogue by Discount Percentage (descending), then Absolute Savings (descending), and take the Top 300 products.
 *  2. From those 300, filter/sort by MRP (highest first) and take the Top 50 products.
 *  3. Shuffles the 50 selected products in memory once per upload to randomize sequence exposure.
 *
 * Positions are stored using a 1-based convention (1 to 50).
 */
export async function refreshHotDeals(db: Database): Promise<void> {
  // Execute the entire cache refresh within a single atomic database transaction
  await db.run('BEGIN TRANSACTION');
  try {
    // 1. Clear existing cached Hot Deals
    await db.run('DELETE FROM hot_deals');

    // 2. Fetch the top 300 ranked deals by discount percentage and savings
    const pool300 = await db.all(`
      SELECT id, mrp, discount_percent as discountPercent
      FROM products 
      ORDER BY discount_percent DESC, (mrp - sale_price) DESC, name ASC, barcode ASC 
      LIMIT 300
    `);

    // 3. Sort those 300 by MRP (highest first), tie-breaker by discount percent, and take the Top 50
    const top50 = pool300
      .sort((a, b) => {
        if (b.mrp !== a.mrp) {
          return b.mrp - a.mrp;
        }
        if (b.discountPercent !== a.discountPercent) {
          return b.discountPercent - a.discountPercent;
        }
        return a.id - b.id;
      })
      .slice(0, 50);

    // 4. Shuffling the 50 selected products in memory once (Fisher-Yates Shuffle)
    for (let i = top50.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = top50[i];
      top50[i] = top50[j];
      top50[j] = temp;
    }

    // 5. Insert ranked references into the precomputed cache table with 1-based position numbers
    const insertStmt = await db.prepare(
      `INSERT INTO hot_deals (product_id, position) VALUES (?, ?)`
    );

    for (let index = 0; index < top50.length; index++) {
      const position = index + 1; // 1-based ranking position (1-50)
      await insertStmt.run(top50[index].id, position);
    }

    await insertStmt.finalize();
    await db.run('COMMIT');
    console.log(`[HotDealsService] Successfully refreshed and globally shuffled ${top50.length} hot deals.`);
  } catch (error) {
    await db.run('ROLLBACK');
    console.error('[HotDealsService] Failed to refresh hot deals, transaction rolled back:', error);
    throw error;
  }
}
