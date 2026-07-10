const historyRows = document.getElementById('history-rows');
const errorDiv = document.getElementById('error-message');
const logoutBtn = document.getElementById('logout-btn');

async function loadHistory() {
  try {
    const res = await authenticatedFetch('/api/admin/upload-history');
    if (!res) return; // auth.js handled redirect if token invalid
    
    if (res.status === 200) {
      const data = await res.json();
      historyRows.innerHTML = '';
      
      if (data.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="7" class="text-center text-muted">No upload history records found.</td>';
        historyRows.appendChild(tr);
        return;
      }
      
      data.forEach(run => {
        const tr = document.createElement('tr');
        
        // Format timestamp
        const d = new Date(run.uploadedAt);
        const dateStr = d.toLocaleString('en-GB');
        
        // Format status badge
        const statusClass = run.status === 'Success' ? 'badge badge-success' : 'badge badge-danger';
        
        // Action button for error logs
        let actionCell = '';
        if (run.status === 'Failed' && run.failedRows > 0) {
          actionCell = `<button class="btn btn-outline btn-sm download-btn" data-id="${run.id}">Download Error Report</button>`;
        } else {
          actionCell = '<span class="text-muted">-</span>';
        }
        
        tr.innerHTML = `
          <td>${dateStr}</td>
          <td class="text-semibold">${run.filename}</td>
          <td>${run.totalRows}</td>
          <td>${run.failedRows}</td>
          <td><span class="${statusClass}">${run.status}</span></td>
          <td>${run.processingTimeMs} ms</td>
          <td>${actionCell}</td>
        `;
        
        historyRows.appendChild(tr);
      });
      
      // Attach download event listeners
      document.querySelectorAll('.download-btn').forEach(btn => {
        btn.addEventListener('click', async (evt) => {
          const runId = evt.target.getAttribute('data-id');
          try {
            const dlRes = await authenticatedFetch(`/api/admin/upload-errors/${runId}`);
            if (dlRes && dlRes.status === 200) {
              const blob = await dlRes.blob();
              const url = window.URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `upload_errors_${runId}.csv`;
              document.body.appendChild(a);
              a.click();
              a.remove();
            }
          } catch (err) {
            console.error('Failed to download error report CSV', err);
          }
        });
      });
      
    } else {
      const errData = await res.json();
      errorDiv.textContent = errData.message || 'Failed to load upload history logs.';
      errorDiv.style.display = 'block';
    }
  } catch (err) {
    errorDiv.textContent = 'Failed to connect to backend server.';
    errorDiv.style.display = 'block';
  }
}

// Handle logout
logoutBtn.addEventListener('click', () => {
  localStorage.removeItem('admin_token');
  localStorage.removeItem('admin_username');
  window.location.href = '/admin';
});

loadHistory();
