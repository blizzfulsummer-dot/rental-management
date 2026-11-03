import { resolveApiBase, createApiClient } from './core/api.js';
import { setButtonBusy, withButtonLoading } from './core/ui.js';
import { createAuthSession } from './features/auth/session.js';
import { initSignupFeature } from './features/auth/signup.js';
import { showToast } from './core/toast.js';
import { createDeviceFeature } from './features/devices/index.js';
import { createDashboardDataFeature } from './features/dashboard/data.js';
import { createPropertyFeature } from './features/properties/index.js';
import { createAccountFeature } from './features/accounts/index.js';
import { createDashboardViews } from './features/dashboard/views.js';
import { createDashboardPresentation } from './features/dashboard/presentation.js';
import { createAuditLogFeature } from './features/dashboard/audit.js';
import { initPasswordResetFeature } from './features/auth/password-reset.js';

const API_BASE = resolveApiBase();
const WS_BASE = API_BASE.replace(/^http/, 'ws');

// Shared session and dashboard state.
const state = {
  // Keep the access token in memory and persist it with the refresh token
  // so a normal browser reload does not sign the user out.
  jwt: (() => {
    try {
      return localStorage.getItem('accessToken') || '';
    } catch {
      return '';
    }
  })(),
  profile: null,
  role: null,
  houses: [],
  tenants: [],
  accounts: [],
  selectedHouseId: null,
  devices: [],
  fingerprints: {},
  provisionableUsers: [],
  deviceAccess: {},
  ws: null,
  activeView: 'overview',
};

const loginScreen = document.getElementById('loginScreen');
const dashboardScreen = document.getElementById('dashboardScreen');
const loginAlert = document.getElementById('loginAlert');
const passwordAlert = document.getElementById('passwordAlert');
const mainPanelContent = document.getElementById('mainPanelContent');
const profilePanel = document.getElementById('profilePanel');
const statsGrid = document.getElementById('statsGrid');
const userDisplayName = document.getElementById('userDisplayName');
const workspaceTitle = document.getElementById('workspaceTitle');
const userRole = document.getElementById('userRole');
const mainPanelTitle = document.getElementById('mainPanelTitle');
const viewTabs = document.getElementById('viewTabs');

function showAlert(element, message, type) {
  element.textContent = message;
  element.className = `alert ${type} show`;
}

function clearAlert(element) {
  element.textContent = '';
  element.className = 'alert';
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  );
}

function formatRole(role) {
  return role ? role.toUpperCase() : 'USER';
}

function renderWelcomeMessage() {
  const profileName = state.profile?.name?.trim();
  const emailName = state.profile?.email?.split('@')[0]?.replace(/[._-]+/g, ' ').trim();
  const name = (profileName || emailName || 'there').split(/\s+/)[0];

  workspaceTitle.textContent = `Hi ${name}!`;
}

function canManageDeviceAccess(device, houses = state.houses) {
  if (state.role === 'admin') return true;
  const house = houses.find(
    (item) => Number(item.id) === Number(device.house_id),
  );
  return (
    state.role === 'owner' &&
    Number(house?.owner_id) === Number(state.profile?.id)
  );
}

function getRoleViews() {
  if (state.role === 'admin' || state.role === 'owner') {
    return ['overview', 'property', 'access', 'tenants', 'devices', 'logs'];
  }
  return ['overview', 'property', 'devices'];
}

function renderViewTabs() {
  const views = getRoleViews();
  const labels = {
    overview: 'Overview',
    property: 'Properties',
    access: 'Property Access',
    tenants: 'Accounts',
    devices: 'Devices',
    logs: 'Activity',
  };

  viewTabs.innerHTML = views
    .map(
      (view) => `
        <button
          type="button"
          class="view-tab ${state.activeView === view ? 'active' : ''}"
          data-view="${view}"
          aria-current="${state.activeView === view ? 'page' : 'false'}"
        >${labels[view]}</button>
      `,
    )
    .join('');

  viewTabs.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => {
      state.activeView = button.dataset.view;
      renderViewTabs();
      renderMainPanel();
    });
  });
}

function navigateToView(view) {
  if (!getRoleViews().includes(view)) return;
  state.activeView = view;
  renderViewTabs();
  renderMainPanel();
  mainPanelTitle.focus({ preventScroll: true });
  mainPanelTitle.scrollIntoView({
    behavior: 'auto',
    block: 'start',
  });
}

function setActiveScreen(screen) {
  loginScreen.classList.toggle('active', screen === 'login');
  dashboardScreen.classList.toggle('active', screen === 'dashboard');
  if (screen === 'dashboard') renderWelcomeMessage();
}

const apiClient = createApiClient({
  apiBase: API_BASE,
  getToken: () => state.jwt,
  setToken: (token) => {
    state.jwt = token;
  },
});
const {
  saveAuthTokens,
  clearAuthTokens,
  refreshAccessToken,
  requestJson,
  getAuthHeaders,
} = apiClient;

