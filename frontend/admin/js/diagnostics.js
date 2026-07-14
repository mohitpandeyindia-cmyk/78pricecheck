document.addEventListener('DOMContentLoaded', () => {
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      localStorage.removeItem('admin_token');
      localStorage.removeItem('admin_username');
      window.location.href = '/admin';
    });
  }

  const diagBuild = document.getElementById('diag-build');
  const diagVersion = document.getElementById('diag-version');
  const diagCommit = document.getElementById('diag-commit');
  const diagBranch = document.getElementById('diag-branch');
  const diagEnv = document.getElementById('diag-env');
  const diagUptime = document.getElementById('diag-uptime');
  const statusDb = document.getElementById('status-db');
  const statusCatalogueVersion = document.getElementById('status-catalogue-version');
  const statusLatency = document.getElementById('status-latency');
  const refreshBtn = document.getElementById('refresh-diag-btn');

  async function loadDiagnostics() {
    const startTime = Date.now();
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

    // Fetch catalogue version info
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
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadDiagnostics);
  }

  loadDiagnostics();
});
