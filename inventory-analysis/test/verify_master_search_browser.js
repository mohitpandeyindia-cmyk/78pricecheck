const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');

const CDP_PORT = 9337;
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
  console.log('  HEADLESS BROWSER VERIFICATION: ORDER-INDEPENDENT MASTER SEARCH ');
  console.log('================================================================\n');

  const jwt = require('c:/seventyeightos/backend/node_modules/jsonwebtoken');
  const token = jwt.sign({ id: 1, username: 'admin' }, 'localtestsecretkey12345', { expiresIn: '2h' });

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const userDataDir = 'C:\\Users\\Admin\\AppData\\Local\\Temp\\chrome_master_search_test';
  const chromeProc = cp.spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=' + CDP_PORT,
    '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + userDataDir,
    '--disable-gpu',
    '--no-sandbox',
    'about:blank'
  ]);

  await new Promise(r => setTimeout(r, 1500));
  const targetsRes = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list');
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

  // Inject dataset with HIMA PURI NEEM FW and other items
  await client.evaluate(`
    (() => {
      window.__analysisData = {
        config: { leadTimeDays: 3, reviewFrequencyDays: 7, orderCoverageDays: 15, serviceLevel: 0.95, watchThresholdFactor: 1.25 },
        summary: { totalItems: 4, buyNowCount: 2, watchCount: 1, okCount: 1, reviewCount: 0 },
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
            itemName: 'AMUL BTTR 500 GM',
            itemCode: '8901262010053',
            mrp: 295,
            classification: 'BUY_NOW',
            urgency: 'HIGH',
            currentStock: 6,
            daysOfCover: 1.4,
            effectiveDailyDemand: 4.2,
            suggestedOrderQty: 58,
            reason: 'Reorder required'
          },
          {
            itemName: 'HIMA NEEM SOAP 125G',
            itemCode: '8909876543210',
            mrp: 65,
            classification: 'OK',
            urgency: null,
            currentStock: 40,
            daysOfCover: 20,
            effectiveDailyDemand: 2.0,
            suggestedOrderQty: 0,
            reason: 'Stock healthy'
          }
        ],
        review: { matchRequiredItems: [], negativeStockItems: [], deadStockCandidates: [], zeroStockNeverSold: [], suggestedMerges: [], dataQualityNotes: [] },
        nameResolution: {
          summary: { totalRawNames: 3, matchedCount: 3, autoMergedCount: 0, manualMergedCount: 0, pendingCandidatesCount: 0 },
          validationReport: [
            {
              canonicalName: 'AMUL BTTR 500 GM',
              salesVariants: [{ rawName: 'AMUL BUTTER 500 GM' }],
              stockVariants: [{ rawName: 'AMUL BTTR 500 GM' }]
            }
          ]
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

  // Helper to query Master Search and retrieve visible result product names
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
            mrp: el.querySelector('.inline-mrp-tag')?.textContent?.trim() || ''
          }))
        };
      })()
    `);
  }

  // Verification List for HIMA PURI NEEM FW:
  const queriesToTest = [
    { q: 'hima neem', shouldMatch: true },
    { q: 'neem hima', shouldMatch: true },
    { q: 'hima fw', shouldMatch: true },
    { q: 'fw hima', shouldMatch: true },
    { q: 'puri hima', shouldMatch: true },
    { q: 'hima puri fw', shouldMatch: true },
    { q: 'hima', shouldMatch: true },
    { q: 'neem', shouldMatch: true },
    { q: 'fw', shouldMatch: true },
    { q: 'hima xyz', shouldMatch: false },
    { q: '500 butter', shouldMatch: true, expectedName: 'AMUL BTTR 500 GM' } // tests out-of-order token with alias
  ];

  for (const t of queriesToTest) {
    const res = await searchUI(t.q);
    if (t.shouldMatch) {
      assert(res.items.length > 0, `Search for "${t.q}" must return at least 1 result`);
      const target = t.expectedName || 'HIMA PURI NEEM FW';
      const hasTarget = res.items.some(it => it.name.includes(target));
      assert(hasTarget, `Search for "${t.q}" must find "${target}" (found: ${res.items.map(i => i.name).join(', ')})`);
      console.log(`  ✅ UI Query "${t.q}" -> MATCH (${res.items[0].name})`);
    } else {
      assert(res.noMatch || res.items.length === 0 || !res.items.some(it => it.name.includes('HIMA PURI NEEM FW')),
        `Search for "${t.q}" must NOT match HIMA PURI NEEM FW`);
      console.log(`  ✅ UI Query "${t.q}" -> NO MATCH (correctly rejected)`);
    }
  }

  // Capture screenshot of "neem hima" search showing HIMA PURI NEEM FW with MRP
  await searchUI('neem hima');
  await new Promise(r => setTimeout(r, 300));
  const shotPath = 'C:/Users/Admin/.gemini/antigravity/brain/7d63a9ee-4b89-41d2-99bd-34505d5d1728/10_order_independent_search_neem_hima.png';
  await client.captureScreenshot(shotPath);
  console.log('\n  📸 Captured screenshot of order-independent search:', shotPath);

  client.close();
  chromeProc.kill();
  console.log('\n================================================================');
  console.log('  BROWSER VERIFICATION COMPLETE: ALL 11 SEARCH QUERIES PASSED   ');
  console.log('================================================================');
}

testBrowserMasterSearch().catch(err => {
  console.error('Master search browser test failed:', err);
  process.exit(1);
});
