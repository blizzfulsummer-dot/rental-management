/** Dashboard data orchestration with parallel, role-aware loading and stale-request protection. */
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

export function createDashboardDataFeature({
  state, API_BASE, getAuthHeaders, requestJson, canManageDeviceAccess,
  renderStats, renderProfile, renderViewTabs, renderMainPanel, escapeHtml, mainPanelContent
}) {
  let latestLoadId = 0;
  let activeController = null;

  async function loadDashboardData() {
    const loadId = ++latestLoadId;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const headers = getAuthHeaders();
    const requestOptions = { headers, signal: controller.signal };

    try {
      const housesData = await requestJson(`${API_BASE}/api/houses`, requestOptions);
      const houses = Array.isArray(housesData?.houses)
        ? housesData.houses
        : (Array.isArray(housesData) ? housesData : []);
      if (loadId !== latestLoadId) return;

      let provisionableUsers = [];
      let accounts = [];
      let tenants = [];
      if (state.role === 'admin' || state.role === 'owner') {
        const [provisionableResponse, accountsResponse, tenantsResponse] = await Promise.all([
          requestJson(`${API_BASE}/api/provisioning/users`, requestOptions),
          requestJson(`${API_BASE}/api/accounts`, requestOptions),
          requestJson(`${API_BASE}/api/tenants`, requestOptions)
        ]);
        provisionableUsers = Array.isArray(provisionableResponse?.users) ? provisionableResponse.users : [];
        accounts = Array.isArray(accountsResponse?.accounts) ? accountsResponse.accounts : [];
        tenants = Array.isArray(tenantsResponse?.tenants) ? tenantsResponse.tenants : [];
      }
      if (loadId !== latestLoadId) return;

      // Load each property's devices concurrently; a large portfolio should not
      // wait for one request per house to finish before starting the next.
      const deviceGroups = await mapWithConcurrency(houses, 6, async house => {
        try {
          const response = await requestJson(`${API_BASE}/api/houses/${encodeURIComponent(house.id)}/devices`, requestOptions);
          return Array.isArray(response?.devices) ? response.devices : [];
        } catch (error) {
          if (controller.signal.aborted) throw error;
          console.warn(`Could not load devices for property ${house.id}:`, error);
          return [];
        }
      });
      const devices = deviceGroups.flat();

      const fingerprints = {};
      const deviceAccess = {};

      // A failed metadata endpoint for one device should not blank the entire
      // dashboard. Keep the rest of the device list usable and log the failure.
      await mapWithConcurrency(devices, 8, async device => {
        const jobs = [
          requestJson(`${API_BASE}/api/devices/${encodeURIComponent(device.id)}/fingerprints`, requestOptions)
            .then(data => { fingerprints[device.id] = Array.isArray(data?.enrollments) ? data.enrollments : []; })
            .catch(error => { fingerprints[device.id] = []; console.warn(`Could not load fingerprints for device ${device.id}:`, error); })
        ];
        if (canManageDeviceAccess(device, houses)) {
          jobs.push(
            requestJson(`${API_BASE}/api/devices/${encodeURIComponent(device.id)}/access`, requestOptions)
              .then(data => { deviceAccess[device.id] = Array.isArray(data?.users) ? data.users : []; })
              .catch(error => { deviceAccess[device.id] = []; console.warn(`Could not load access list for device ${device.id}:`, error); })
          );
        }
        await Promise.all(jobs);
      });

      // Ignore late responses from an earlier refresh or account transition.
      if (loadId !== latestLoadId) return;

      state.houses = houses;
      state.provisionableUsers = provisionableUsers;
      state.accounts = accounts;
      state.tenants = tenants;
      state.devices = devices;
      state.fingerprints = fingerprints;
      state.deviceAccess = deviceAccess;
      const selectedHouseExists = houses.some(house => Number(house.id) === Number(state.selectedHouseId));
      if (!selectedHouseExists) state.selectedHouseId = houses[0]?.id ?? null;

      renderStats();
      renderProfile();
      renderViewTabs();
      renderMainPanel();
    } catch (error) {
      if (loadId !== latestLoadId) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      console.error('Dashboard load error:', error);
      if (mainPanelContent) {
        mainPanelContent.innerHTML = `<div class="empty">Unable to load dashboard data: ${escapeHtml(error.message || 'Request failed')}</div>`;
      }
    }
  }

  function cancelPendingLoad() {
    latestLoadId += 1;
    activeController?.abort();
    activeController = null;
  }

  return { loadDashboardData, cancelPendingLoad };
}
