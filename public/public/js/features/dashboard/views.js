/** Role-aware dashboard view rendering and navigation dispatch. */
export function createDashboardViews({ state, mainPanelContent, mainPanelTitle, escapeHtml, renderHouseList, renderHouseAccess, renderTenantList, renderDeviceList, renderAuditLogs, getRoleViews, navigateToView }) {
    function renderOverviewPanel() {
      const role = state.role;
      mainPanelTitle.textContent = role === 'admin' ? 'Admin Overview' : role === 'owner' ? 'Owner Overview' : 'Assigned Access';

      if (role === 'admin' || role === 'owner') {
        renderHouseList();
        if (state.tenants.length) {
          const panel = document.createElement('div');
          panel.className = 'card-grid';
          panel.innerHTML = state.tenants.map(tenant => `
            <div class="tenant-card">
              <h3>${escapeHtml(tenant.name || tenant.email || 'Tenant')}</h3>
              <div class="meta">${escapeHtml(tenant.email || 'No email')}<br />Unit: ${escapeHtml(tenant.leased_unit || 'N/A')}<br />Rent: ${escapeHtml(tenant.rent_amount || 'N/A')}</div>
              <div class="tag">Tenant</div>
            </div>
          `).join('');
          mainPanelContent.appendChild(panel);
        }
        return;
      }

      if (!state.houses.length) {
        mainPanelContent.innerHTML = '<div class="empty">No property is assigned to this account.</div>';
        return;
      }

      const cards = state.houses.map(house => `
        <article class="house-card house-card-clickable" data-card-open-house="${escapeHtml(house.id)}">
          <button class="house-card-top house-card-open" type="button" data-open-house="${escapeHtml(house.id)}" aria-label="Open property ${escapeHtml(house.name || `Property ${house.id}`)}"><span class="tag">Property</span><span class="card-arrow" aria-hidden="true">↗</span></button>
          <h3>${escapeHtml(house.name || 'Assigned Property')}</h3>
          <div class="meta">${escapeHtml(house.location || 'No location')}<br />Owner: ${escapeHtml(house.owner_id || 'N/A')}</div>
          <div class="inline-actions">
            <button class="mini-btn" type="button" data-house-id="${escapeHtml(house.id)}" data-action="select-house">View Devices</button>
          </div>
        </article>
      `).join('');

      mainPanelContent.innerHTML = `<div class="card-grid">${cards}</div>`;
      const openHouse = card => {
        state.selectedHouseId = Number(card.dataset.openHouse);
        navigateToView('property');
      };
      mainPanelContent.querySelectorAll('[data-card-open-house]').forEach(card => {
        card.addEventListener('click', event => {
          if (event.target.closest('button, a, input, select, form')) return;
          openHouse({ dataset: { openHouse: card.dataset.cardOpenHouse } });
        });
      });
      mainPanelContent.querySelectorAll('button[data-open-house]').forEach(button => {
        button.addEventListener('click', () => openHouse(button));
      });
      mainPanelContent.querySelectorAll('[data-action="select-house"]').forEach(button => {
        button.addEventListener('click', event => {
          event.stopPropagation();
          state.selectedHouseId = Number(button.dataset.houseId);
          navigateToView('devices');
        });
      });
    }

    function renderMainPanel() {
      const role = state.role;
      mainPanelContent.innerHTML = '';

      if (!state.activeView || !getRoleViews().includes(state.activeView)) {
        state.activeView = 'overview';
      }

      if (state.activeView === 'property' || state.activeView === 'houses') {
        mainPanelTitle.textContent = role === 'admin' ? 'All Properties' : role === 'owner' ? 'My Properties' : 'Assigned Properties';
        renderHouseList();
        return;
      }

      if (state.activeView === 'access') {
        mainPanelTitle.textContent = 'Property Access';
        void renderHouseAccess();
        return;
      }

      if (state.activeView === 'tenants') {
        mainPanelTitle.textContent = 'Accounts';
        renderTenantList();
        return;
      }

      if (state.activeView === 'devices') {
        mainPanelTitle.textContent = 'Devices';
        renderDeviceList();
        return;
      }

      if (state.activeView === 'logs') {
        mainPanelTitle.textContent = 'Activity Logs';
        void renderAuditLogs();
        return;
      }

      renderOverviewPanel();
    }

  return { renderOverviewPanel, renderMainPanel };
}
