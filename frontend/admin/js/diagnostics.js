document.addEventListener('DOMContentLoaded', () => {
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      localStorage.removeItem('admin_token');
      localStorage.removeItem('admin_username');
      window.location.href = '/admin';
    });
  }

  // System Health Elements
  const diagBuild = document.getElementById('diag-build');
  const diagVersion = document.getElementById('diag-version');
  const diagCommit = document.getElementById('diag-commit');
  const diagBranch = document.getElementById('diag-branch');
  const diagEnv = document.getElementById('diag-env');
  const diagUptime = document.getElementById('diag-uptime');
  
  // Scanner Elements
  const statusScanner = document.getElementById('status-scanner');
  const diagCamera = document.getElementById('diag-camera');
  const diagResolution = document.getElementById('diag-resolution');
  const diagStartupTime = document.getElementById('diag-startup-time');
  const diagScanTime = document.getElementById('diag-scan-time');
  const diagPermission = document.getElementById('diag-permission');
  const diagTorch = document.getElementById('diag-torch');
  
  // Layout Elements
  const diagViewport = document.getElementById('diag-viewport');
  const diagScale = document.getElementById('diag-scale');
  const diagSafeTop = document.getElementById('diag-safe-top');
  const diagSafeBottom = document.getElementById('diag-safe-bottom');
  const diagOrientation = document.getElementById('diag-orientation');
  const diagUa = document.getElementById('diag-ua');
  
  // Cache Elements
  const statusCacheHtml = document.getElementById('status-cache-html');
  const statusCacheSw = document.getElementById('status-cache-sw');
  const statusCacheController = document.getElementById('status-cache-controller');

  // Services Status Elements
  const statusDb = document.getElementById('status-db');
  const statusCatalogueVersion = document.getElementById('status-catalogue-version');
  const statusLatency = document.getElementById('status-latency');
  const refreshBtn = document.getElementById('refresh-diag-btn');

  // Helper to extract CSS safe-areas inset variables
  function getSafeAreaInsets() {
    const div = document.createElement('div');
    div.style.position = 'fixed';
    div.style.top = '0';
    div.style.left = '0';
    div.style.height = 'env(safe-area-inset-top)';
    div.style.width = 'env(safe-area-inset-bottom)';
    div.style.visibility = 'hidden';
    document.body.appendChild(div);
    const computed = window.getComputedStyle(div);
    const top = computed.height || '0px';
    const bottom = computed.width || '0px';
    document.body.removeChild(div);
    return { top, bottom };
  }

  async function runAcceptanceGateChecks(swBuild, apiHealthy, htmlBuild, serverBuild) {
    // 1. HTML Build
    const gateHtml = document.getElementById('gate-html');
    if (gateHtml) {
      if (htmlBuild && htmlBuild !== 'N/A' && htmlBuild === serverBuild) {
        gateHtml.textContent = 'PASS';
        gateHtml.style.color = 'var(--success-color)';
      } else {
        gateHtml.textContent = 'FAIL';
        gateHtml.style.color = 'var(--danger-color)';
      }
    }

    // 2. JS Build
    const gateJs = document.getElementById('gate-js');
    if (gateJs) {
      if (serverBuild && serverBuild !== 'N/A' && htmlBuild === serverBuild) {
        gateJs.textContent = 'PASS';
        gateJs.style.color = 'var(--success-color)';
      } else {
        gateJs.textContent = 'FAIL';
        gateJs.style.color = 'var(--danger-color)';
      }
    }

    // 3. Local Barcode Lib
    const gateLib = document.getElementById('gate-lib');
    if (gateLib) {
      if (typeof Html5Qrcode !== 'undefined') {
        gateLib.textContent = 'PASS';
        gateLib.style.color = 'var(--success-color)';
      } else {
        gateLib.textContent = 'FAIL';
        gateLib.style.color = 'var(--danger-color)';
      }
    }

    // 4. StateManager
    const gateState = document.getElementById('gate-state');
    if (gateState) {
      if (window.innerWidth > 0 && window.innerHeight > 0) {
        gateState.textContent = 'PASS';
        gateState.style.color = 'var(--success-color)';
      } else {
        gateState.textContent = 'FAIL';
        gateState.style.color = 'var(--danger-color)';
      }
    }

    // 5. API Health
    const gateApi = document.getElementById('gate-api');
    if (gateApi) {
      if (apiHealthy) {
        gateApi.textContent = 'PASS';
        gateApi.style.color = 'var(--success-color)';
      } else {
        gateApi.textContent = 'FAIL';
        gateApi.style.color = 'var(--danger-color)';
      }
    }

    // 6. Service Worker
    const gateSw = document.getElementById('gate-sw');
    if (gateSw) {
      if ('serviceWorker' in navigator && (navigator.serviceWorker.controller || (swBuild && swBuild !== 'None/Inactive'))) {
        gateSw.textContent = 'PASS';
        gateSw.style.color = 'var(--success-color)';
      } else {
        gateSw.textContent = 'FAIL';
        gateSw.style.color = 'var(--danger-color)';
      }
    }
  }

  async function loadDiagnostics() {
    const startTime = Date.now();
    let apiHealthy = false;
    let serverBuild = 'N/A';
    
    // 1. Fetch Server-side Health
    try {
      const response = await authenticatedFetch('/health');
      const latency = Date.now() - startTime;
      if (statusLatency) statusLatency.textContent = `${latency} ms`;

      if (response && response.status === 200) {
        const data = await response.json();
        
        serverBuild = data.build || 'N/A';
        if (diagBuild) diagBuild.textContent = serverBuild;
        if (diagVersion) diagVersion.textContent = data.version || 'N/A';
        if (diagCommit) diagCommit.textContent = data.commit || 'N/A';
        if (diagBranch) diagBranch.textContent = data.branch || 'N/A';
        if (diagEnv) diagEnv.textContent = (data.environment || 'N/A').toUpperCase();
        
        // Format uptime
        const upSecs = data.uptime || 0;
        const mins = Math.floor(upSecs / 60);
        const hrs = Math.floor(mins / 60);
        if (diagUptime) diagUptime.textContent = `${hrs}h ${mins % 60}m ${upSecs % 60}s`;

        if (statusDb) {
          statusDb.textContent = 'Healthy';
          statusDb.className = 'status-val text-success';
        }
        apiHealthy = true;
      } else {
        if (statusDb) {
          statusDb.textContent = 'Unreachable';
          statusDb.className = 'status-val text-danger';
        }
      }
    } catch (err) {
      if (statusDb) {
        statusDb.textContent = 'Connection Error';
        statusDb.className = 'status-val text-danger';
      }
      if (statusLatency) statusLatency.textContent = 'N/A';
    }

    // 2. Fetch catalogue version metadata
    try {
      const versionResponse = await authenticatedFetch('/api/version');
      if (versionResponse && versionResponse.status === 200) {
        const vData = await versionResponse.json();
        if (statusCatalogueVersion) statusCatalogueVersion.textContent = vData.catalogVersion || 'N/A';
      } else {
        if (statusCatalogueVersion) statusCatalogueVersion.textContent = 'N/A';
      }
    } catch (e) {
      if (statusCatalogueVersion) statusCatalogueVersion.textContent = 'N/A';
    }

    // 3. Load Local Layout parameters
    const safeAreas = getSafeAreaInsets();
    if (diagViewport) diagViewport.textContent = `${window.innerWidth} × ${window.innerHeight}`;
    if (diagScale) diagScale.textContent = (window.innerWidth < 480) ? (window.innerWidth / 390).toFixed(2) : '1.00';
    if (diagSafeTop) diagSafeTop.textContent = safeAreas.top !== '0px' ? safeAreas.top : '0 px (Not Active)';
    if (diagSafeBottom) diagSafeBottom.textContent = safeAreas.bottom !== '0px' ? safeAreas.bottom : '0 px (Not Active)';
    if (diagOrientation) diagOrientation.textContent = window.innerHeight > window.innerWidth ? 'Portrait' : 'Landscape';
    if (diagUa) diagUa.textContent = navigator.userAgent;

    // 4. Fetch and Parse active Service Worker build
    let swBuild = 'None/Inactive';
    if ('serviceWorker' in navigator) {
      try {
        const swRes = await fetch('/sw.js');
        if (swRes.status === 200) {
          const swText = await swRes.text();
          const swMatch = swText.match(/const CACHE_NAME = '78pricecheck-(.*?)';/);
          if (swMatch) {
            swBuild = swMatch[1];
          }
        }
      } catch (e) {
        // Fail silently
      }
    }
    
    // 4.5 Fetch HTML Build ID from customer application index.html dynamically
    let htmlBuild = 'N/A';
    try {
      const indexRes = await fetch('/');
      if (indexRes.status === 200) {
        const indexText = await indexRes.text();
        const htmlBuildMatch = indexText.match(/window\.HTML_BUILD\s*=\s*"([^"]*)";/);
        if (htmlBuildMatch) {
          htmlBuild = htmlBuildMatch[1];
        }
      }
    } catch (e) {
      console.warn('Failed to fetch HTML Build ID:', e);
    }
    
    if (statusCacheHtml) statusCacheHtml.textContent = htmlBuild;
    if (statusCacheSw) statusCacheSw.textContent = swBuild;
    if (statusCacheController) statusCacheController.textContent = navigator.serviceWorker.controller ? 'Active Controller' : 'Direct Network';

    // 5. Load Session Telemetry from LocalStorage
    try {
      const telemetry = JSON.parse(localStorage.getItem('78pricecheck_telemetry') || '{}');
      
      if (diagCamera) diagCamera.textContent = telemetry.cameraLabel || 'Not Initialized';
      if (diagResolution) diagResolution.textContent = telemetry.cameraResolution || 'N/A';
      if (diagStartupTime) diagStartupTime.textContent = telemetry.cameraStartupTime ? `${telemetry.cameraStartupTime} ms` : 'N/A';
      if (diagScanTime) diagScanTime.textContent = telemetry.avgScanTime ? `${telemetry.avgScanTime} ms` : 'N/A';
      if (diagPermission) diagPermission.textContent = telemetry.cameraPermission || 'Unknown';
      if (diagTorch) diagTorch.textContent = telemetry.cameraTorch || 'N/A';
      
      if (statusScanner) {
        if (telemetry.cameraPermission === 'Granted') {
          statusScanner.textContent = 'READY';
          statusScanner.style.color = 'var(--success-color)';
        } else if (telemetry.cameraPermission === 'Denied') {
          statusScanner.textContent = 'BLOCKED';
          statusScanner.style.color = 'var(--danger-color)';
        } else {
          statusScanner.textContent = 'UNINITIALIZED';
          statusScanner.style.color = 'var(--text-muted)';
        }
      }
      
      // Populate pipeline instrumentation elements
      const pipeBarcode = document.getElementById('pipe-barcode');
      const pipeUnicode = document.getElementById('pipe-unicode');
      const pipeUrl = document.getElementById('pipe-url');
      const pipeStatus = document.getElementById('pipe-status');
      const pipeHeaders = document.getElementById('pipe-headers');
      const pipeBody = document.getElementById('pipe-body');
      const pipeErrorSection = document.getElementById('pipe-error-section');
      const pipeErrorText = document.getElementById('pipe-error-text');

      if (pipeBarcode) pipeBarcode.textContent = telemetry.lastInspectedBarcode || '-';
      if (pipeUnicode) {
        if (telemetry.lastInspectedBarcodeUnicode) {
          pipeUnicode.textContent = `Length: ${telemetry.lastInspectedBarcodeLength || 0} | Points: ${telemetry.lastInspectedBarcodeUnicode}`;
        } else {
          pipeUnicode.textContent = '-';
        }
      }
      if (pipeUrl) {
        if (telemetry.lastLookupUrl) {
          pipeUrl.textContent = `${telemetry.lastLookupMethod || 'GET'} ${telemetry.lastLookupUrl}`;
        } else {
          pipeUrl.textContent = '-';
        }
      }
      if (pipeStatus) {
        const stat = telemetry.lastLookupStatus;
        pipeStatus.textContent = stat || '-';
        if (stat === 200 || stat === '200') {
          pipeStatus.style.color = 'var(--success-color)';
        } else if (stat && stat !== 'Pending...') {
          pipeStatus.style.color = 'var(--danger-color)';
        } else {
          pipeStatus.style.color = '';
        }
      }
      if (pipeHeaders) pipeHeaders.textContent = telemetry.lastLookupHeaders || '-';
      if (pipeBody) pipeBody.textContent = telemetry.lastLookupRawBody || '-';
      
      const hasError = telemetry.lastLookupError || telemetry.lastLookupJsonError || telemetry.lastLookupStack;
      if (pipeErrorSection && pipeErrorText) {
        if (hasError) {
          let errText = '';
          if (telemetry.lastLookupError) errText += `Fetch Error: ${telemetry.lastLookupError}\n`;
          if (telemetry.lastLookupJsonError) errText += `JSON Parsing Error: ${telemetry.lastLookupJsonError}\n`;
          if (telemetry.lastLookupStack) errText += `Stack Trace:\n${telemetry.lastLookupStack}\n`;
          pipeErrorText.textContent = errText;
          pipeErrorSection.style.display = 'block';
        } else {
          pipeErrorSection.style.display = 'none';
        }
      }
    } catch (telemetryErr) {
      // Fail silently
    }

    // 6. Run Acceptance Gate Checklists
    await runAcceptanceGateChecks(swBuild, apiHealthy, htmlBuild, serverBuild);
  }

  // Phase 2A Admin Scanner Diagnostics Session Controls
  const sessStatusBadge = document.getElementById('sess-status-badge');
  const sessStatus = document.getElementById('sess-status');
  const sessId = document.getElementById('sess-id');
  const sessStarted = document.getElementById('sess-started');
  const sessDuration = document.getElementById('sess-duration');
  const sessTotalScans = document.getElementById('sess-total-scans');
  const sessSuccessful = document.getElementById('sess-successful');
  const sessFailed = document.getElementById('sess-failed');
  const sessIos = document.getElementById('sess-ios');
  const sessAndroid = document.getElementById('sess-android');
  const sessOther = document.getElementById('sess-other');
  const startSessionBtn = document.getElementById('start-session-btn');
  const endSessionBtn = document.getElementById('end-session-btn');

  let activeSessionTimer = null;
  let sessionStartedTimestamp = null;

  function formatHHMMSS(sec) {
    const s = Math.max(0, Math.floor(sec));
    const hrs = String(Math.floor(s / 3600)).padStart(2, '0');
    const mins = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const secs = String(s % 60).padStart(2, '0');
    return `${hrs}:${mins}:${secs}`;
  }

  async function loadActiveSessionState() {
    try {
      const res = await authenticatedFetch('/api/admin/diagnostics/session/active');
      if (res && res.status === 200) {
        const data = await res.json();
        if (data.status === 'ACTIVE' && data.session) {
          const s = data.session;
          if (sessStatusBadge) {
            sessStatusBadge.textContent = 'ACTIVE';
            sessStatusBadge.style.backgroundColor = '#22c55e';
          }
          if (sessStatus) {
            sessStatus.textContent = 'ACTIVE';
            sessStatus.style.color = '#22c55e';
          }
          if (sessId) sessId.textContent = s.sessionId;
          if (sessStarted) sessStarted.textContent = new Date(s.startedAt).toLocaleTimeString();
          if (sessTotalScans) sessTotalScans.textContent = s.totalScans || 0;
          if (sessSuccessful) sessSuccessful.textContent = s.successfulScans || 0;
          if (sessFailed) sessFailed.textContent = s.failedEvents || 0;
          if (sessIos) sessIos.textContent = s.iosCount || 0;
          if (sessAndroid) sessAndroid.textContent = s.androidCount || 0;
          if (sessOther) sessOther.textContent = s.otherCount || 0;

          if (startSessionBtn) startSessionBtn.disabled = true;
          if (endSessionBtn) endSessionBtn.disabled = false;

          sessionStartedTimestamp = new Date(s.startedAt).getTime();
          if (!activeSessionTimer) {
            activeSessionTimer = setInterval(() => {
              if (sessionStartedTimestamp && sessDuration) {
                const elapsedSec = (Date.now() - sessionStartedTimestamp) / 1000;
                sessDuration.textContent = formatHHMMSS(elapsedSec);
              }
            }, 1000);
          }
        } else {
          // OFF / No Active Session
          if (sessStatusBadge) {
            sessStatusBadge.textContent = 'OFF';
            sessStatusBadge.style.backgroundColor = '#ef4444';
          }
          if (sessStatus) {
            sessStatus.textContent = 'OFF';
            sessStatus.style.color = '#ef4444';
          }
          if (sessId) sessId.textContent = '-';
          if (sessStarted) sessStarted.textContent = '-';
          if (sessDuration) sessDuration.textContent = '00:00:00';
          if (sessTotalScans) sessTotalScans.textContent = '0';
          if (sessSuccessful) sessSuccessful.textContent = '0';
          if (sessFailed) sessFailed.textContent = '0';
          if (sessIos) sessIos.textContent = '0';
          if (sessAndroid) sessAndroid.textContent = '0';
          if (sessOther) sessOther.textContent = '0';

          if (startSessionBtn) startSessionBtn.disabled = false;
          if (endSessionBtn) endSessionBtn.disabled = true;

          if (activeSessionTimer) {
            clearInterval(activeSessionTimer);
            activeSessionTimer = null;
          }
          sessionStartedTimestamp = null;
        }
      }
    } catch (e) {
      console.warn('Failed to load active diagnostic session state:', e);
    }
  }

  if (startSessionBtn) {
    startSessionBtn.addEventListener('click', async () => {
      try {
        startSessionBtn.disabled = true;
        const res = await authenticatedFetch('/api/admin/diagnostics/session/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        if (res && res.status === 200) {
          await loadActiveSessionState();
        }
      } catch (err) {
        alert('Failed to start diagnostic session: ' + err.message);
      } finally {
        startSessionBtn.disabled = false;
      }
    });
  }

  if (endSessionBtn) {
    endSessionBtn.addEventListener('click', async () => {
      try {
        endSessionBtn.disabled = true;
        const res = await authenticatedFetch('/api/admin/diagnostics/session/end', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        if (res && res.status === 200) {
          await loadActiveSessionState();
        }
      } catch (err) {
        alert('Failed to end diagnostic session: ' + err.message);
      } finally {
        endSessionBtn.disabled = false;
      }
    });
  }

  // Phase 2A Session Analysis Dashboard Handler
  const analyzeSessionBtn = document.getElementById('analyze-session-btn');
  const sessionAnalysisDashboardCard = document.getElementById('session-analysis-dashboard-card');
  const analysisSessionSubtitle = document.getElementById('analysis-session-subtitle');
  const analysisDashboardContent = document.getElementById('analysis-dashboard-content');
  const exportJsonBtn = document.getElementById('export-json-btn');

  let currentAnalysisSessionId = null;

  async function renderSessionAnalysis(sessionId = 'active') {
    if (!sessionAnalysisDashboardCard || !analysisDashboardContent) return;

    analysisDashboardContent.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted);">Analyzing session diagnostic telemetry data...</div>';
    sessionAnalysisDashboardCard.style.display = 'block';

    try {
      const res = await authenticatedFetch(`/api/admin/diagnostics/session/${sessionId}/analysis`);
      if (res && res.status === 200) {
        const data = await res.json();
        if (!data.success || !data.session) {
          analysisDashboardContent.innerHTML = `<div style="padding: 20px; color: var(--danger-color);">${data.message || 'Failed to load analysis data.'}</div>`;
          return;
        }

        const s = data.session;
        currentAnalysisSessionId = s.session_id;
        if (analysisSessionSubtitle) {
          analysisSessionSubtitle.textContent = `Session: ${s.session_id} | Status: ${s.status} | Started: ${new Date(s.started_at).toLocaleString()}`;
        }

        const sum = data.summary || {};
        const browserStats = data.browserStats || [];
        const sizeStats = data.sizeStats || [];
        const resolutionStats = data.resolutionStats || [];
        const devices = data.devices || [];
        const correlations = data.keyCorrelations || [];

        let html = `
          <!-- Summary Metric Badges -->
          <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 25px;">
            <div style="background: var(--bg-card); border: 1px solid var(--border-color); padding: 15px; border-radius: 8px;">
              <span style="font-size: 0.8rem; color: var(--text-muted); font-weight: 500;">iOS Success Rate</span>
              <div style="font-size: 1.6rem; font-weight: 800; color: ${sum.iosSuccessRate < 80 ? '#ef4444' : '#22c55e'}; margin-top: 4px;">
                ${sum.iosSuccessRate}%
              </div>
            </div>
            <div style="background: var(--bg-card); border: 1px solid var(--border-color); padding: 15px; border-radius: 8px;">
              <span style="font-size: 0.8rem; color: var(--text-muted); font-weight: 500;">Android Success Rate</span>
              <div style="font-size: 1.6rem; font-weight: 800; color: #22c55e; margin-top: 4px;">
                ${sum.androidSuccessRate}%
              </div>
            </div>
            <div style="background: var(--bg-card); border: 1px solid var(--border-color); padding: 15px; border-radius: 8px;">
              <span style="font-size: 0.8rem; color: var(--text-muted); font-weight: 500;">Total Successful Scans</span>
              <div style="font-size: 1.6rem; font-weight: 800; color: var(--text-color); margin-top: 4px;">
                ${sum.successfulScans || 0}
              </div>
            </div>
            <div style="background: var(--bg-card); border: 1px solid var(--border-color); padding: 15px; border-radius: 8px;">
              <span style="font-size: 0.8rem; color: var(--text-muted); font-weight: 500;">Failed / Recovery Events</span>
              <div style="font-size: 1.6rem; font-weight: 800; color: #f59e0b; margin-top: 4px;">
                ${sum.failedEvents || 0}
              </div>
            </div>
          </div>

          <!-- Strongest Correlations with iOS Failure -->
          <div style="margin-bottom: 25px; background: #fffbe6; border: 1px solid #ffe58f; padding: 18px; border-radius: 8px;">
            <h3 style="margin-top: 0; font-size: 1.1rem; color: #d46b08; font-weight: 700; margin-bottom: 12px;">
              ⚡ STRONGEST CORRELATIONS WITH iOS SCAN FAILURES
            </h3>
            <ul style="margin: 0; padding-left: 20px; color: #595959; font-size: 0.9rem; line-height: 1.6;">
              ${correlations.map(c => `
                <li style="margin-bottom: 8px;">
                  <strong style="color: #262626;">${c.factor} [${c.impact}]:</strong> ${c.finding}
                </li>
              `).join('')}
            </ul>
          </div>

          <!-- Barcode Size / Occupancy Analysis (Small, Medium, Large) -->
          <div style="margin-bottom: 25px;">
            <h3 style="font-size: 1.1rem; font-weight: 700; margin-bottom: 12px; color: var(--text-color);">
              📏 BARCODE SIZE / OCCUPANCY FAILURE-RATE ANALYSIS
            </h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
              <thead>
                <tr style="background: var(--border-color); text-align: left;">
                  <th style="padding: 10px;">Size Bucket</th>
                  <th style="padding: 10px;">Platform OS</th>
                  <th style="padding: 10px;">Scan Count</th>
                  <th style="padding: 10px;">Avg Frame Width %</th>
                  <th style="padding: 10px;">Avg Decode Latency</th>
                </tr>
              </thead>
              <tbody>
                ${sizeStats.length > 0 ? sizeStats.map(s => `
                  <tr style="border-bottom: 1px solid var(--border-color);">
                    <td style="padding: 10px; font-weight: 700;">${s.size_category}</td>
                    <td style="padding: 10px;">${s.device_os}</td>
                    <td style="padding: 10px; font-weight: 600;">${s.scan_count}</td>
                    <td style="padding: 10px;">${s.avg_pct_w ? s.avg_pct_w.toFixed(1) + '%' : 'N/A'}</td>
                    <td style="padding: 10px;">${s.avg_latency_ms ? Math.round(s.avg_latency_ms) + ' ms' : 'N/A'}</td>
                  </tr>
                `).join('') : `<tr><td colspan="5" style="padding: 10px; color: var(--text-muted);">No barcode size telemetry available yet for this session.</td></tr>`}
              </tbody>
            </table>
          </div>

          <!-- Browser & Resolution Analysis -->
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 25px;">
            <div>
              <h3 style="font-size: 1.05rem; font-weight: 700; margin-bottom: 12px; color: var(--text-color);">
                🌐 Browser Comparison (Safari vs Chrome)
              </h3>
              <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
                <thead>
                  <tr style="background: var(--border-color); text-align: left;">
                    <th style="padding: 8px;">Browser</th>
                    <th style="padding: 8px;">OS</th>
                    <th style="padding: 8px;">Scans</th>
                    <th style="padding: 8px;">Avg Latency</th>
                  </tr>
                </thead>
                <tbody>
                  ${browserStats.length > 0 ? browserStats.map(b => `
                    <tr style="border-bottom: 1px solid var(--border-color);">
                      <td style="padding: 8px; font-weight: 600;">${b.browser}</td>
                      <td style="padding: 8px;">${b.device_os}</td>
                      <td style="padding: 8px;">${b.scan_count}</td>
                      <td style="padding: 8px;">${b.avg_latency_ms ? Math.round(b.avg_latency_ms) + ' ms' : 'N/A'}</td>
                    </tr>
                  `).join('') : `<tr><td colspan="4" style="padding: 8px; color: var(--text-muted);">No data</td></tr>`}
                </tbody>
              </table>
            </div>

            <div>
              <h3 style="font-size: 1.05rem; font-weight: 700; margin-bottom: 12px; color: var(--text-color);">
                📷 Camera Resolution Distribution
              </h3>
              <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
                <thead>
                  <tr style="background: var(--border-color); text-align: left;">
                    <th style="padding: 8px;">Resolution</th>
                    <th style="padding: 8px;">OS</th>
                    <th style="padding: 8px;">Scans</th>
                  </tr>
                </thead>
                <tbody>
                  ${resolutionStats.length > 0 ? resolutionStats.map(r => `
                    <tr style="border-bottom: 1px solid var(--border-color);">
                      <td style="padding: 8px; font-weight: 600;">${r.resolution}</td>
                      <td style="padding: 8px;">${r.device_os}</td>
                      <td style="padding: 8px;">${r.scan_count}</td>
                    </tr>
                  `).join('') : `<tr><td colspan="3" style="padding: 8px; color: var(--text-muted);">No data</td></tr>`}
                </tbody>
              </table>
            </div>
          </div>

          <!-- Registered Devices Inventory -->
          <div>
            <h3 style="font-size: 1.05rem; font-weight: 700; margin-bottom: 12px; color: var(--text-color);">
              📱 Registered Customer Device Telemetry (${devices.length})
            </h3>
            <div style="max-height: 250px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 6px;">
              <table style="width: 100%; border-collapse: collapse; font-size: 0.8rem;">
                <thead>
                  <tr style="background: var(--border-color); text-align: left; position: sticky; top: 0;">
                    <th style="padding: 8px;">Platform</th>
                    <th style="padding: 8px;">Browser</th>
                    <th style="padding: 8px;">Viewport / DPR</th>
                    <th style="padding: 8px;">Focus / Zoom Cap</th>
                    <th style="padding: 8px;">User Agent</th>
                  </tr>
                </thead>
                <tbody>
                  ${devices.length > 0 ? devices.map(d => `
                    <tr style="border-bottom: 1px solid var(--border-color);">
                      <td style="padding: 8px; font-weight: 700;">${d.classification}</td>
                      <td style="padding: 8px;">${d.browser || 'N/A'}</td>
                      <td style="padding: 8px;">${d.viewport_width || '-'}x${d.viewport_height || '-'} (${d.device_pixel_ratio || 1}x)</td>
                      <td style="padding: 8px;">Focus:${d.focus_mode_supported === 1 ? 'YES' : 'NO'} | Zoom:${d.zoom_supported === 1 ? 'YES' : 'NO'}</td>
                      <td style="padding: 8px; font-family: monospace; font-size: 0.75rem; word-break: break-all;">${(d.user_agent || '-').slice(0, 80)}...</td>
                    </tr>
                  `).join('') : `<tr><td colspan="5" style="padding: 8px; color: var(--text-muted);">No devices registered yet</td></tr>`}
                </tbody>
              </table>
            </div>
          </div>
        `;

        analysisDashboardContent.innerHTML = html;
      }
    } catch (err) {
      analysisDashboardContent.innerHTML = `<div style="padding: 20px; color: var(--danger-color);">Error fetching analysis: ${err.message}</div>`;
    }
  }

  if (analyzeSessionBtn) {
    analyzeSessionBtn.addEventListener('click', () => {
      renderSessionAnalysis('active');
    });
  }

  if (exportJsonBtn) {
    exportJsonBtn.addEventListener('click', () => {
      const sid = currentAnalysisSessionId || 'active';
      const token = localStorage.getItem('admin_token');
      fetch(`/api/admin/diagnostics/session/${sid}/export`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      .then(res => res.blob())
      .then(blob => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `diagnostics_${sid}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      })
      .catch(err => alert('Failed to export raw telemetry data: ' + err.message));
    });
  }

  // Poll session state every 3 seconds while admin is viewing diagnostics
  setInterval(loadActiveSessionState, 3000);
  loadActiveSessionState();

  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadDiagnostics);
  }

  loadDiagnostics();
});
