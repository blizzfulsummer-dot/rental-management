export function resolveApiBase() {
  const host = window.location.hostname;
  const origin = window.location.origin;
  const cloudApi = 'https://reman.ehexibit.com';
  const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (window.location.protocol === 'file:') return cloudApi;
  if (isLocalHost && window.location.port === '8787') return origin;
  if (isLocalHost || host === 'reman.ehexibit.com') return cloudApi;
  return origin;
}

export function createApiClient({ apiBase, getToken, setToken }) {
  let refreshInFlight = null;
  function saveAuthTokens(accessToken, refreshToken) {
    if (accessToken) setToken(accessToken);
    try {
      if (accessToken) localStorage.setItem('accessToken', accessToken);
      if (refreshToken) localStorage.setItem('refreshToken', refreshToken);
    } catch (error) { console.warn('Unable to persist ReMan authentication tokens:', error); }
  }
  function clearAuthTokens() {
    setToken('');
    try {
      localStorage.removeItem('accessToken'); localStorage.removeItem('refreshToken');
      localStorage.removeItem('userProfile'); localStorage.removeItem('portalRole');
    } catch (error) { console.warn('Unable to clear ReMan authentication tokens:', error); }
  }
  async function refreshAccessToken() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      let refreshToken = '';
      try { refreshToken = localStorage.getItem('refreshToken') || ''; } catch {}
      if (!refreshToken) return false;
      try {
        const response = await fetch(`${apiBase}/api/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.accessToken) {
          if (response.status === 401 || response.status === 403) clearAuthTokens();
          return false;
        }
        saveAuthTokens(data.accessToken, data.refreshToken); return true;
      } catch (error) { console.warn('ReMan token refresh failed; keeping the saved session:', error); return false; }
    })();
    try { return await refreshInFlight; } finally { refreshInFlight = null; }
  }
  async function requestJson(url, options = {}) {
    const requestOptions = { ...options };
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1_000, options.timeoutMs) : 20_000;
    delete requestOptions.timeoutMs;
    const originalHeaders = { ...(options.headers || {}) };
    const send = async headers => {
      const controller = new AbortController();
      const externalSignal = requestOptions.signal;
      const abortFromCaller = () => controller.abort(externalSignal.reason);
      if (externalSignal?.aborted) abortFromCaller();
      else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
      const timeout = window.setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
      try {
        return await fetch(url, {
          ...requestOptions,
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...headers }
        });
      } finally {
        window.clearTimeout(timeout);
        externalSignal?.removeEventListener('abort', abortFromCaller);
      }
    };
    let response = await send(originalHeaders);
    const isAuthEndpoint = /\/api\/(login|refresh)$/.test(String(url));
    const hasBearer = Boolean(originalHeaders.Authorization || originalHeaders.authorization);
    if (response.status === 401 && hasBearer && !isAuthEndpoint && await refreshAccessToken()) {
      const retryHeaders = { ...originalHeaders }; delete retryHeaders.authorization; retryHeaders.Authorization = `Bearer ${getToken()}`;
      response = await send(retryHeaders);
    }
    const bodyText = await response.text(); let data = {};
    if (bodyText) {
      try { data = JSON.parse(bodyText); }
      catch {
        const error = new Error(response.ok ? 'The server returned an invalid response.' : `Request failed (${response.status}). Check the API server and try again.`);
        error.status = response.status; throw error;
      }
    }
    if (!response.ok) {
      const detailText = Array.isArray(data.details) && data.details.length ? `: ${data.details.map(item => typeof item === 'string' ? item : (item.message || item.field || JSON.stringify(item))).join('; ')}` : '';
      const error = new Error(`${data.error || data.message || `Request failed (${response.status})`}${detailText}`);
      error.status = response.status; error.details = data.details || null; error.code = data.code || data.errorCode || '';
      error.emailActive = data.emailActive === true || data.email_active === true; throw error;
    }
    return data;
  }
  function getAuthHeaders() { return { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' }; }
  return { saveAuthTokens, clearAuthTokens, refreshAccessToken, requestJson, getAuthHeaders };
}
