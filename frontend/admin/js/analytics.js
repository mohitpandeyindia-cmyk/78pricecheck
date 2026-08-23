document.addEventListener('DOMContentLoaded', () => {
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      localStorage.removeItem('admin_token');
      localStorage.removeItem('admin_username');
      window.location.href = '/admin';
    });
  }

  let currentDaysLimit = 7;

  const valToday = document.getElementById('val-today');
  const valMonth = document.getElementById('val-month');
  const valOverall = document.getElementById('val-overall');
  const valNotFound = document.getElementById('val-not-found');

  const btn7Days = document.getElementById('btn-7days');
  const btn30Days = document.getElementById('btn-30days');

  const activityChart = document.getElementById('activity-chart');
  const peakHoursChart = document.getElementById('peak-hours-chart');
  const topProductsBody = document.getElementById('top-products-body');
  const unknownBarcodesBody = document.getElementById('unknown-barcodes-body');

  if (btn7Days) {
    btn7Days.addEventListener('click', () => {
      if (currentDaysLimit !== 7) {
        currentDaysLimit = 7;
        btn7Days.classList.add('active');
        btn30Days.classList.remove('active');
        fetchAnalytics();
      }
    });
  }

  if (btn30Days) {
    btn30Days.addEventListener('click', () => {
      if (currentDaysLimit !== 30) {
        currentDaysLimit = 30;
        btn30Days.classList.add('active');
        btn7Days.classList.remove('active');
        fetchAnalytics();
      }
    });
  }

  let currentDevicePeriod = 'today';

  const devValToday = document.getElementById('dev-val-today');
  const devValWeek = document.getElementById('dev-val-week');
  const devValMonth = document.getElementById('dev-val-month');
  const devValTotal = document.getElementById('dev-val-total');
  const devValNewIos = document.getElementById('dev-val-new-ios');
  const devValNewAndroid = document.getElementById('dev-val-new-android');
  const devValNewOther = document.getElementById('dev-val-new-other');
  const devValReturning = document.getElementById('dev-val-returning');
  const deviceToggleContainer = document.getElementById('device-period-toggle');

  if (deviceToggleContainer) {
    deviceToggleContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn && btn.dataset.period) {
        const period = btn.dataset.period;
        if (currentDevicePeriod !== period) {
          currentDevicePeriod = period;
          deviceToggleContainer.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          fetchDeviceAnalytics(period);
        }
      }
    });
  }

  async function fetchAnalytics() {
    try {
      const response = await authenticatedFetch(`/api/admin/analytics?days=${currentDaysLimit}`);
      if (!response) return; // auth.js handles redirect to /admin if token missing or invalid

      if (!response.ok) {
        throw new Error('Failed to load analytics data');
      }

      const data = await response.json();
      renderMetrics(data);
      renderActivityChart(data.dailyActivity || [], currentDaysLimit);
      renderPeakHoursChart(data.peakHours || []);
      renderTopProducts(data.topProducts || []);
      renderUnknownBarcodes(data.unknownBarcodes || []);
    } catch (err) {
      console.error('[Analytics Dashboard Error]', err);
    }
  }

  async function fetchDeviceAnalytics(period = 'today') {
    try {
      const response = await authenticatedFetch(`/api/admin/analytics/devices?period=${period}`);
      if (!response || !response.ok) return;

      const data = await response.json();
      renderDeviceMetrics(data);
    } catch (err) {
      console.error('[Device Analytics Error]', err);
    }
  }

  function renderDeviceMetrics(data) {
    const sum = data.summary || {};
    if (devValToday) devValToday.textContent = (sum.today || 0).toLocaleString();
    if (devValWeek) devValWeek.textContent = (sum.week || 0).toLocaleString();
    if (devValMonth) devValMonth.textContent = (sum.month || 0).toLocaleString();
    if (devValTotal) devValTotal.textContent = (data.totalUniqueDevices || 0).toLocaleString();

    if (devValNewIos) devValNewIos.textContent = (data.newIosDevices || 0).toLocaleString();
    if (devValNewAndroid) devValNewAndroid.textContent = (data.newAndroidDevices || 0).toLocaleString();
    if (devValNewOther) devValNewOther.textContent = (data.newOtherDevices || 0).toLocaleString();
    if (devValReturning) devValReturning.textContent = (data.returningDevices || 0).toLocaleString();
  }

  function renderMetrics(data) {
    if (valToday) valToday.textContent = (data.today || 0).toLocaleString();
    if (valMonth) valMonth.textContent = (data.month || 0).toLocaleString();
    if (valOverall) valOverall.textContent = (data.overall || 0).toLocaleString();
    if (valNotFound) valNotFound.textContent = (data.notFound || 0).toLocaleString();
  }

  function renderActivityChart(activityData, daysCount) {
    if (!activityChart) return;
    activityChart.innerHTML = '';

    if (activityData.length === 0) {
      activityChart.innerHTML = `<div style="width: 100%; text-align: center; color: #94a3b8; padding-top: 60px;">No scan activity recorded yet</div>`;
      return;
    }

    const maxVal = Math.max(...activityData.map(d => d.count), 1);

    activityData.forEach(item => {
      const col = document.createElement('div');
      col.className = 'chart-bar-col';

      const pctHeight = Math.max(Math.round((item.count / maxVal) * 100), 4);
      const dateParts = item.date ? item.date.split('-') : ['', '', ''];
      const shortDate = dateParts.length === 3 ? `${dateParts[1]}/${dateParts[2]}` : item.date;

      col.innerHTML = `
        <span class="bar-val">${item.count}</span>
        <div class="chart-bar" style="height: ${pctHeight}%;"></div>
        <span class="bar-date">${shortDate}</span>
      `;
      activityChart.appendChild(col);
    });
  }

  function renderPeakHoursChart(peakData) {
    if (!peakHoursChart) return;
    peakHoursChart.innerHTML = '';

    // Map hours 0..23
    const hoursMap = new Array(24).fill(0);
    peakData.forEach(p => {
      if (p.hour >= 0 && p.hour < 24) {
        hoursMap[p.hour] = p.count;
      }
    });

    const maxVal = Math.max(...hoursMap, 1);

    for (let h = 0; h < 24; h++) {
      const cnt = hoursMap[h];
      const col = document.createElement('div');
      col.className = 'hourly-col';

      const pctHeight = cnt > 0 ? Math.max(Math.round((cnt / maxVal) * 100), 6) : 2;
      const hourLabel = h === 0 ? '12A' : h === 12 ? '12P' : h > 12 ? `${h - 12}P` : `${h}A`;

      col.innerHTML = `
        <div class="hourly-bar" style="height: ${pctHeight}%; opacity: ${cnt > 0 ? 1 : 0.25};" title="${hourLabel}: ${cnt} scans"></div>
        <span class="hourly-lbl">${hourLabel}</span>
      `;
      peakHoursChart.appendChild(col);
    }
  }

  function renderTopProducts(products) {
    if (!topProductsBody) return;
    topProductsBody.innerHTML = '';

    if (products.length === 0) {
      topProductsBody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: #94a3b8; padding: 20px;">No product scans recorded yet</td></tr>`;
      return;
    }

    products.forEach((p, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-weight: 700; color: #64748b;">${idx + 1}</td>
        <td style="font-weight: 600; color: #0f172a;">${escapeHtml(p.name)}</td>
        <td style="font-family: monospace; color: #475569;">${escapeHtml(p.barcode)}</td>
        <td style="text-align: right;"><span class="count-badge">${p.scanCount.toLocaleString()} scans</span></td>
      `;
      topProductsBody.appendChild(tr);
    });
  }

  function renderUnknownBarcodes(barcodes) {
    if (!unknownBarcodesBody) return;
    unknownBarcodesBody.innerHTML = '';

    if (barcodes.length === 0) {
      unknownBarcodesBody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: #94a3b8; padding: 20px;">No failed scan attempts recorded</td></tr>`;
      return;
    }

    barcodes.forEach((b, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-weight: 700; color: #64748b;">${idx + 1}</td>
        <td style="font-family: monospace; color: #b91c1c; font-weight: 600;">${escapeHtml(b.barcode)}</td>
        <td style="text-align: right;"><span class="count-badge count-badge--danger">${b.attempts.toLocaleString()} attempts</span></td>
      `;
      unknownBarcodesBody.appendChild(tr);
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Initial fetch
  fetchAnalytics();
  fetchDeviceAnalytics(currentDevicePeriod);
});
