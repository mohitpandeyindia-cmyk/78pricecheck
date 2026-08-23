import { getDb } from '../db';

export async function recordScanEvent(
  barcode: string,
  productFound: number,
  productId: number | null
): Promise<void> {
  try {
    const db = await getDb();
    const scannedAt = new Date().toISOString();
    await db.run(
      `INSERT INTO scan_events (barcode, product_found, product_id, scanned_at) 
       VALUES (?, ?, ?, ?)`,
      barcode,
      productFound,
      productId,
      scannedAt
    );
  } catch (error: any) {
    // Fail-safe: Analytics failure must never disrupt product lookup response
    console.error('[Analytics Error] Failed to record scan event:', error?.message || error);
  }
}

export async function getPublicOverallCount(): Promise<{ overall: number }> {
  try {
    const db = await getDb();
    const row = await db.get(
      `SELECT COUNT(id) as count FROM scan_events WHERE product_found = 1`
    );
    return { overall: row ? Number(row.count) : 0 };
  } catch (error: any) {
    console.error('[Analytics Error] Failed to get public overall count:', error?.message || error);
    return { overall: 0 };
  }
}

export async function getAdminAnalytics(daysLimit: number = 7): Promise<any> {
  const db = await getDb();

  // Primary Metrics
  const todayRow = await db.get(
    `SELECT COUNT(id) as count FROM scan_events 
     WHERE product_found = 1 
     AND date(scanned_at, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes')`
  );

  const monthRow = await db.get(
    `SELECT COUNT(id) as count FROM scan_events 
     WHERE product_found = 1 
     AND strftime('%Y-%m', scanned_at, '+5 hours', '+30 minutes') = strftime('%Y-%m', 'now', '+5 hours', '+30 minutes')`
  );

  const overallRow = await db.get(
    `SELECT COUNT(id) as count FROM scan_events WHERE product_found = 1`
  );

  const notFoundRow = await db.get(
    `SELECT COUNT(id) as count FROM scan_events WHERE product_found = 0`
  );

  // Activity by Day (Last 7 or 30 days) - Successful scans only
  const safeDays = daysLimit === 30 ? 30 : 7;
  const activityRows = await db.all(
    `SELECT date(scanned_at, '+5 hours', '+30 minutes') as scan_date, 
            COUNT(id) as count 
     FROM scan_events 
     WHERE product_found = 1 
     AND date(scanned_at, '+5 hours', '+30 minutes') >= date('now', '+5 hours', '+30 minutes', ? || ' days')
     GROUP BY scan_date 
     ORDER BY scan_date ASC`,
    `-${safeDays - 1}`
  );

  // Peak Scanning Hours (00:00 to 23:00 in India local time) - Successful scans only
  const peakRows = await db.all(
    `SELECT CAST(strftime('%H', scanned_at, '+5 hours', '+30 minutes') AS INTEGER) as hour, 
            COUNT(id) as count 
     FROM scan_events 
     WHERE product_found = 1 
     GROUP BY hour 
     ORDER BY hour ASC`
  );

  // Top 10 Most Scanned Products (Successful lookups)
  const topProductsRows = await db.all(
    `SELECT p.id, p.name, p.barcode, COUNT(s.id) as scanCount 
     FROM scan_events s 
     JOIN products p ON s.product_id = p.id 
     WHERE s.product_found = 1 
     GROUP BY s.product_id 
     ORDER BY scanCount DESC 
     LIMIT 10`
  );

  // Top No Product Found Unknown Barcodes
  const unknownBarcodesRows = await db.all(
    `SELECT barcode, COUNT(id) as attempts 
     FROM scan_events 
     WHERE product_found = 0 
     GROUP BY barcode 
     ORDER BY attempts DESC 
     LIMIT 10`
  );

  return {
    today: todayRow ? Number(todayRow.count) : 0,
    month: monthRow ? Number(monthRow.count) : 0,
    overall: overallRow ? Number(overallRow.count) : 0,
    notFound: notFoundRow ? Number(notFoundRow.count) : 0,
    activityDays: safeDays,
    dailyActivity: activityRows.map(r => ({ date: r.scan_date, count: Number(r.count) })),
    peakHours: peakRows.map(r => ({ hour: Number(r.hour), count: Number(r.count) })),
    topProducts: topProductsRows.map(r => ({ id: r.id, name: r.name, barcode: r.barcode, scanCount: Number(r.scanCount) })),
    unknownBarcodes: unknownBarcodesRows.map(r => ({ barcode: r.barcode, attempts: Number(r.attempts) }))
  };
}

