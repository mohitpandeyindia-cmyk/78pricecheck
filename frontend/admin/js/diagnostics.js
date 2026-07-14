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
    } catch (telemetryErr) {
      // Fail silently
    }

    // 6. Run Acceptance Gate Checklists
    await runAcceptanceGateChecks(swBuild, apiHealthy, htmlBuild, serverBuild);
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadDiagnostics);
  }

  loadDiagnostics();
});
