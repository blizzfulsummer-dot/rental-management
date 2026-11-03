/** Property and house-access workflows. API and application state are injected. */
export function createPropertyFeature({ state, mainPanelContent, API_BASE, escapeHtml, requestJson, getAuthHeaders, showAlert, withButtonLoading, renderMainPanel, navigateToView }) {
    

function renderHouseList() {
  const canCreateHouse = ['admin', 'owner'].includes(state.role);

  const addHousePanel = canCreateHouse ? `
    <form id="addHouseForm" class="access-add-panel">
      <div class="field">
        <label for="newHouseName">Property name</label>
        <input
          id="newHouseName"
          name="name"
          type="text"
          placeholder="Enter property name"
          required
        />
      </div>

      <div class="field">
        <label for="newHouseAddress">Address</label>
        <input
          id="newHouseAddress"
          name="address"
          type="text"
          placeholder="Enter property address"
        />
      </div>

      <button class="primary-btn" type="submit">
        Add Property
      </button>
    </form>
    <div id="addHouseAlert" class="alert" role="status"></div>
  ` : '';

  const cards = state.houses.map(house => {
    const rawPicture =
      house.image_url || house.photo_url || house.image || '';

    const pictureUrl =
      typeof rawPicture === 'string' &&
      /^(https?:\/\/|\/)/i.test(rawPicture.trim())
        ? rawPicture.trim()
        : '';

    const picture = pictureUrl
      ? `<img src="${escapeHtml(pictureUrl)}"
          alt="${escapeHtml(house.name || 'Property')} photo"
          loading="lazy" />`
      : `<div class="house-card-picture-placeholder"
          aria-label="No property picture">
          <span class="property-art" aria-hidden="true">
            <span class="property-art-roof"></span>
            <span class="property-art-body">
              <span class="property-art-window"></span>
              <span class="property-art-door"></span>
              <span class="property-art-window"></span>
            </span>
          </span>
          <span class="property-art-caption">PROPERTY OVERVIEW</span>
        </div>`;

    return `
      <article class="house-card house-card-clickable"
        data-card-open-house="${escapeHtml(house.id)}">

        ${pictureUrl
          ? `<img src="${escapeHtml(pictureUrl)}"
              alt="${escapeHtml(house.name || 'Property')}"
              class="property-image">`
          : `<div class="house-card-picture">${picture}</div>`
        }

        <button class="house-card-top house-card-open"
          type="button"
          data-open-house="${escapeHtml(house.id)}"
          aria-label="Open property">
          <span class="tag">Property</span>
          <span class="card-arrow" aria-hidden="true">↗</span>
        </button>

        <h3>${escapeHtml(house.name || 'Unnamed Property')}</h3>

        <div class="meta">
          ${escapeHtml(house.location || house.address || 'No location')}
          <br /><br />
          ID: ${escapeHtml(house.house_uid || 'N/A')}
        </div>

        <div class="inline-actions">
          <button class="mini-btn" type="button"
            data-house-action="devices"
            data-house-id="${escapeHtml(house.id)}">
            View Devices
          </button>

          ${canCreateHouse ? `
            <button class="mini-btn" type="button"
              data-house-action="access"
              data-house-id="${escapeHtml(house.id)}">
              Manage Access
            </button>

            <button class="mini-btn" type="button"
              data-house-action="edit"
              data-house-id="${escapeHtml(house.id)}">
              Edit
            </button>

            <button class="mini-btn" type="button"
              data-house-action="delete"
              data-house-id="${escapeHtml(house.id)}">
              Delete
            </button>
          ` : ''}
        </div>
      </article>
    `;
  }).join('');

  mainPanelContent.innerHTML = `
    ${addHousePanel}
    ${cards
      ? `<div class="card-grid">${cards}</div>`
      : '<div class="empty">No properties available for this account.</div>'
    }
  `;

  // Create / Edit house
  const addHouseForm = mainPanelContent.querySelector('#addHouseForm');

  if (addHouseForm) {
    addHouseForm.addEventListener('submit', async event => {
      event.preventDefault();

      const form = event.currentTarget;
      const button = form.querySelector('button[type="submit"]');
      const alert = mainPanelContent.querySelector('#addHouseAlert');

      const name = form.elements.name.value.trim();
      const address = form.elements.address.value.trim();
      const editHouseId = form.dataset.editHouseId;

      if (!name) return;

      try {
        await withButtonLoading(button, async () => {
          const result = await requestJson(
            editHouseId
              ? `${API_BASE}/api/houses/${editHouseId}`
              : `${API_BASE}/api/houses`,
            {
              method: editHouseId ? 'PUT' : 'POST',
              headers: getAuthHeaders(),
              body: JSON.stringify({ name, address })
            }
          );

          if (!result.house) {
            throw new Error('No house data was returned.');
          }

          if (editHouseId) {
            const index = state.houses.findIndex(
              h => String(h.id) === String(editHouseId)
            );

            if (index !== -1) {
              state.houses[index] = result.house;
            }
          } else {
            state.houses.push(result.house);
          }
        }, editHouseId ? 'Updating...' : 'Creating...');

        if (window.remanUX?.showToast) {
          window.remanUX.showToast(
            editHouseId
              ? 'House updated successfully.'
              : 'House created successfully.'
          );
        }

        renderHouseList();

      } catch (error) {
        showAlert(
          alert,
          error.message || 'Unable to save house.',
          'error'
        );
      }
    });
  }

  // Open house
  const openHouse = card => {
    state.selectedHouseId = Number(card.dataset.openHouse);

    navigateToView(
      state.activeView === 'overview' ? 'property' : 'devices'
    );
  };

  mainPanelContent.querySelectorAll('[data-card-open-house]').forEach(card => {
    card.addEventListener('click', event => {
      if (event.target.closest('button, a, input, select, form')) return;
      openHouse({
        dataset: { openHouse: card.dataset.cardOpenHouse }
      });
    });
  });

  mainPanelContent.querySelectorAll('button[data-open-house]').forEach(button => {
    button.addEventListener('click', () => openHouse(button));
  });

  // House actions
  mainPanelContent.querySelectorAll('[data-house-action]').forEach(button => {
    button.addEventListener('click', async event => {
      event.stopPropagation();

      const action = button.dataset.houseAction;
      const houseId = button.dataset.houseId;

      const house = state.houses.find(
        h => String(h.id) === String(houseId)
      );

      if (!house) return;

      // View devices
      if (action === 'devices') {
        state.selectedHouseId = Number(houseId);
        navigateToView('devices');
        return;
      }

      if (!canCreateHouse) return;

      // Manage access
      if (action === 'access') {
        state.selectedHouseId = Number(houseId);
        navigateToView('access');
        return;
      }

      // Edit house
      if (action === 'edit') {
        const form = mainPanelContent.querySelector('#addHouseForm');

        if (!form) return;

        form.dataset.editHouseId = houseId;
        form.elements.name.value = house.name || '';
        form.elements.address.value =
          house.address || house.location || '';

        const submitButton = form.querySelector('[type="submit"]');
        submitButton.textContent = 'Update House';

        form.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });

        form.elements.name.focus();
        return;
      }

      // Delete house
      if (action === 'delete') {
        const confirmed = confirm(
          `Are you sure you want to delete "${house.name || 'this house'}"?`
        );

        if (!confirmed) return;

        try {
          await withButtonLoading(button, async () => {
            await requestJson(
              `${API_BASE}/api/houses/${houseId}`,
              {
                method: 'DELETE',
                headers: getAuthHeaders()
              }
            );
          }, 'Deleting...');

          state.houses = state.houses.filter(
            h => String(h.id) !== String(houseId)
          );

          if (String(state.selectedHouseId) === String(houseId)) {
            state.selectedHouseId = null;
          }

          if (window.remanUX?.showToast) {
            window.remanUX.showToast('House deleted successfully.');
          }

          renderHouseList();

        } catch (error) {
          showAlert(
            mainPanelContent.querySelector('#addHouseAlert'),
            error.message || 'Unable to delete house.',
            'error'
          );
        }
      }
    });
  });
}


    async function renderHouseAccess() {
      if (state.role !== 'admin' && state.role !== 'owner') {
        mainPanelContent.innerHTML = '<div class="empty">You do not have permission to manage property access.</div>';
        return;
      }
      if (!state.houses.length) {
        mainPanelContent.innerHTML = '<div class="empty">Create or select a property before assigning users.</div>';
        return;
      }

      const selectedHouse = state.houses.find(house => Number(house.id) === Number(state.selectedHouseId)) || state.houses[0];
      state.selectedHouseId = Number(selectedHouse.id);
      const houseOptions = state.houses.map(house => `<option value="${escapeHtml(house.id)}" ${Number(house.id) === Number(selectedHouse.id) ? 'selected' : ''}>${escapeHtml(house.name || `Property ${house.id}`)}</option>`).join('');
      mainPanelContent.innerHTML = `
        <div class="access-toolbar">
          <div><h3 class="access-house-heading">${escapeHtml(selectedHouse.name || `Property ${selectedHouse.id}`)}</h3><p class="access-house-subtitle">Manage regular users who can access this property</p></div>
          <label class="house-selector" for="accessHouseSelect">Property <select id="accessHouseSelect">${houseOptions}</select></label>
        </div>
        <div id="houseAccessAlert" class="alert" role="status" aria-live="polite"></div>
        <form id="houseAccessAddForm" class="access-add-panel">
          <div class="field"><label for="houseAccessUserSearch">Find a user</label><input id="houseAccessUserSearch" type="search" placeholder="Search by name or email…" autocomplete="off" /></div>
          <div class="field"><label for="houseAccessUser">Assign a regular user</label><select id="houseAccessUser" name="user_id" required><option value="">Choose a user to add</option></select></div>
          <button class="primary-btn" type="submit">Add Here</button>
        </form>
        <div class="access-toolbar"><div class="access-summary"><span class="access-count" id="houseAccessCount">—</span><span>Users with access to this property</span></div><input id="houseAccessSearch" class="access-search" type="search" placeholder="Search assigned users…" aria-label="Search assigned users" /></div>
        <div id="houseAccessUsers" class="access-user-list"><div class="data-loading"><span class="loading-spinner"></span>Loading property access…</div></div>
      `;

      document.getElementById('accessHouseSelect').addEventListener('change', event => {
        state.selectedHouseId = Number(event.target.value);
        renderMainPanel();
      });

      const alert = document.getElementById('houseAccessAlert');
      const userSelect = document.getElementById('houseAccessUser');
      const userSearchInput = document.getElementById('houseAccessUserSearch');
      const usersContainer = document.getElementById('houseAccessUsers');
      const searchInput = document.getElementById('houseAccessSearch');
      let assignedUsers = [];

      const renderAssignedUsers = () => {
        const term = searchInput.value.trim().toLowerCase();
        const filtered = assignedUsers.filter(user => `${user.name || ''} ${user.email || ''}`.toLowerCase().includes(term));
        document.getElementById('houseAccessCount').textContent = String(assignedUsers.length);
        if (!filtered.length) {
          usersContainer.innerHTML = `<div class="access-empty">${assignedUsers.length ? 'No assigned users match your search.' : 'No regular users have been assigned to this property yet.'}</div>`;
          return;
        }
        usersContainer.innerHTML = filtered.map(user => {
          const displayName = user.name || user.email || `User ${user.id}`;
          const initials = displayName.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
          return `<div class="access-user-row"><div class="access-user-main"><div class="access-avatar" aria-hidden="true">${escapeHtml(initials || 'U')}</div><div class="access-user-name"><strong>${escapeHtml(displayName)}</strong><span>${escapeHtml(user.email || 'No email')}</span></div></div><div class="access-row-actions"><span class="access-level">${escapeHtml(user.access_level || 'viewer')}</span><button class="mini-btn danger" type="button" data-remove-house-user="${escapeHtml(user.id)}">Remove</button></div></div>`;
        }).join('');
        usersContainer.querySelectorAll('[data-remove-house-user]').forEach(button => {
  button.addEventListener('click', async () => {
    const userId = Number(button.dataset.removeHouseUser);
    const user = assignedUsers.find(item => Number(item.id) === userId);

    if (!user || !window.confirm(
      `Remove ${user.name || user.email || 'this user'} from ${selectedHouse.name || 'this property'}?`
    )) return;

    try {
      await withButtonLoading(button, async () => {
        await requestJson(
          `${API_BASE}/api/houses/${selectedHouse.id}/access/${userId}`,
          {
            method: 'DELETE',
            headers: getAuthHeaders()
          }
        );
      }, 'Removing...');

      assignedUsers = assignedUsers.filter(item => Number(item.id) !== userId);

      renderAssignedUsers();
      refreshUserOptions();

      if (window.remanUX?.showToast) {
        window.remanUX.showToast('Property access removed.');
      }

    } catch (error) {
      showAlert(alert, error.message || 'Unable to remove property access.', 'error');
    }
  });
});
      };
      const availableUsers = () => {
        const assignedIds = new Set(assignedUsers.map(user => Number(user.id)));
        const term = userSearchInput.value.trim().toLowerCase();
        return state.provisionableUsers.filter(user => {
          const matchesRole = String(user.role).toLowerCase() === 'user';
          const notAssigned = !assignedIds.has(Number(user.id));
          const matchesSearch = `${user.name || ''} ${user.email || ''}`.toLowerCase().includes(term);
          return matchesRole && notAssigned && matchesSearch;
        });
      };
      const refreshUserOptions = () => {
        const available = availableUsers();
        userSelect.innerHTML = available.length
          ? '<option value="">Choose a user to add</option>' + available.map(user => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name || user.email)}${user.email && user.name ? ` — ${escapeHtml(user.email)}` : ''}</option>`).join('')
          : '<option value="">No matching unassigned users</option>';
        userSelect.disabled = !available.length;
        const submitBtn = mainPanelContent.querySelector('#houseAccessAddForm button[type="submit"]');
        if (submitBtn) submitBtn.disabled = !available.length;
      };

      try {
        const result = await requestJson(`${API_BASE}/api/houses/${selectedHouse.id}/access`, { headers: getAuthHeaders() });
        assignedUsers = Array.isArray(result.users) ? result.users : [];
        refreshUserOptions();
        renderAssignedUsers();
      } catch (error) {
        usersContainer.innerHTML = `<div class="access-empty">Unable to load property access: ${escapeHtml(error.message || 'Request failed')}</div>`;
        const submitBtn = mainPanelContent.querySelector('#houseAccessAddForm button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;
      }

      searchInput.addEventListener('input', renderAssignedUsers);
      userSearchInput.addEventListener('input', refreshUserOptions);
      document.getElementById('houseAccessAddForm').addEventListener('submit', async event => {
        event.preventDefault();

        const userId = Number(userSelect.value);
        if (!userId) return;

        const button = event.currentTarget.querySelector('button[type="submit"]');

        try {
          await withButtonLoading(button, async () => {
            await requestJson(`${API_BASE}/api/houses/${selectedHouse.id}/access`, {
              method: 'POST',
              headers: getAuthHeaders(),
              body: JSON.stringify({ user_id: userId })
            });

            const added = state.provisionableUsers.find(
              user => Number(user.id) === userId
            );

            if (added && !assignedUsers.some(user => Number(user.id) === userId)) {
              assignedUsers.push({ ...added, access_level: 'viewer' });
            }

            userSelect.value = '';
            
            if (window.remanUX?.showToast) {
              window.remanUX.showToast('User assigned to property.');
            }
          }, 'Adding...');

        } catch (error) {
          showAlert(alert, error.message || 'Unable to assign user to property.', 'error');
        } finally {
          // Use setTimeout boundary to ensure withButtonLoading has cleanly
          // restored the button's attributes before refreshing options
          setTimeout(() => {
            refreshUserOptions();
            renderAssignedUsers();
          }, 0);
        }
      });
    }
  return { renderHouseList, renderHouseAccess };
}