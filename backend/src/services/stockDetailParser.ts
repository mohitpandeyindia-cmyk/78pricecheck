import * as XLSX from 'xlsx';
import { normalizeProductName } from '../db';

export interface StockDetailParseResult {
  namedRowCount: number;
  uniqueNames: Set<string>;
  duplicateNameCount: number;
  closingQtys: Map<string, number>;
}

/**
 * Parses a Vyapar Stock Detail Report workbook (.xls legacy or .xlsx modern).
 * Performs robust header detection by locating the 'Item Name' header.
 * Ignores empty rows, separator rows, and summary/footer rows.
 * Collects a unique set of normalized item names for exact active product reconciliation.
 */
export function parseStockDetailBuffer(buffer: Buffer): StockDetailParseResult {
  if (!buffer || buffer.length === 0) {
    throw new Error('Stock Detail Report buffer is empty.');
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (err: any) {
    throw new Error(`Invalid Excel file format for Stock Detail Report: ${err.message || err}`);
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error('Stock Detail Report contains no sheets.');
  }

  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) {
    throw new Error('Stock Detail Report worksheet could not be read.');
  }

  const rows: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

  if (rows.length === 0) {
    throw new Error('Stock Detail Report sheet is empty.');
  }

  let headerRowIndex = -1;
  let itemNameCol = -1;
  let slNoCol = -1;
  let closingQtyCol = -1;

  // Scan first 50 rows to detect the header row containing 'Item Name'
  for (let r = 0; r < Math.min(50, rows.length); r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const cellVal = String(row[c] || '').trim().toLowerCase();
      if (cellVal === 'item name' || cellVal === 'item name*' || cellVal === 'item_name' || cellVal === 'product name') {
        headerRowIndex = r;
        itemNameCol = c;
      } else if (
        cellVal === 'sl no.' || cellVal === 'sl no' || cellVal === 'sl.no' ||
        cellVal === 'sl. no.' || cellVal === 'slno' || cellVal === 's.no' || cellVal === 'sr no'
      ) {
        slNoCol = c;
      } else if (
        cellVal === 'closing quantity' || cellVal === 'closing qty' ||
        cellVal === 'closing_quantity' || cellVal === 'closing stock' || cellVal === 'closing balance'
      ) {
        closingQtyCol = c;
      }
    }
    if (itemNameCol !== -1) break;
  }

  if (itemNameCol === -1) {
    throw new Error('Header mismatch: Stock Detail Report must contain an "Item Name" column.');
  }

  const uniqueNames = new Set<string>();
  let namedRowCount = 0;
  let duplicateNameCount = 0;
  const closingQtys = new Map<string, number>();

  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0 || row.every((c: any) => c === null || c === undefined || String(c).trim() === '')) {
      continue;
    }

    const rawName = row[itemNameCol];
    if (rawName === undefined || rawName === null || String(rawName).trim() === '') {
      continue;
    }

    const normName = normalizeProductName(rawName);
    if (!normName) continue;

    // Filter out summary/footer rows (e.g. 'Total', 'Grand Total')
    if (normName === 'TOTAL' || normName === 'GRAND TOTAL' || normName === 'TOTALS' || normName.startsWith('TOTAL ')) {
      const slNo = slNoCol !== -1 ? row[slNoCol] : null;
      if (!slNo || isNaN(Number(slNo))) {
        // This is a footer summary row without a valid item serial number
        continue;
      }
    }

    namedRowCount++;
    if (uniqueNames.has(normName)) {
      duplicateNameCount++;
    } else {
      uniqueNames.add(normName);
    }

    if (closingQtyCol !== -1) {
      const rawClosing = row[closingQtyCol];
      const parsedQty = (rawClosing !== undefined && rawClosing !== null && !isNaN(Number(rawClosing))) ? Number(rawClosing) : 0;
      closingQtys.set(normName, parsedQty);
    }
  }

  if (namedRowCount === 0 || uniqueNames.size === 0) {
    throw new Error('Stock Detail Report contains no valid product rows beneath the header.');
  }

  return {
    namedRowCount,
    uniqueNames,
    duplicateNameCount,
    closingQtys
  };
}
