/** Dashboard-only summary and profile presentation. */
export function createDashboardPresentation({ state, statsGrid, profilePanel, formatRole, escapeHtml, getRoleViews, navigateToView }) {
  function renderStats() {
    const cards = ['tenant', 'user'].includes(state.role)
      ? [
          { label: 'Assigned Property', value: state.houses.length || 0 },
          { label: 'Devices', value: state.devices.length }
        ]
      : [
          { label: 'Properties', value: state.houses.length },
          { label: 'Accounts', value: state.accounts.length },
          { label: 'Assigned Devices', value: state.devices.length }
        ];

    statsGrid.innerHTML = cards.map(card => {
      const target = /house|propert/i.test(card.label) ? 'property' : /account|tenant/i.test(card.label) ? 'tenants' : /device/i.test(card.label) ? 'devices' : 'overview';
      const safeTarget = getRoleViews().includes(target) ? target : 'overview';
      return `<button type="button" class="stat-card stat-card-link" data-navigate-view="${safeTarget}" aria-label="Open ${escapeHtml(card.label)} section"><span class="stat-label">${escapeHtml(card.label)}</span><span class="stat-value">${escapeHtml(card.value)}</span></button>`;
    }).join('');

    statsGrid.querySelectorAll('[data-navigate-view]').forEach(card => {
      card.addEventListener('click', () => navigateToView(card.dataset.navigateView));
    });
  }

  function renderProfile() {
  const profile = state.profile || {};

  const assignedHouse =
    profile.assigned_house ||
    profile.assignedHouse ||
    (['tenant', 'user'].includes(state.role) ? state.houses[0] : null);

  const name =
    profile.name ||
    profile.full_name ||
    profile.fullName ||
    'Not provided';

  const email =
    profile.email ||
    profile.email_address ||
    profile.emailAddress ||
    'Not provided';

  const values = [
    ['Name', name],
    ['Email', email],
    ['Role', formatRole(state.role)],
    ['Property', assignedHouse?.name || 'No assigned property'],
    ['Location', assignedHouse?.location || 'N/A']
  ];

  profilePanel.innerHTML = values
    .map(([label, value]) =>
      `<div class="profile-line">
        <span class="label">${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>`
    )
    .join('');
}

  return { renderStats, renderProfile };
}
