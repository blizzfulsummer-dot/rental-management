import { applyPasswordRequirement } from './password-policy.js';

export function createAuthSession(deps) {
  const {
    API_BASE,
    requestJson,
    saveAuthTokens,
    clearAuthTokens,
    refreshAccessToken,
    getAuthHeaders,
    setButtonBusy,
    showAlert,
    clearAlert,
    loginAlert,
    passwordAlert,
    state,
    renderViewTabs,
    setActiveScreen,
    userDisplayName,
    userRole,
    formatRole,
    loadDashboardData,
    cancelPendingLoad = () => {}
  } = deps;

  async function handleLogin() {
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const loginBtn = document.getElementById('loginBtn');

    if (!email || !password) {
      showAlert(loginAlert, 'Email and password are required.', 'error');
      return;
    }

    setButtonBusy(loginBtn, true, 'Signing in…');
    clearAlert(loginAlert);
    document.getElementById('forgotPasswordLink').hidden = true;

    try {
      const loginResponse = await requestJson(`${API_BASE}/api/login`, {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });

      if (!loginResponse.accessToken) {
        throw new Error('The login response did not include an access token.');
      }

      saveAuthTokens(loginResponse.accessToken, loginResponse.refreshToken);

      const mustChangePassword =
        loginResponse.requiresChangePassword === true ||
        loginResponse.requires_change_password === true ||
        Number(loginResponse.requires_change_password) === 1;

      if (mustChangePassword) {
        state.profile = {
  name: loginResponse.user?.name || '',
  email: loginResponse.user?.email || email,
  role: loginResponse.user?.role || 'user',
  requires_change_password: true
};

state.role = String(state.profile.role).toLowerCase();

userDisplayName.textContent = state.profile.name || state.profile.email || 'User';
userRole.textContent = formatRole(state.role);

        try {
          localStorage.setItem('pendingPasswordChange', 'true');
        } catch {}

        document.getElementById('requiredCurrentPassword').value = password;
        document.getElementById('passwordRequiredDialog').showModal();
        return;
      }

      const meData = await requestJson(`${API_BASE}/api/me`, {
        method: 'GET',
        headers: getAuthHeaders()
      });

      if (!meData?.user) {
        throw new Error('Could not load user profile');
      }

      const requiresChange = applyPasswordRequirement(meData.user);

      state.profile = {
        ...meData.user,
        requires_change_password: requiresChange
      };

      state.role = String(meData.user.role || 'user').toLowerCase();
      state.activeView = 'overview';

      try {
        localStorage.setItem('userProfile', JSON.stringify(meData.user));
        localStorage.setItem('portalRole', state.role);
      } catch {}

      userDisplayName.textContent = meData.user.name || meData.user.email || 'User';
      userRole.textContent = formatRole(state.role);

      renderViewTabs();
      setActiveScreen('dashboard');

      if (requiresChange) {
        try {
          localStorage.setItem('pendingPasswordChange', 'true');
        } catch {}

        document.getElementById('passwordRequiredDialog').showModal();
        return;
      }

      clearAlert(passwordAlert);
      await loadDashboardData();
    } catch (error) {
      showAlert(loginAlert, error.message || 'Login failed.', 'error');

      // Both unknown emails and wrong passwords return the same 401 response.
      // Show the reset entry point for either case without revealing whether
      // the account exists. The reset endpoint also returns a generic response.
      const recoveryAllowed = error.status === 401;

      const recoveryLink = document.getElementById('forgotPasswordLink');
      recoveryLink.hidden = !recoveryAllowed;

      if (recoveryAllowed) {
        document.getElementById('resetEmail').value = email;
      }
    } finally {
      setButtonBusy(loginBtn, false);
    }
  }

  async function restoreSession() {
    let refreshToken = '';
    let pendingPasswordChange = false;

    try {
      refreshToken = localStorage.getItem('refreshToken') || '';
      pendingPasswordChange =
        localStorage.getItem('pendingPasswordChange') === 'true';
    } catch {}

    if (!state.jwt && !refreshToken) return;

    try {
      if (!state.jwt && refreshToken) {
        const refreshed = await refreshAccessToken();
        if (!refreshed) return;
      }

      if (pendingPasswordChange) {
        state.profile = { requires_change_password: true };
        state.role = 'user';

        document.getElementById('requiredCurrentPassword').value = '';
        setActiveScreen('login');
        document.getElementById('passwordRequiredDialog').showModal();
        return;
      }

      const meData = await requestJson(`${API_BASE}/api/me`, {
        method: 'GET',
        headers: getAuthHeaders()
      });

      if (!meData?.user) {
        throw new Error('Could not restore the ReMan user profile.');
      }

      const requiresChange = applyPasswordRequirement(meData.user);

      state.profile = {
        ...meData.user,
        requires_change_password: requiresChange
      };

      state.role = String(meData.user.role || 'user').toLowerCase();
      state.activeView = 'overview';

      try {
        localStorage.setItem('userProfile', JSON.stringify(meData.user));
        localStorage.setItem('portalRole', state.role);
      } catch {}

      userDisplayName.textContent = meData.user.name || meData.user.email || 'User';
      userRole.textContent = formatRole(state.role);

      renderViewTabs();
      setActiveScreen('dashboard');

      if (requiresChange) {
        try {
          localStorage.setItem('pendingPasswordChange', 'true');
        } catch {}

        document.getElementById('passwordRequiredDialog').showModal();
        return;
      }

      await loadDashboardData();
    } catch (error) {
      console.warn('Could not restore ReMan session:', error);

      let remainingRefreshToken = '';

      try {
        remainingRefreshToken = localStorage.getItem('refreshToken') || '';
      } catch {}

      if (error.status === 401 && !remainingRefreshToken) {
        clearAuthTokens();
      }

      setActiveScreen('login');
    }
  }

  async function handleLogout() {
    cancelPendingLoad();
    clearAuthTokens();

    try {
      localStorage.removeItem('pendingPasswordChange');
    } catch {}

    state.profile = null;
    state.role = null;
    state.houses = [];
    state.tenants = [];
    state.accounts = [];
    state.devices = [];
    state.fingerprints = {};
    state.deviceAccess = {};
    state.provisionableUsers = [];
    state.selectedHouseId = null;
    state.activeView = 'overview';

    clearAlert(loginAlert);
    clearAlert(passwordAlert);
    setActiveScreen('login');
  }

  async function handlePasswordUpdate(event) {
    event.preventDefault();

    const oldPassword = document.getElementById('oldPassword').value;
    const newPassword = document.getElementById('newPassword').value;

    if (!oldPassword || !newPassword) {
      showAlert(passwordAlert, 'Both current and new password are required.', 'error');
      return;
    }

    try {
      const result = await requestJson(`${API_BASE}/api/update_password`, {
        method: 'POST',
        body: JSON.stringify({
          token: state.jwt,
          oldPassword,
          newPassword
        })
      });

      showAlert(passwordAlert, result.message || 'Password updated successfully.', 'success');

      state.activeView = 'overview';
      renderViewTabs();
      setActiveScreen('dashboard');

      await loadDashboardData();

      document.getElementById('oldPassword').value = '';
      document.getElementById('newPassword').value = '';
    } catch (error) {
      showAlert(passwordAlert, error.message || 'Password update failed.', 'error');
    }
  }

  
async function handleRequiredPasswordUpdate(event) {
  event.preventDefault();

  const currentPassword =
    document.getElementById('requiredCurrentPassword').value;

  const newPassword =
    document.getElementById('requiredNewPassword').value;

  const confirmPassword =
    document.getElementById('requiredConfirmPassword').value;

  const submitButton =
    document.getElementById('passwordRequiredSubmit');

  const alert =
    document.getElementById('passwordRequiredAlert');

  if (newPassword !== confirmPassword) {
    showAlert(alert, 'The new passwords do not match.', 'error');
    return;
  }

  if (newPassword === currentPassword) {
    showAlert(
      alert,
      'Choose a password different from your current password.',
      'error'
    );
    return;
  }

  const originalButtonText = submitButton.textContent;

  submitButton.disabled = true;
  submitButton.textContent = 'Updating password...';

  try {
    const result = await requestJson(`${API_BASE}/api/update_password`, {
      method: 'POST',
      body: JSON.stringify({
        token: state.jwt,
        oldPassword: currentPassword,
        newPassword
      })
    });

    // Fetch the updated user profile
    const meData = await requestJson(`${API_BASE}/api/me`, {
      method: 'GET',
      headers: getAuthHeaders()
    });

    if (!meData?.user) {
      throw new Error('Could not load your updated user profile.');
    }

    state.profile = {
      ...meData.user,
      requires_change_password: false
    };

    state.role = String(meData.user.role || 'user').toLowerCase();

    userDisplayName.textContent =
      meData.user.name || meData.user.email || 'User';

    userRole.textContent = formatRole(state.role);

    try {
      localStorage.setItem('userProfile', JSON.stringify(meData.user));
      localStorage.setItem('portalRole', state.role);
      localStorage.removeItem('pendingPasswordChange');
    } catch {}

    // Clear old dashboard state
    state.houses = [];
    state.tenants = [];
    state.accounts = [];
    state.devices = [];
    state.fingerprints = {};
    state.deviceAccess = {};
    state.provisionableUsers = [];
    state.selectedHouseId = null;

    state.activeView = 'overview';

    // Keep the modal open while preparing the dashboard
    renderViewTabs();
    setActiveScreen('dashboard');

    submitButton.textContent = 'Loading dashboard...';

    showAlert(
      alert,
      result.message || 'Password updated successfully. Preparing your dashboard...',
      'success'
    );

    // Wait for dashboard data
    await loadDashboardData();

    // Close modal only after dashboard loading
    document.getElementById('passwordRequiredDialog').close();
    document.getElementById('passwordRequiredForm').reset();

  } catch (error) {
    showAlert(
      alert,
      error.message || 'Password update failed.',
      'error'
    );
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = originalButtonText;
  }
}


  return {
    handleLogin,
    restoreSession,
    handleLogout,
    handlePasswordUpdate,
    handleRequiredPasswordUpdate
  };
}