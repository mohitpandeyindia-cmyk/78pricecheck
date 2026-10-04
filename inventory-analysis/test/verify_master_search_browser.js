const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');

const CDP_PORT = 9338;
const BASE_URL = 'http://localhost:8080';

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (err) => reject(err);
      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.id && this.pending.has(data.id)) {
            const { resolve, reject } = this.pending.get(data.id);
            this.pending.delete(data.id);
            if (data.error) reject(new Error(data.error.message));
            else resolve(data.result);
          }
        } catch (e) {
          console.error(e);
        }
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result?.value;
  }

  async captureScreenshot(filePath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(filePath, Buffer.from(res.data, 'base64'));
    return filePath;
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function testBrowserMasterSearch() {
  console.log('================================================================');
  console.log('  HEADLESS BROWSER VERIFICATION: COVERAGE & RELEVANCE RANKING    ');
  console.log('================================================================\n');

  const jwt = require('c:/seventyeightos/backend/node_modules/jsonwebtoken');
  const token = jwt.sign({ id: 1, username: 'admin' }, 'localtestsecretkey12345', { expiresIn: '2h' });

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const userDataDir = 'C:\\Users\\Admin\\AppData\\Local\\Temp\\chrome_master_search_rank_test';
  const chromeProc = cp.spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=' + CDP_PORT,
    '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + userDataDir,
    '--disable-gpu',
    '--no-sandbox',
    'about:blank'
  ]);

  let targetsRes = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      targetsRes = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list');
      if (targetsRes.ok) break;
    } catch (e) {
      // Chrome still starting up
    }
  }
  if (!targetsRes || !targetsRes.ok) {
    throw new Error('Failed to connect to Chrome on port ' + CDP_PORT);
  }
  const targets = await targetsRes.json();
  const pageTarget = targets.find(t => t.type === 'page') || targets[0];
  const client = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await client.connect();

  await client.send('Page.enable');
  await client.send('Runtime.enable');

  await client.send('Page.navigate', { url: BASE_URL + '/admin/inventory' });
  await new Promise(r => setTimeout(r, 1000));
  await client.evaluate(`
    localStorage.setItem('admin_token', ${JSON.stringify(token)});
    localStorage.setItem('admin_username', 'admin');
  `);
  await client.send('Page.navigate', { url: BASE_URL + '/admin/inventory' });
  await new Promise(r => setTimeout(r, 1500));

  // Inject dataset containing GM brand items, dead stock items, and ... 500 GM items
  await client.evaluate(`
    (() => {
      window.__analysisData = {
        config: { leadTimeDays: 3, reviewFrequencyDays: 7, orderCoverageDays: 15, serviceLevel: 0.95, watchThresholdFactor: 1.25 },
        summary: { totalItems: 7, buyNowCount: 2, watchCount: 1, okCount: 1, reviewCount: 3 },
        suggestions: [
          {
            itemName: 'HIMA PURI NEEM FW',
            itemCode: '8901234567890',
            mrp: 140,
            classification: 'BUY_NOW',
            urgency: 'HIGH',
            currentStock: 4,
            daysOfCover: 2,
            effectiveDailyDemand: 2.0,
            suggestedOrderQty: 26,
            reason: 'Reorder required'
          },
          {
            itemName: 'GM MUSTARD OIL 1 LTR',
            itemCode: '8908004643001',
            mrp: 175,
            classification: 'BUY_NOW',
            urgency: 'HIGH',
            currentStock: 5,
            daysOfCover: 2.5,
            effectiveDailyDemand: 2.0,
            suggestedOrderQty: 25,
            reason: 'Reorder required'
          },
          {
            itemName: '24M BANYARD MILLET 500 GM',
            itemCode: '8904083516460',
            mrp: 150,
            classification: 'OK',
            urgency: null,
            currentStock: 30,
            daysOfCover: 15,
            effectiveDailyDemand: 2.0,
            suggestedOrderQty: 0,
            reason: 'Stock healthy'
          },
          {
            itemName: 'ABC GM OIL',
            itemCode: '8909876543211',
            mrp: 120,
            classification: 'WATCH',
            urgency: null,
            currentStock: 12,
            daysOfCover: 4,
            effectiveDailyDemand: 3.0,
            suggestedOrderQty: 0,
            reason: 'Stock buffer within watch range'
          }
        ],
        review: {
          matchRequiredItems: [],
          negativeStockItems: [],
          deadStockCandidates: [
            {
              itemName: 'GM MOONG DAL AATA 500 GM',
              itemCode: '8906122501123',
              mrp: 102,
              currentStock: 5,
              classification: 'REVIEW'
            },
            {
              itemName: 'GM BEDMI AATA 500 GM',
              itemCode: '8908004643013',
              mrp: 99,
              currentStock: 3,
              classification: 'REVIEW'
            }
          ],
          zeroStockNeverSold: [
            {
              itemName: 'GM BHATURA 400 GM',
              itemCode: '8908004643136',
              mrp: 82,
              currentStock: 0,
              classification: 'REVIEW'
            }
          ],
          suggestedMerges: [],
          dataQualityNotes: []
        },
        nameResolution: {
          summary: { totalRawNames: 7, matchedCount: 7, autoMergedCount: 0, manualMergedCount: 0, pendingCandidatesCount: 0 },
          validationReport: []
        }
      };

      const dt1 = new DataTransfer();
      dt1.items.add(new File(['dummy'], 'SaleReport.xlsx'));
      const saleInput = document.getElementById('sale-report-input');
      saleInput.files = dt1.files;
      saleInput.dispatchEvent(new Event('change', { bubbles: true }));

      const dt2 = new DataTransfer();
      dt2.items.add(new File(['dummy'], 'StockDetail.xlsx'));
      const stockInput = document.getElementById('stock-detail-input');
      stockInput.files = dt2.files;
      stockInput.dispatchEvent(new Event('change', { bubbles: true }));

      const origFetch = window.fetch;
      window.fetch = async (url, opts) => {
        if (typeof url === 'string' && url.includes('/api/admin/inventory/analyze')) {
          return { ok: true, status: 200, json: async () => window.__analysisData };
        }
        return origFetch(url, opts);
      };

      const form = document.getElementById('analyze-form');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    })()
  `);

  await new Promise(r => setTimeout(r, 1200));

  async function searchUI(query) {
    return await client.evaluate(`
      (() => {
        const input = document.getElementById('master-search-input');
        input.value = ${JSON.stringify(query)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const items = Array.from(document.querySelectorAll('.master-search-item'));
        const noMatch = document.getElementById('master-search-no-match')?.style.display === 'block';
        return {
          noMatch,
          items: items.map(el => ({
            name: el.querySelector('.search-item-name')?.textContent?.trim() || '',
            mrp: el.querySelector('.inline-mrp-tag')?.textContent?.trim() || '',
            status: el.querySelector('.search-item-status-pill')?.textContent?.trim() || '',
            meta: el.querySelector('.search-item-meta')?.textContent?.trim() || ''
          }))
        };
      })()
    `);
  }

  // 1. Search 'gm': verify dead stock inclusion and proper ranking
  console.log('[1/4] Testing search for "gm"...');
  const gmRes = await searchUI('gm');
  assert(gmRes.items.length >= 5, 'Search for "gm" must return at least 5 products');
  
  // Verify dead stock inclusion
  const deadStockFound = gmRes.items.find(it => it.name.includes('GM MOONG DAL AATA'));
  assert(deadStockFound, 'Dead stock item "GM MOONG DAL AATA 500 GM" must appear in results');
  assert(deadStockFound.status.includes('REVIEW'), 'Dead stock item must retain REVIEW status pill');
  assert(deadStockFound.meta.includes('Dead Stock'), 'Dead stock item must display Dead Stock badge');
  console.log(`  ✅ Dead Stock product found in Master Search: "${deadStockFound.name}" (${deadStockFound.status} - ${deadStockFound.meta})`);

  // Verify status priority ranking:
  // BUY NOW (GM MUSTARD OIL) < WATCH (ABC GM OIL) < OK (24M BANYARD MILLET) < REVIEW (GM MOONG DAL AATA)
  const idxMustard = gmRes.items.findIndex(it => it.name.includes('GM MUSTARD OIL 1 LTR'));
  const idxAbcOil = gmRes.items.findIndex(it => it.name.includes('ABC GM OIL'));
  const idxMillet = gmRes.items.findIndex(it => it.name.includes('24M BANYARD MILLET 500 GM'));
  const idxMoong = gmRes.items.findIndex(it => it.name.includes('GM MOONG DAL AATA 500 GM'));
  assert(idxMustard !== -1 && idxAbcOil !== -1 && idxMoong !== -1 && idxMillet !== -1);
  assert(idxMustard < idxAbcOil, `BUY NOW: GM MUSTARD OIL (idx: ${idxMustard}) must rank above WATCH: ABC GM OIL (idx: ${idxAbcOil})`);
  assert(idxAbcOil < idxMillet, `WATCH: ABC GM OIL (idx: ${idxAbcOil}) must rank above OK: 24M BANYARD MILLET (idx: ${idxMillet})`);
  assert(idxMillet < idxMoong, `OK: 24M BANYARD MILLET (idx: ${idxMillet}) must rank above REVIEW: GM MOONG DAL AATA (idx: ${idxMoong})`);
  console.log(`  ✅ Status priority ranking confirmed: BUY NOW -> WATCH -> OK -> REVIEW`);

  // 2. Search 'gm oil': verify multi-word ranking and order-independence
  console.log('\n[2/4] Testing search for "gm oil"...');
  const gmOilRes = await searchUI('gm oil');
  assert(gmOilRes.items.some(it => it.name.includes('GM MUSTARD OIL 1 LTR')), 'GM MUSTARD OIL 1 LTR must match');
  assert(gmOilRes.items.some(it => it.name.includes('ABC GM OIL')), 'ABC GM OIL must match');
  assert(!gmOilRes.items.some(it => it.name.includes('24M BANYARD MILLET')), 'Millet without oil must NOT match');
  console.log(`  ✅ Both tokens required for "gm oil"`);

  console.log('\n[3/4] Testing search for "oil gm" (reversed token order)...');
  const oilGmRes = await searchUI('oil gm');
  assert(oilGmRes.items.length === gmOilRes.items.length, 'Reversed tokens "oil gm" must return identical results count');
  console.log(`  ✅ Order-independence preserved: "oil gm" returns same ${oilGmRes.items.length} items`);

  // 3. Search 'hima neem' (regression check)
  console.log('\n[4/4] Testing search for "hima neem"...');
  const himaRes = await searchUI('hima neem');
  assert(himaRes.items.some(it => it.name.includes('HIMA PURI NEEM FW')), 'HIMA PURI NEEM FW must match "hima neem"');
  console.log(`  ✅ HIMA PURI NEEM FW regression confirmed`);

  // Capture screenshot of "gm" search
  await searchUI('gm');
  await new Promise(r => setTimeout(r, 400));
  const shotPath = 'C:/Users/Admin/.gemini/antigravity/brain/7d63a9ee-4b89-41d2-99bd-34505d5d1728/11_master_search_gm_ranking_and_dead_stock.png';
  await client.captureScreenshot(shotPath);
  console.log('\n  📸 Captured screenshot of GM search ranking with Dead Stock:', shotPath);

  client.close();
  chromeProc.kill();
  console.log('\n================================================================');
  console.log('  ALL BROWSER RELEVANCE & DATASET COVERAGE TESTS PASSED          ');
  console.log('================================================================');
}

testBrowserMasterSearch().catch(err => {
  console.error('Master search browser test failed:', err);
  process.exit(1);
});