// These callbacks are assigned after the dependent features are initialized.
let renderMainPanel = () => {};
let loadDashboardData = async () => {};

// Create features in dependency order, then connect the dashboard renderers.
const propertyFeature = createPropertyFeature({
  state,
  mainPanelContent,
  API_BASE,
  escapeHtml,
  requestJson,
  getAuthHeaders,
  showAlert,
  setButtonBusy,
  withButtonLoading,
  renderMainPanel: () => renderMainPanel(),
  navigateToView,
});
const accountFeature = createAccountFeature({
  state,
  mainPanelContent,
  escapeHtml,
  formatRole,
  showAlert,
  clearAlert,
  setButtonBusy,
  showToast,
  withButtonLoading,
  requestJson,
  API_BASE,
  getAuthHeaders,
  loadDashboardData: () => loadDashboardData(),
});
const deviceFeature = createDeviceFeature({
  state,
  mainPanelContent,
  API_BASE,
  WS_BASE,
  escapeHtml,
  canManageDeviceAccess,
  showAlert,
  requestJson,
  getAuthHeaders,
  setButtonBusy,
  withButtonLoading,
  loadDashboardData: () => loadDashboardData(),
  renderMainPanel: () => renderMainPanel(),
});
const { renderDeviceList } = deviceFeature;
const auditLogFeature = createAuditLogFeature({
  API_BASE,
  requestJson,
  getAuthHeaders,
  mainPanelContent,
  escapeHtml,
  isActiveView: () => state.activeView === 'logs',
});

const dashboardViews = createDashboardViews({
  state,
  mainPanelContent,
  mainPanelTitle,
  escapeHtml,
  renderHouseList: propertyFeature.renderHouseList,
  renderHouseAccess: propertyFeature.renderHouseAccess,
  renderTenantList: accountFeature.renderTenantList,
  renderDeviceList,
  renderAuditLogs: auditLogFeature.renderAuditLogs,
  getRoleViews,
  navigateToView,
});
renderMainPanel = dashboardViews.renderMainPanel;
const dashboardPresentation = createDashboardPresentation({
  state,
  statsGrid,
  profilePanel,
  formatRole,
  escapeHtml,
  getRoleViews,
  navigateToView,
});

const { renderStats, renderProfile } = dashboardPresentation;
const dashboardDataFeature = createDashboardDataFeature({
  state,
  API_BASE,
  getAuthHeaders,
  requestJson,
  canManageDeviceAccess,
  renderStats,
  renderProfile,
  renderViewTabs,
  renderMainPanel: () => renderMainPanel(),
  escapeHtml,
  mainPanelContent,
});
loadDashboardData = dashboardDataFeature.loadDashboardData;
const { cancelPendingLoad } = dashboardDataFeature;

const { openAccountEditor, handleAccountEditor } = accountFeature;

const authSession = createAuthSession({
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
  loginScreen,
  cancelPendingLoad,
});
const {
  handleLogin,
  restoreSession,
  handleLogout,
  handlePasswordUpdate,
  handleRequiredPasswordUpdate,
} = authSession;

// Connect page controls after their feature handlers are ready.
function openAuthDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog && !dialog.open) dialog.showModal();
}

document.getElementById('openSignupBtn').addEventListener('click', () => {
  clearAlert(document.getElementById('signupAlert'));
  openAuthDialog('signupDialog');
});
document.querySelectorAll('[data-close-dialog]').forEach((button) => {
  button.addEventListener('click', () =>
    document.getElementById(button.dataset.closeDialog)?.close(),
  );
});

initSignupFeature({
  API_BASE,
  requestJson,
  setButtonBusy,
  showAlert,
  clearAlert,
  showToast,
});
initPasswordResetFeature({
  API_BASE,
  requestJson,
  setButtonBusy,
  showAlert,
  clearAlert,
  loginAlert,
  openAuthDialog,
});

document.getElementById('loginBtn').addEventListener('click', handleLogin);
document.getElementById('logoutBtn').addEventListener('click', handleLogout);
document.getElementById('refreshBtn').addEventListener('click', async () => {
  state.devices = [];
  state.tenants = [];
  await loadDashboardData();
});
document
  .getElementById('passwordForm')
  .addEventListener('submit', handlePasswordUpdate);
document
  .getElementById('passwordRequiredForm')
  .addEventListener('submit', handleRequiredPasswordUpdate);
document
  .getElementById('passwordRequiredDialog')
  .addEventListener('cancel', (event) => event.preventDefault());

// Restore the saved ReMan session after the page has initialized.
document
  .querySelectorAll('[data-close-account-dialog]')
  .forEach((button) =>
    button.addEventListener('click', () =>
      document.getElementById('accountEditorDialog').close(),
    ),
  );
document
  .getElementById('accountEditorForm')
  .addEventListener('submit', handleAccountEditor);

restoreSession();

document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && loginScreen.classList.contains('active')) {
    handleLogin();
  }
});