export async function getDeviceAnalytics(period: string = 'today'): Promise<any> {
  const db = await getDb();

  const validPeriod = ['today', 'week', 'month', 'all'].includes(period) ? period : 'today';

  let dateWhereClause = "";
  if (validPeriod === 'today') {
    dateWhereClause = "date(first_seen_at, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes')";
  } else if (validPeriod === 'week') {
    dateWhereClause = "date(first_seen_at, '+5 hours', '+30 minutes') >= date('now', '+5 hours', '+30 minutes', '-6 days')";
  } else if (validPeriod === 'month') {
    dateWhereClause = "strftime('%Y-%m', first_seen_at, '+5 hours', '+30 minutes') = strftime('%Y-%m', 'now', '+5 hours', '+30 minutes')";
  } else {
    dateWhereClause = "1=1";
  }

  // 1. New Devices in selected period
  const newRow = await db.get(
    `SELECT COUNT(*) as count FROM device_registry WHERE device_id IS NOT NULL AND device_id != 'unknown' AND ${dateWhereClause}`
  );
  const newDevices = newRow ? Number(newRow.count) : 0;

  // 2. OS Breakdown for New Devices in selected period
  const newIosRow = await db.get(
    `SELECT COUNT(*) as count FROM device_registry WHERE device_id IS NOT NULL AND device_id != 'unknown' AND device_os = 'iOS' AND ${dateWhereClause}`
  );
  const newAndroidRow = await db.get(
    `SELECT COUNT(*) as count FROM device_registry WHERE device_id IS NOT NULL AND device_id != 'unknown' AND device_os = 'Android' AND ${dateWhereClause}`
  );
  const newOtherRow = await db.get(
    `SELECT COUNT(*) as count FROM device_registry WHERE device_id IS NOT NULL AND device_id != 'unknown' AND (device_os NOT IN ('iOS', 'Android') OR device_os IS NULL) AND ${dateWhereClause}`
  );

  // 3. Total Unique Devices Ever
  const totalRow = await db.get(
    `SELECT COUNT(*) as count FROM device_registry WHERE device_id IS NOT NULL AND device_id != 'unknown'`
  );
  const totalUniqueDevices = totalRow ? Number(totalRow.count) : 0;

  // 4. Returning Devices in selected period
  let returningClause = "";
  if (validPeriod === 'today') {
    returningClause = "date(first_seen_at, '+5 hours', '+30 minutes') < date('now', '+5 hours', '+30 minutes') AND date(last_seen_at, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes')";
  } else if (validPeriod === 'week') {
    returningClause = "date(first_seen_at, '+5 hours', '+30 minutes') < date('now', '+5 hours', '+30 minutes', '-6 days') AND date(last_seen_at, '+5 hours', '+30 minutes') >= date('now', '+5 hours', '+30 minutes', '-6 days')";
  } else if (validPeriod === 'month') {
    returningClause = "strftime('%Y-%m', first_seen_at, '+5 hours', '+30 minutes') < strftime('%Y-%m', 'now', '+5 hours', '+30 minutes') AND strftime('%Y-%m', last_seen_at, '+5 hours', '+30 minutes') = strftime('%Y-%m', 'now', '+5 hours', '+30 minutes')";
  } else {
    returningClause = "date(last_seen_at, '+5 hours', '+30 minutes') > date(first_seen_at, '+5 hours', '+30 minutes') OR strftime('%Y-%m-%d %H:%M', last_seen_at) > strftime('%Y-%m-%d %H:%M', first_seen_at)";
  }

  const returningRow = await db.get(
    `SELECT COUNT(*) as count FROM device_registry WHERE device_id IS NOT NULL AND device_id != 'unknown' AND ${returningClause}`
  );
  const returningDevices = returningRow ? Number(returningRow.count) : 0;

  // Summary counts for Today, Week, Month
  const newTodayRow = await db.get(
    `SELECT COUNT(*) as count FROM device_registry WHERE device_id IS NOT NULL AND device_id != 'unknown' AND date(first_seen_at, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes')`
  );
  const newWeekRow = await db.get(
    `SELECT COUNT(*) as count FROM device_registry WHERE device_id IS NOT NULL AND device_id != 'unknown' AND date(first_seen_at, '+5 hours', '+30 minutes') >= date('now', '+5 hours', '+30 minutes', '-6 days')`
  );
  const newMonthRow = await db.get(
    `SELECT COUNT(*) as count FROM device_registry WHERE device_id IS NOT NULL AND device_id != 'unknown' AND strftime('%Y-%m', first_seen_at, '+5 hours', '+30 minutes') = strftime('%Y-%m', 'now', '+5 hours', '+30 minutes')`
  );

  return {
    period: validPeriod,
    newDevices,
    totalUniqueDevices,
    returningDevices,
    newIosDevices: newIosRow ? Number(newIosRow.count) : 0,
    newAndroidDevices: newAndroidRow ? Number(newAndroidRow.count) : 0,
    newOtherDevices: newOtherRow ? Number(newOtherRow.count) : 0,
    summary: {
      today: newTodayRow ? Number(newTodayRow.count) : 0,
      week: newWeekRow ? Number(newWeekRow.count) : 0,
      month: newMonthRow ? Number(newMonthRow.count) : 0,
      total: totalUniqueDevices
    }
  };
}
