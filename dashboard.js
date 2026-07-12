const app = document.getElementById('app');

let tenantFilter = '';

const state = {
  homes: [
    { id: 1, name: 'Main House' },
    { id: 2, name: 'Beach Villa' }
  ],
  devices: [
    { id: 1, homeId: 1, name: 'Living Room Light', pin: 15 },
    { id: 2, homeId: 2, name: 'Pool Light', pin: 4 }
  ],
  tenants: []
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderDashboard() {
  app.innerHTML = `
    <section class="stats">
      <div class="stat">
        <span class="label">Devices</span>
        <strong>${state.devices.length}</strong>
      </div>
      <div class="stat">
        <span class="label">Tenants</span>
        <strong>${state.tenants.length}</strong>
      </div>
      <div class="stat">
        <span class="label">Income</span>
        <strong>₱4,500</strong>
      </div>
    </section>

    <section class="dashboard-grid">
      <div class="dashboard-card" onclick="renderTenantForm()">
        <h3>Register account</h3>
        <p>Create a tenant, user, or admin profile.</p>
      </div>
      <div class="dashboard-card" onclick="renderTenantView()">
        <h3>Tenant view</h3>
        <p>Browse a modern tenant directory with quick details.</p>
      </div>
      <div class="dashboard-card" onclick="renderIOT()">
        <h3>Smart home</h3>
        <p>Monitor installed devices and toggles.</p>
      </div>
      <div class="dashboard-card" onclick="renderSettings()">
        <h3>Smart settings</h3>
        <p>Manage homes, devices, and preferences.</p>
      </div>
    </section>

    <section class="charts">
      <div class="card">
        <canvas id="incomeChart"></canvas>
      </div>
      <div class="card">
        <canvas id="trendChart"></canvas>
      </div>
    </section>
  `;

  const incomeChart = document.getElementById('incomeChart');
  const trendChart = document.getElementById('trendChart');

  if (incomeChart && window.Chart) {
    new window.Chart(incomeChart, {
      type: 'pie',
      data: {
        labels: ['Income', 'Expenses'],
        datasets: [{ data: [4500, 1800], backgroundColor: ['#6366f1', '#c7d2fe'] }]
      },
      options: { plugins: { legend: { position: 'bottom' } } }
    });
  }

  if (trendChart && window.Chart) {
    new window.Chart(trendChart, {
      type: 'bar',
      data: {
        labels: ['Jan', 'Feb', 'Mar'],
        datasets: [
          { label: 'Income', data: [4000, 4300, 4500], backgroundColor: '#6366f1' },
          { label: 'Expenses', data: [1500, 1700, 1800], backgroundColor: '#a5b4fc' }
        ]
      },
      options: { responsive: true, plugins: { legend: { position: 'top' } } }
    });
  }
}

function renderIOT() {
  app.innerHTML = `
    <div class="nav-back" onclick="renderDashboard()">← Back</div>
    <div class="grid">
      ${state.devices.map((device) => `
        <div class="device-card">
          <h3>${escapeHtml(device.name)}</h3>
          <p>Pin ${device.pin}</p>
          <div class="toggle active"></div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderSettings() {
  app.innerHTML = `
    <div class="nav-back" onclick="renderDashboard()">← Back</div>

    <section class="panel">
      <h3>Homes</h3>
      ${state.homes.length ? `
        <div class="table-wrapper">
          <table>
            <thead>
              <tr><th>Name</th><th>Actions</th></tr>
            </thead>
            <tbody>
              ${state.homes.map((home) => `
                <tr>
                  <td>${escapeHtml(home.name)}</td>
                  <td>
                    <div class="row-actions">
                      <button class="btn btn-secondary" onclick="renderEditHome(${home.id})">Edit</button>
                      <button class="btn btn-danger" onclick="deleteHome(${home.id})">Delete</button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="empty-state">No homes yet.</div>'}

      <div class="form-row" style="margin-top:1rem;">
        <input id="homeName" placeholder="Home name" />
        <button class="btn btn-primary" onclick="addHome()">Add home</button>
      </div>
    </section>

    <section class="panel">
      <h3>Devices</h3>
      ${state.devices.length ? `
        <div class="table-wrapper">
          <table>
            <thead>
              <tr><th>Name</th><th>Pin</th><th>Actions</th></tr>
            </thead>
            <tbody>
              ${state.devices.map((device) => `
                <tr>
                  <td>${escapeHtml(device.name)}</td>
                  <td>${device.pin}</td>
                  <td>
                    <div class="row-actions">
                      <button class="btn btn-secondary" onclick="renderEditDevice(${device.id})">Edit</button>
                      <button class="btn btn-danger" onclick="deleteDevice(${device.id})">Delete</button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="empty-state">No devices yet.</div>'}

      <div class="form-row" style="margin-top:1rem;">
        <select id="devHome">
          ${state.homes.map((home) => `<option value="${home.id}">${escapeHtml(home.name)}</option>`).join('')}
        </select>
        <input id="devName" placeholder="Device name" />
        <input id="devPin" type="number" placeholder="Pin" />
        <button class="btn btn-primary" onclick="addDevice()">Add device</button>
      </div>
    </section>
  `;
}

function addHome() {
  const input = document.getElementById('homeName');
  const name = input?.value.trim();
  if (!name) {
    showToast('Please enter a home name.', 'error');
    return;
  }
  state.homes.push({ id: Date.now(), name });
  renderSettings();
  showToast('Home added.', 'success');
}

function addDevice() {
  const homeId = Number(document.getElementById('devHome')?.value);
  const name = document.getElementById('devName')?.value.trim();
  const pin = Number(document.getElementById('devPin')?.value);

  if (!homeId || !name || !pin) {
    showToast('Please complete all device fields.', 'error');
    return;
  }

  state.devices.push({ id: Date.now(), homeId, name, pin });
  renderSettings();
  showToast('Device added.', 'success');
}

function deleteHome(id) {
  showConfirmModal({
    title: 'Delete home',
    message: 'Delete this home and all devices linked to it?',
    confirmText: 'Delete',
    onConfirm: () => {
      state.homes = state.homes.filter((home) => home.id !== id);
      state.devices = state.devices.filter((device) => device.homeId !== id);
      renderSettings();
      showToast('Home deleted.', 'success');
    }
  });
}

function deleteDevice(id) {
  showConfirmModal({
    title: 'Delete device',
    message: 'Delete this device permanently?',
    confirmText: 'Delete',
    onConfirm: () => {
      state.devices = state.devices.filter((device) => device.id !== id);
      renderSettings();
      showToast('Device deleted.', 'success');
    }
  });
}

function getFilteredTenants() {
  const query = tenantFilter.toLowerCase();
  return state.tenants.filter((tenant) => {
    if (!query) return true;
    return `${tenant.name || ''} ${tenant.email || ''} ${tenant.role || ''}`.toLowerCase().includes(query);
  });
}

function renderTenantResults() {
  const filteredTenants = getFilteredTenants();
  const resultsContainer = document.getElementById('tenantResults');
  const statsContainer = document.getElementById('tenantStats');

  if (statsContainer) {
    statsContainer.innerHTML = `
      <div class="tenant-stat">
        <span>Active tenants</span>
        <strong>${filteredTenants.length}</strong>
      </div>
      <div class="tenant-stat">
        <span>Rent value</span>
        <strong>₱${filteredTenants.reduce((sum, tenant) => sum + (Number(tenant.rent_amount) || 0), 0)}</strong>
      </div>
      <div class="tenant-stat">
        <span>Outstanding balance</span>
        <strong>₱${filteredTenants.reduce((sum, tenant) => sum + (Number(tenant.balance) || 0), 0)}</strong>
      </div>
    `;
  }

  if (resultsContainer) {
    resultsContainer.innerHTML = filteredTenants.length ? `
      <div class="tenant-grid">
        ${filteredTenants.map((tenant) => `
          <article class="tenant-card">
            <div class="tenant-card-head">
              <h4>${escapeHtml(tenant.name || 'Unnamed tenant')}</h4>
              <span class="tenant-badge">${escapeHtml(tenant.role || 'Tenant')}</span>
            </div>
            <div class="tenant-meta">
              <span>📧 ${escapeHtml(tenant.email || '-')}</span>
              <span>📅 Onboarded ${escapeHtml(tenant.onboard_date || '—')}</span>
              <span>🏠 Lease unit ${escapeHtml(tenant.leased_unit || '—')}</span>
            </div>
            <div class="tenant-footer">
              <div>
                <div class="helper-text">Rent</div>
                <div class="tenant-amount">₱${Number(tenant.rent_amount || 0)}</div>
              </div>
              <div class="row-actions">
                <button class="btn btn-secondary" onclick="renderEditTenant(${tenant.id})">Edit</button>
                <button class="btn btn-danger" onclick="deleteTenant(${tenant.id})">Delete</button>
              </div>
            </div>
          </article>
        `).join('')}
      </div>
    ` : '<div class="empty-state">No matching tenants found.</div>';
  }
}

function filterTenantView() {
  tenantFilter = document.getElementById('tenantSearch')?.value.trim().toLowerCase() || '';
  renderTenantResults();
}

function renderTenantView() {
  app.innerHTML = `
    <div class="nav-back" onclick="renderDashboard()">← Back</div>
    <section class="tenant-view">
      <div class="hero-panel">
        <div>
          <h3>Tenant directory</h3>
          <p>Track tenant activity, balances, and onboarding details in one place.</p>
        </div>
        <div class="tenant-search">
          <input id="tenantSearch" placeholder="Search by name, email, or role" value="${escapeHtml(tenantFilter)}" oninput="filterTenantView()" />
        </div>
      </div>

      <div id="tenantStats" class="tenant-stats"></div>
      <div id="tenantResults"></div>
    </section>
  `;

  renderTenantResults();
}

function renderTenantForm() {
  app.innerHTML = `
    <div class="nav-back" onclick="renderDashboard()">← Back</div>
    <section class="modern-form">
      <div class="form-hero">
        <h3>Create a new account</h3>
        <p>Set up a tenant, user, or admin profile with a smoother modern experience.</p>
      </div>

      <div class="form-section">
        <div class="form-section-title">Account type</div>
        <div class="radio-group">
          <label class="radio-pill"><input type="radio" name="role" value="Tenant" checked /> Tenant</label>
          <label class="radio-pill"><input type="radio" name="role" value="User" /> User</label>
          <label class="radio-pill"><input type="radio" name="role" value="Admin" /> Admin</label>
        </div>
      </div>

      <div class="form-section">
        <div class="form-section-title">Basic details</div>
        <div class="field-group">
          <label class="field-label" for="tName">Name</label>
          <div class="input-shell">
            <input id="tName" placeholder="Full name" />
          </div>
        </div>

        <div class="field-group">
          <label class="field-label" for="tEmail">Email</label>
          <div class="input-shell">
            <input id="tEmail" type="email" placeholder="you@example.com" />
          </div>
        </div>
      </div>

      <div id="tenant-fields" class="form-section" style="display:none;">
        <div class="form-section-title">Tenant-specific details</div>
        <div class="form-row">
          <div class="field-group">
            <label class="field-label" for="rent_amount">Rent amount</label>
            <div class="input-shell">
              <input id="rent_amount" type="number" placeholder="Rent amount" />
            </div>
          </div>
          <div class="field-group">
            <label class="field-label" for="deposit">Deposit</label>
            <div class="input-shell">
              <input id="deposit" type="number" placeholder="Deposit" />
            </div>
          </div>
        </div>
        <div class="form-row">
          <div class="field-group">
            <label class="field-label" for="balance">Balance</label>
            <div class="input-shell">
              <input id="balance" type="number" placeholder="Balance" />
            </div>
          </div>
          <div class="field-group">
            <label class="field-label" for="lease_unit">Lease unit</label>
            <div class="input-shell">
              <input id="lease_unit" placeholder="Lease unit" />
            </div>
          </div>
        </div>
        <div class="field-group">
          <label class="field-label" for="onboard_date">Onboard date</label>
          <div class="input-shell">
            <input id="onboard_date" type="date" />
          </div>
        </div>
        <div class="field-group">
          <label class="field-label">Billing cycle</label>
          <div class="radio-group">
            <label class="radio-pill"><input type="radio" name="billing_cycle" value="daily" /> Daily</label>
            <label class="radio-pill"><input type="radio" name="billing_cycle" value="weekly" /> Weekly</label>
            <label class="radio-pill"><input type="radio" name="billing_cycle" value="monthly" checked /> Monthly</label>
          </div>
        </div>
      </div>

      <div class="form-actions">
        <button class="btn btn-secondary" type="button" onclick="renderDashboard()">Cancel</button>
        <button class="btn btn-primary" type="button" onclick="addTenant()">Create account</button>
      </div>
    </section>
  `;

  setupRoleToggle();
}

function setupRoleToggle() {
  const radios = document.querySelectorAll('input[name="role"]');
  const tenantFields = document.getElementById('tenant-fields');

  const update = () => {
    const role = document.querySelector('input[name="role"]:checked')?.value;
    if (tenantFields) {
      tenantFields.style.display = role === 'Tenant' ? 'block' : 'none';
    }
  };

  radios.forEach((radio) => radio.addEventListener('change', update));
  update();
}

async function addTenant() {
  const role = document.querySelector('input[name="role"]:checked')?.value;
  const name = document.getElementById('tName')?.value.trim();
  const email = document.getElementById('tEmail')?.value.trim();

  if (!role || !name || !email) {
    showToast('Name and email are required.', 'error');
    return;
  }

  const data = { name, email, role: role.toLowerCase() };

  if (role === 'Tenant') {
    const rentAmount = Number(document.getElementById('rent_amount')?.value || 0);
    const depositAmount = Number(document.getElementById('deposit')?.value || 0);
    const balanceAmount = Number(document.getElementById('balance')?.value || 0);
    const onboardDate = document.getElementById('onboard_date')?.value;
    const billingCycle = document.querySelector('input[name="billing_cycle"]:checked')?.value || 'monthly';
    const leaseUnit = document.getElementById('lease_unit')?.value || 'Matanzas';

    if (!rentAmount || !balanceAmount || !onboardDate) {
      showToast('Please fill all tenant-specific fields.', 'error');
      return;
    }

    Object.assign(data, {
      rent_amount: rentAmount,
      deposit: depositAmount,
      balance: balanceAmount,
      onboard_date: onboardDate,
      billing_cycle: billingCycle,
      leased_unit: leaseUnit
    });
  }

  if (role === 'Admin') {
    showPromptModal({
      title: 'Admin registration code',
      label: 'Enter the admin registration code',
      placeholder: 'Registration code',
      onConfirm: async (code) => {
        if (!code) {
          showToast('Admin registration code is required.', 'error');
          return;
        }

        await submitTenantRegistration({ ...data, code });
      }
    });
    return;
  }

  await submitTenantRegistration(data);
}

async function submitTenantRegistration(data) {
  showLoading();
  try {
    const { data: result } = await requestJson('/signup', {
      method: 'POST',
      body: JSON.stringify(data)
    });

    if (result?.error) {
      throw new Error(result.error);
    }

    const message = result?.tempPassword
      ? `User registered successfully. Temporary password: ${result.tempPassword}`
      : 'User registered successfully.';

    showToast(message, 'success');

    if (data.role === 'tenant' || data.role === 'user') {
      await loadTenants();
      renderTenantView();
    } else {
      window.location.href = 'index.html';
    }
  } catch (error) {
    showToast(error.message || 'Registration failed.', 'error');
  } finally {
    hideLoading();
  }
}

async function loadTenants() {
  showLoading();
  try {
    const { data } = await requestJson('/tenants', { method: 'GET' });
    state.tenants = data?.tenants || [];
  } catch (error) {
    showToast(error.message || 'Failed to load tenant accounts.', 'error');
  } finally {
    hideLoading();
  }
}

function formatDateForInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().split('T')[0];
}

function renderEditTenant(id) {
  const tenant = state.tenants.find((item) => item.id === id);
  if (!tenant) {
    return;
  }

  app.innerHTML = `
    <div class="nav-back" onclick="renderTenantView()">← Back</div>
    <section class="modern-form">
      <div class="form-hero">
        <h3>Edit account</h3>
        <p>Update the core account details and tenant-specific information.</p>
      </div>

      <div class="form-section">
        <div class="form-section-title">Basic details</div>
        <div class="field-group">
          <label class="field-label" for="editName">Name</label>
          <input id="editName" value="${escapeHtml(tenant.name || '')}" />
        </div>
        <div class="field-group">
          <label class="field-label" for="editEmail">Email</label>
          <input id="editEmail" value="${escapeHtml(tenant.email || '')}" />
        </div>
        <div class="field-group">
          <label class="field-label" for="editRole">Role</label>
          <select id="editRole">
            <option value="Tenant" ${tenant.role === 'Tenant' ? 'selected' : ''}>Tenant</option>
            <option value="User" ${tenant.role === 'User' ? 'selected' : ''}>User</option>
            <option value="Admin" ${tenant.role === 'Admin' ? 'selected' : ''}>Admin</option>
          </select>
        </div>
      </div>

      <div class="form-section">
        <div class="form-section-title">Tenant details</div>
        <div class="form-row">
          <div class="field-group">
            <label class="field-label" for="editRent">Rent amount</label>
            <input id="editRent" type="number" value="${tenant.rent_amount || ''}" />
          </div>
          <div class="field-group">
            <label class="field-label" for="editDeposit">Deposit</label>
            <input id="editDeposit" type="number" value="${tenant.deposit || ''}" />
          </div>
        </div>
        <div class="form-row">
          <div class="field-group">
            <label class="field-label" for="editBalance">Balance</label>
            <input id="editBalance" type="number" value="${tenant.balance || ''}" />
          </div>
          <div class="field-group">
            <label class="field-label" for="editLeaseUnit">Lease unit</label>
            <input id="editLeaseUnit" value="${escapeHtml(tenant.leased_unit || '')}" />
          </div>
        </div>
        <div class="field-group">
          <label class="field-label" for="editOnboardDate">Onboard date</label>
          <input id="editOnboardDate" type="date" value="${formatDateForInput(tenant.onboard_date)}" />
        </div>
        <div class="field-group">
          <label class="field-label">Billing cycle</label>
          <div class="radio-group">
            <label class="radio-pill"><input type="radio" name="editBillingCycle" value="daily" ${tenant.billing_cycle === 'daily' ? 'checked' : ''} /> Daily</label>
            <label class="radio-pill"><input type="radio" name="editBillingCycle" value="weekly" ${tenant.billing_cycle === 'weekly' ? 'checked' : ''} /> Weekly</label>
            <label class="radio-pill"><input type="radio" name="editBillingCycle" value="monthly" ${tenant.billing_cycle === 'monthly' || !tenant.billing_cycle ? 'checked' : ''} /> Monthly</label>
          </div>
        </div>
      </div>

      <div class="form-actions">
        <button class="btn btn-secondary" type="button" onclick="renderTenantView()">Cancel</button>
        <button class="btn btn-primary" type="button" onclick="updateTenant(${id})">Save</button>
      </div>
    </section>
  `;
}

function updateTenant(id) {
  const tenant = state.tenants.find((item) => item.id === id);
  if (!tenant) {
    return;
  }

  tenant.name = document.getElementById('editName')?.value.trim() || tenant.name;
  tenant.email = document.getElementById('editEmail')?.value.trim() || tenant.email;
  tenant.role = document.getElementById('editRole')?.value || tenant.role;
  tenant.rent_amount = Number(document.getElementById('editRent')?.value || 0);
  tenant.deposit = Number(document.getElementById('editDeposit')?.value || 0);
  tenant.balance = Number(document.getElementById('editBalance')?.value || 0);
  tenant.leased_unit = document.getElementById('editLeaseUnit')?.value.trim() || tenant.leased_unit;
  tenant.onboard_date = document.getElementById('editOnboardDate')?.value || tenant.onboard_date;
  tenant.billing_cycle = document.querySelector('input[name="editBillingCycle"]:checked')?.value || tenant.billing_cycle || 'monthly';

  renderTenantView();
  showToast('Account updated.', 'success');
}

function deleteTenant(id) {
  showConfirmModal({
    title: 'Delete account',
    message: 'Remove this account from the list?',
    confirmText: 'Delete',
    onConfirm: () => {
      state.tenants = state.tenants.filter((tenant) => tenant.id !== id);
      renderTenantView();
      showToast('Account removed.', 'success');
    }
  });
}

function renderEditHome(id) {
  const home = state.homes.find((item) => item.id === id);
  if (!home) {
    return;
  }

  app.innerHTML = `
    <div class="nav-back" onclick="renderSettings()">← Back</div>
    <section class="form-card">
      <h3>Edit home</h3>
      <div class="form-group">
        <label for="editHomeName">Home name</label>
        <input id="editHomeName" value="${escapeHtml(home.name)}" />
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="renderSettings()">Cancel</button>
        <button class="btn btn-primary" onclick="updateHome(${id})">Save</button>
      </div>
    </section>
  `;
}

function updateHome(id) {
  const home = state.homes.find((item) => item.id === id);
  if (!home) {
    return;
  }
  home.name = document.getElementById('editHomeName')?.value.trim() || home.name;
  renderSettings();
  showToast('Home updated.', 'success');
}

function renderEditDevice(id) {
  const device = state.devices.find((item) => item.id === id);
  if (!device) {
    return;
  }

  app.innerHTML = `
    <div class="nav-back" onclick="renderSettings()">← Back</div>
    <section class="form-card">
      <h3>Edit device</h3>
      <div class="form-group">
        <label for="editDeviceHome">Home</label>
        <select id="editDeviceHome">
          ${state.homes.map((home) => `<option value="${home.id}" ${home.id === device.homeId ? 'selected' : ''}>${escapeHtml(home.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label for="editDeviceName">Device name</label>
        <input id="editDeviceName" value="${escapeHtml(device.name)}" />
      </div>
      <div class="form-group">
        <label for="editDevicePin">Pin</label>
        <input id="editDevicePin" type="number" value="${device.pin}" />
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="renderSettings()">Cancel</button>
        <button class="btn btn-primary" onclick="updateDevice(${id})">Save</button>
      </div>
    </section>
  `;
}

function updateDevice(id) {
  const device = state.devices.find((item) => item.id === id);
  if (!device) {
    return;
  }

  device.homeId = Number(document.getElementById('editDeviceHome')?.value);
  device.name = document.getElementById('editDeviceName')?.value.trim() || device.name;
  device.pin = Number(document.getElementById('editDevicePin')?.value);

  renderSettings();
  showToast('Device updated.', 'success');
}

function toggleProfileMenu() {
  document.getElementById('profileDropdown')?.classList.toggle('open');
}

function viewProfile() {
  showToast('Profile view is ready for your next iteration.', 'info');
}

function updatePasswordForm() {
  showPromptModal({
    title: 'Update password',
    label: 'Enter your new password',
    type: 'password',
    placeholder: 'New password',
    confirmText: 'Update',
    onConfirm: async (value) => {
      if (!value) {
        showToast('Password cannot be empty.', 'error');
        return;
      }

      showLoading();
      try {
        const { data } = await requestJson('/update_password', {
          method: 'POST',
          body: JSON.stringify({ newPassword: value })
        });
        if (data?.error) {
          throw new Error(data.error);
        }
        showToast('Password updated.', 'success');
      } catch (error) {
        showToast(error.message || 'Unable to update password.', 'error');
      } finally {
        hideLoading();
      }
    }
  });
}

function confirmLogout() {
  showConfirmModal({
    title: 'Log out',
    message: 'Are you sure you want to log out?',
    confirmText: 'Log out',
    onConfirm: () => {
      clearAuth();
      window.location.href = 'index.html';
    }
  });
}

function attachProfileMenu() {
  const profileButton = document.getElementById('profileButton');
  const profileDropdown = document.getElementById('profileDropdown');

  profileButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleProfileMenu();
  });

  document.addEventListener('click', (event) => {
    if (!profileDropdown?.contains(event.target)) {
      profileDropdown?.classList.remove('open');
    }
  });
}

async function initDashboard() {
  if (!isAuthenticated()) {
    window.location.href = 'index.html';
    return;
  }

  const valid = await verifySession();
  if (!valid) {
    clearAuth();
    window.location.href = 'index.html';
    return;
  }

  attachProfileMenu();
  await loadTenants();
  renderDashboard();
}

document.addEventListener('DOMContentLoaded', initDashboard);
