const API_URLS = [
  'https://api.ehexibit.com/api',
  'https://rental-management-api.iot-exhibit.workers.dev/api'
];

const STORAGE_KEYS = {
  accessToken: 'accessToken',
  refreshToken: 'refreshToken'
};

function getAccessToken() {
  return localStorage.getItem(STORAGE_KEYS.accessToken);
}

function getRefreshToken() {
  return localStorage.getItem(STORAGE_KEYS.refreshToken);
}

function setAuthData(data) {
  if (data.accessToken) {
    localStorage.setItem(STORAGE_KEYS.accessToken, data.accessToken);
  }
  if (data.refreshToken) {
    localStorage.setItem(STORAGE_KEYS.refreshToken, data.refreshToken);
  }
}

function clearAuth() {
  localStorage.removeItem(STORAGE_KEYS.accessToken);
  localStorage.removeItem(STORAGE_KEYS.refreshToken);
}

function isAuthenticated() {
  return Boolean(getAccessToken());
}

function showLoading() {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) {
    overlay.classList.add('show');
  }
}

function hideLoading() {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) {
    overlay.classList.remove('show');
  }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) {
    return;
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 3200);
}

function showConfirmModal(options) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  overlay.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <h3 id="modal-title">${options.title}</h3>
      <p>${options.message}</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" data-action="cancel">${options.cancelText || 'Cancel'}</button>
        <button class="btn btn-danger" data-action="confirm">${options.confirmText || 'Confirm'}</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    overlay.remove();
    options.onCancel?.();
  });

  overlay.querySelector('[data-action="confirm"]').addEventListener('click', () => {
    overlay.remove();
    options.onConfirm?.();
  });
}

function showPromptModal(options) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  overlay.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="prompt-title">
      <h3 id="prompt-title">${options.title}</h3>
      <label for="promptInput">${options.label}</label>
      <input id="promptInput" type="${options.type || 'text'}" placeholder="${options.placeholder || ''}" />
      <div class="modal-actions">
        <button class="btn btn-secondary" data-action="cancel">Cancel</button>
        <button class="btn btn-primary" data-action="confirm">${options.confirmText || 'Continue'}</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const input = overlay.querySelector('#promptInput');

  overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    overlay.remove();
  });

  overlay.querySelector('[data-action="confirm"]').addEventListener('click', () => {
    const value = input.value.trim();
    overlay.remove();
    options.onConfirm?.(value);
  });
}

async function requestJson(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (!options.skipAuth && getAccessToken()) {
    headers.Authorization = `Bearer ${getAccessToken()}`;
  }

  let lastError;

  for (const baseUrl of API_URLS) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: options.method || 'GET',
        headers,
        body: options.body || undefined
      });

      const raw = await response.text();
      let data = null;

      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
      }

      if (!response.ok) {
        const message = data?.error || data?.message || `Request failed with ${response.status}`;
        if (response.status === 401 && !options.skipAuth && getRefreshToken()) {
          const refreshed = await refreshAccessToken();
          if (refreshed) {
            return requestJson(path, options);
          }
        }
        throw new Error(message);
      }

      return { response, data };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Unable to reach the API.');
}

async function refreshAccessToken() {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    clearAuth();
    return false;
  }

  try {
    const { data } = await requestJson('/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
      skipAuth: true
    });

    if (data?.accessToken) {
      setAuthData(data);
      return true;
    }
  } catch {
    clearAuth();
  }

  return false;
}

async function verifySession() {
  const token = getAccessToken();
  if (!token) {
    return false;
  }

  try {
    const { response } = await requestJson('/me', { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}

async function submitLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const messageBox = document.getElementById('message');

  if (!email || !password) {
    messageBox.className = 'message error';
    messageBox.textContent = 'Please enter both email and password.';
    return;
  }

  button.disabled = true;
  showLoading();

  try {
    const { data } = await requestJson('/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      skipAuth: true
    });

    if (!data?.accessToken) {
      throw new Error(data?.error || 'Login failed.');
    }

    setAuthData(data);
    messageBox.className = 'message success';
    messageBox.textContent = 'Login successful. Redirecting…';
    showToast('Login successful', 'success');
    window.setTimeout(() => {
      window.location.href = 'dashboard.html';
    }, 700);
  } catch (error) {
    messageBox.className = 'message error';
    messageBox.textContent = error.message || 'Login failed. Please try again.';
    showToast(error.message || 'Login failed', 'error');
  } finally {
    hideLoading();
    button.disabled = false;
  }
}

function initAuthPage() {
  const form = document.getElementById('loginForm');
  const messageBox = document.getElementById('message');

  if (!form) {
    return;
  }

  form.addEventListener('submit', submitLogin);

  if (isAuthenticated()) {
    verifySession().then((valid) => {
      if (valid) {
        window.location.replace('dashboard.html');
      } else {
        clearAuth();
        if (messageBox) {
          messageBox.className = 'message error';
          messageBox.textContent = 'Your session expired. Please sign in again.';
        }
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', initAuthPage);
