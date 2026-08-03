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
/**
 * Simple Mulberry32 seeded pseudo-random number generator for daily deterministic shuffle.
 */
function seededRandom(seed: number) {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Regenerates the precomputed Hot Deals list transactionally.
 * Selection Algorithm (V2):
 *  1. Filter active products with discountPercent >= 15% AND salePrice > 0.
 *  2. Calculate Offer Score: Score = 0.45 * discountPercent + 0.35 * (mrp - salePrice) + 0.20 * mrp.
 *  3. Take Top 60 highest offer scores.
 *  4. Apply seeded daily shuffle using YYYYMMDD date seed.
 */
export async function refreshHotDeals(db: Database): Promise<void> {
  await db.run('BEGIN TRANSACTION');
  try {
    await db.run('DELETE FROM hot_deals');

    // 1. Fetch products meeting minimum offer criteria
    const rawProducts = await db.all(`
      SELECT id, mrp, sale_price as salePrice, discount_percent as discountPercent
      FROM products 
      WHERE discount_percent >= 15 AND sale_price > 0
    `);

    // 2. Calculate weighted offer score
    const scoredProducts = rawProducts.map(p => {
      const savings = p.mrp - p.salePrice;
      const offerScore = (0.45 * p.discountPercent) + (0.35 * savings) + (0.20 * p.mrp);
      return { id: p.id, offerScore };
    });

    // 3. Take Top 60 scores
    scoredProducts.sort((a, b) => b.offerScore - a.offerScore);
    const top60 = scoredProducts.slice(0, 60);

    // 4. Seeded Daily Shuffle (YYYYMMDD)
    const today = new Date();
    const dateSeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();

    let currentSeed = dateSeed;
    for (let i = top60.length - 1; i > 0; i--) {
      const rand = seededRandom(currentSeed++);
      const j = Math.floor(rand * (i + 1));
      const temp = top60[i];
      top60[i] = top60[j];
      top60[j] = temp;
    }

    // 5. Insert into hot_deals table
    const insertStmt = await db.prepare(
      `INSERT INTO hot_deals (product_id, position) VALUES (?, ?)`
    );

    for (let index = 0; index < top60.length; index++) {
      await insertStmt.run(top60[index].id, index + 1);
    }

    await insertStmt.finalize();
    await db.run('COMMIT');
    console.log(`[HotDealsService] Successfully calculated V2 scores and daily shuffled ${top60.length} hot deals.`);
  } catch (error) {
    await db.run('ROLLBACK');
    console.error('[HotDealsService] Failed to refresh hot deals, transaction rolled back:', error);
    throw error;
  }
}
