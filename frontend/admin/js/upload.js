const browseBtn = document.getElementById('browse-btn');
const fileInput = document.getElementById('file-input');
const fileNameLabel = document.getElementById('file-name');
const uploadBtn = document.getElementById('upload-btn');
const uploadForm = document.getElementById('upload-form');
const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const logoutBtn = document.getElementById('logout-btn');

const resultContainer = document.getElementById('result-container');
const successAlert = document.getElementById('success-alert');
const failureAlert = document.getElementById('failure-alert');
const failureMsg = document.getElementById('failure-msg');
const errorLogsBody = document.getElementById('error-logs-body');
const errorsReportLink = document.getElementById('errors-report-link');
const downloadErrorsBtn = document.getElementById('download-errors-btn');

// Handle file selection
browseBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    fileNameLabel.textContent = fileInput.files[0].name;
    uploadBtn.disabled = false;
  } else {
    fileNameLabel.textContent = 'No file selected';
    uploadBtn.disabled = true;
  }
});

// Fetch and update catalog status panel
async function updateStatusPanel() {
  try {
    const res = await fetch('/api/version');
    if (res.status === 200) {
      const data = await res.json();
      document.getElementById('status-products').textContent = Number(data.productsCount || 0).toLocaleString();
      document.getElementById('status-version').textContent = data.catalogVersion || 'N/A';
      
      if (data.lastCatalogUpload) {
        const d = new Date(data.lastCatalogUpload);
        const options = { day: 'numeric', month: 'long', year: 'numeric' };
        const dateStr = d.toLocaleDateString('en-GB', options);
        const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
        document.getElementById('status-updated').innerHTML = `${dateStr}<br>${timeStr}`;
      } else {
        document.getElementById('status-updated').textContent = 'Never';
      }
    }
  } catch (err) {
    console.error('Failed to load version info', err);
  }
}

// Handle upload submission
uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (fileInput.files.length === 0) return;
  
  const uploadFilename = fileInput.files[0].name;
  uploadBtn.disabled = true;
  progressContainer.style.display = 'block';
  progressBar.style.width = '0%';
  progressText.textContent = 'Uploading: 0%';
  
  resultContainer.style.display = 'none';
  successAlert.style.display = 'none';
  failureAlert.style.display = 'none';
  errorsReportLink.style.display = 'none';
  errorLogsBody.innerHTML = '';
  
  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  
  try {
    const xhr = new XMLHttpRequest();
    
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        progressBar.style.width = percent + '%';
        progressText.textContent = `Uploading: ${percent}%`;
      }
    });
    
    xhr.addEventListener('load', async () => {
      progressContainer.style.display = 'none';
      uploadBtn.disabled = false;
      
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch (pErr) {
        data = { success: false, message: 'Invalid server response.' };
      }
      
      resultContainer.style.display = 'block';
      
      if (xhr.status === 200) {
        successAlert.style.display = 'block';
        document.getElementById('res-total').textContent = data.successfulRows;
        document.getElementById('res-time').textContent = data.processingTimeMs;
        
        const vRes = await fetch('/api/version');
        const vData = await vRes.json();
        
        document.getElementById('res-version').textContent = vData.catalogVersion;
        
        if (vData.lastCatalogUpload) {
          const d = new Date(vData.lastCatalogUpload);
          document.getElementById('res-date').textContent = d.toLocaleString('en-GB');
        } else {
          document.getElementById('res-date').textContent = 'N/A';
        }
        
        // Clear file input
        fileInput.value = '';
        fileNameLabel.textContent = 'No file selected';
        uploadBtn.disabled = true;
        
        updateStatusPanel();
      } else if (xhr.status === 401 || xhr.status === 403) {
        localStorage.removeItem('admin_token');
        window.location.href = '/admin';
      } else {
        failureAlert.style.display = 'block';
        failureMsg.textContent = data.message || 'Upload rejected due to validation errors.';
        
        if (data.errors && data.errors.length > 0) {
          data.errors.forEach(err => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td>${err.row}</td>
              <td class="monospace">${err.barcode}</td>
              <td>${err.name}</td>
              <td class="text-danger">${err.error}</td>
            `;
            errorLogsBody.appendChild(tr);
          });
          
          const hRes = await fetch('/api/admin/upload-history', {
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('admin_token') }
          });
          const hData = await hRes.json();
          if (hData && hData.length > 0) {
            const latestFailed = hData.find(run => run.filename === uploadFilename && run.status === 'Failed');
            if (latestFailed) {
              errorsReportLink.style.display = 'inline-block';
              downloadErrorsBtn.href = `/api/admin/upload-errors/${latestFailed.id}`;
              
              // Proxy event download
              downloadErrorsBtn.onclick = async (btnEvt) => {
                btnEvt.preventDefault();
                try {
                  const dlRes = await fetch(`/api/admin/upload-errors/${latestFailed.id}`, {
                    headers: { 'Authorization': 'Bearer ' + localStorage.getItem('admin_token') }
                  });
                  if (dlRes.status === 200) {
                    const blob = await dlRes.blob();
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `upload_errors_${latestFailed.id}.csv`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                  }
                } catch (dlErr) {
                  console.error('Failed to download error CSV', dlErr);
                }
              };
            }
          }
        }
      }
    });
    
    xhr.addEventListener('error', () => {
      progressContainer.style.display = 'none';
      uploadBtn.disabled = false;
      resultContainer.style.display = 'block';
      failureAlert.style.display = 'block';
      failureMsg.textContent = 'A network error occurred during upload.';
    });
    
    xhr.open('POST', '/api/admin/upload');
    xhr.setRequestHeader('Authorization', 'Bearer ' + localStorage.getItem('admin_token'));
    xhr.send(formData);
    
  } catch (err) {
    progressContainer.style.display = 'none';
    uploadBtn.disabled = false;
    resultContainer.style.display = 'block';
    failureAlert.style.display = 'block';
    failureMsg.textContent = 'Upload submission failed.';
  }
});

// Handle logout
logoutBtn.addEventListener('click', () => {
  localStorage.removeItem('admin_token');
  localStorage.removeItem('admin_username');
  window.location.href = '/admin';
});

updateStatusPanel();
