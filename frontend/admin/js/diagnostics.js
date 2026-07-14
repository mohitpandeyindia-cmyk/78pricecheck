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
  const statusCacheBuild = document.getElementById('status-cache-build');

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

  async function loadDiagnostics() {
    const startTime = Date.now();
    
    // 1. Fetch Server-side Health
    try {
      const response = await authenticatedFetch('/health');
      const latency = Date.now() - startTime;
      statusLatency.textContent = `${latency} ms`;

      if (response && response.status === 200) {
        const data = await response.json();
        
        diagBuild.textContent = data.build || 'N/A';
        diagVersion.textContent = data.version || 'N/A';
        diagCommit.textContent = data.commit || 'N/A';
        diagBranch.textContent = data.branch || 'N/A';
        diagEnv.textContent = (data.environment || 'N/A').toUpperCase();
        
        // Format uptime
        const upSecs = data.uptime || 0;
        const mins = Math.floor(upSecs / 60);
        const hrs = Math.floor(mins / 60);
        diagUptime.textContent = `${hrs}h ${mins % 60}m ${upSecs % 60}s`;

        statusDb.textContent = 'Healthy';
        statusDb.className = 'status-val text-success';
      } else {
        statusDb.textContent = 'Unreachable';
        statusDb.className = 'status-val text-danger';
      }
    } catch (err) {
      statusDb.textContent = 'Connection Error';
      statusDb.className = 'status-val text-danger';
      statusLatency.textContent = 'N/A';
    }

    // 2. Fetch catalogue version metadata
    try {
      const versionResponse = await authenticatedFetch('/api/version');
      if (versionResponse && versionResponse.status === 200) {
        const vData = await versionResponse.json();
        statusCatalogueVersion.textContent = vData.catalogVersion || 'N/A';
      } else {
        statusCatalogueVersion.textContent = 'N/A';
      }
    } catch (e) {
      statusCatalogueVersion.textContent = 'N/A';
    }

    // 3. Load Local Layout parameters
    const safeAreas = getSafeAreaInsets();
    diagViewport.textContent = `${window.innerWidth} × ${window.innerHeight}`;
    diagScale.textContent = (window.innerWidth < 480) ? (window.innerWidth / 390).toFixed(2) : '1.00';
    diagSafeTop.textContent = safeAreas.top !== '0px' ? safeAreas.top : '0 px (Not Active)';
    diagSafeBottom.textContent = safeAreas.bottom !== '0px' ? safeAreas.bottom : '0 px (Not Active)';
    diagOrientation.textContent = window.innerHeight > window.innerWidth ? 'Portrait' : 'Landscape';
    diagUa.textContent = navigator.userAgent;

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
    
    statusCacheHtml.textContent = window.HTML_BUILD || 'N/A';
    statusCacheSw.textContent = swBuild;
    statusCacheController.textContent = navigator.serviceWorker.controller ? 'Active Controller' : 'Direct Network';
    statusCacheBuild.textContent = window.APP_BUILD ? window.APP_BUILD.build : 'N/A';

    // 5. Load Session Telemetry from LocalStorage
    try {
      const telemetry = JSON.parse(localStorage.getItem('78pricecheck_telemetry') || '{}');
      
      diagCamera.textContent = telemetry.cameraLabel || 'Not Initialized';
      diagResolution.textContent = telemetry.cameraResolution || 'N/A';
      diagStartupTime.textContent = telemetry.cameraStartupTime ? `${telemetry.cameraStartupTime} ms` : 'N/A';
      diagScanTime.textContent = telemetry.avgScanTime ? `${telemetry.avgScanTime} ms` : 'N/A';
      diagPermission.textContent = telemetry.cameraPermission || 'Unknown';
      diagTorch.textContent = telemetry.cameraTorch || 'N/A';
      
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
    } catch (telemetryErr) {
      // Fail silently
    }
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadDiagnostics);
  }

  loadDiagnostics();
});
