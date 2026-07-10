(function() {
  const token = localStorage.getItem('admin_token');
  const isLoginPage = window.location.pathname === '/admin' || window.location.pathname.endsWith('login.html');
  
  if (!token && !isLoginPage) {
    window.location.href = '/admin';
  } else if (token && isLoginPage) {
    window.location.href = '/admin/upload';
  }
})();

function getAuthHeaders() {
  const token = localStorage.getItem('admin_token');
  return {
    'Authorization': 'Bearer ' + token
  };
}

async function authenticatedFetch(url, options = {}) {
  options.headers = options.headers || {};
  const authHeaders = getAuthHeaders();
  Object.assign(options.headers, authHeaders);
  
  const response = await fetch(url, options);
  if (response.status === 401 || response.status === 403) {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_username');
    window.location.href = '/admin';
    return null;
  }
  return response;
}
