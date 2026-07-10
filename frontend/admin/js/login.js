document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const usernameInput = document.getElementById('username').value.trim();
  const passwordInput = document.getElementById('password').value;
  const errorDiv = document.getElementById('error-message');
  
  errorDiv.style.display = 'none';
  errorDiv.textContent = '';
  
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: usernameInput, password: passwordInput })
    });
    
    const data = await res.json();
    
    if (res.status === 200) {
      localStorage.setItem('admin_token', data.token);
      localStorage.setItem('admin_username', usernameInput);
      window.location.href = '/admin/upload';
    } else {
      errorDiv.textContent = data.message || 'Invalid username or password.';
      errorDiv.style.display = 'block';
    }
  } catch (err) {
    errorDiv.textContent = 'Network error. Please try again.';
    errorDiv.style.display = 'block';
  }
});
