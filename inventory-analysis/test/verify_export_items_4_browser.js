const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');

const CDP_PORT = 9336;
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

async function testBrowser() {
  const jwt = require('c:/seventyeightos/backend/node_modules/jsonwebtoken');
  const token = jwt.sign({ id: 1, username: 'admin' }, 'localtestsecretkey12345', { expiresIn: '2h' });

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const userDataDir = 'C:\\Users\\Admin\\AppData\\Local\\Temp\\chrome_mrp_test_user_4';
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
  const vRes = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version');
  const vData = await vRes.json();
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

  const statusText = await client.evaluate(`document.getElementById('mrp-file-name')?.textContent`);
  console.log('UI MRP Status Text on load:', statusText);
  assert(statusText.includes('9,376 products'), 'Status text must show 9,376 products');

  // Inject sample analysis item to test Master Search & Drawer display with 24M BANYARD MILLET
  const searchTest = await client.evaluate(`
    (() => {
      window.__analysisData = {
        config: {
          leadTimeDays: 3,
          reviewFrequencyDays: 7,
          orderCoverageDays: 15,
          serviceLevel: 0.95,
          watchThresholdFactor: 1.25
        },
        summary: {
          totalItems: 1,
          buyNowCount: 1,
          watchCount: 0,
          okCount: 0,
          reviewCount: 0
        },
        suggestions: [
          {
            itemName: '24M BANYARD MILLET 500G',
            itemCode: '8904083516460',
            mrp: 150,
            classification: 'BUY_NOW',
            urgency: 'HIGH',
            currentStock: 0,
            daysOfCover: 0,
            effectiveDailyDemand: 2.5,
            suggestedOrderQty: 10,
            reorderPoint: 15,
            targetStock: 25,
            safetyStock: 5,
            leadTimeDays: 3,
            orderCoverageDays: 15,
            trend: 'stable',
            demandChangePct: 0,
            periodDays: 60,
            totalSoldInPeriod: 150,
            fullPeriodAvgDailyDemand: 2.5,
            recentAvgDailyDemand: 2.5,
            priorAvgDailyDemand: 2.5,
            trendWindowDays: 14,
            reason: 'Stockout risk.'
          }
        ],
        review: {
          matchRequiredItems: [],
          negativeStockItems: [],
          deadStockCandidates: [],
          zeroStockNeverSold: [],
          suggestedMerges: [],
          dataQualityNotes: []
        },
        nameResolution: {
          summary: { totalRawNames: 1, matchedCount: 1, autoMergedCount: 0, manualMergedCount: 0, pendingCandidatesCount: 0 },
          validationReport: [],
          persistentMappings: [],
          persistentSeparates: []
        },
        meta: {
          salesPeriod: { from: '2026-08-01', to: '2026-09-30', days: 60 },
          stockSnapshotDate: null
        }
      };

      // Set dummy files on inputs so form validation passes
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

      // Intercept fetch for /api/admin/inventory/analyze
      const origFetch = window.fetch;
      window.fetch = async (url, opts) => {
        if (typeof url === 'string' && url.includes('/api/admin/inventory/analyze')) {
          return {
            ok: true,
            status: 200,
            json: async () => window.__analysisData
          };
        }
        return origFetch(url, opts);
      };

      // Trigger form submit
      const form = document.getElementById('analyze-form');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

      return true;
    })()
  `);

  await new Promise(r => setTimeout(r, 1200));

  // Perform Master Search
  const searchResult = await client.evaluate(`
    (() => {
      const searchInput = document.getElementById('master-search-input');
      searchInput.value = '24M BANYARD MILLET';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));

      const firstItem = document.querySelector('.master-search-item');
      const itemTitle = firstItem?.querySelector('.search-item-name')?.textContent;
      const mrpTag = firstItem?.querySelector('.inline-mrp-tag')?.textContent;
      
      // Open drawer
      if (firstItem) firstItem.click();

      const drawerName = document.getElementById('drawer-item-name')?.textContent;
      const drawerMrp = document.getElementById('drawer-item-mrp')?.textContent;

      return {
        itemTitle,
        mrpTag,
        drawerName,
        drawerMrp
      };
    })()
  `);

  console.log('Search Result & Drawer Details:', searchResult);
  assert(searchResult.mrpTag.includes('₹150 MRP'), 'Search card must show ₹150 MRP');
  assert(searchResult.drawerMrp.includes('₹150 MRP'), 'Drawer header must show ₹150 MRP');
  console.log('✅ Master Search and Product Drawer successfully render ₹150 MRP for 24M BANYARD MILLET 500G');

  const screenshotPath = 'C:/Users/Admin/.gemini/antigravity/brain/7d63a9ee-4b89-41d2-99bd-34505d5d1728/09_export_items_4_banyard_millet_search.png';
  await client.captureScreenshot(screenshotPath);
  console.log('Saved screenshot:', screenshotPath);

  client.close();
  chromeProc.kill();
}

testBrowser().catch(err => {
  console.error('Browser test failed:', err);
  process.exit(1);
});
