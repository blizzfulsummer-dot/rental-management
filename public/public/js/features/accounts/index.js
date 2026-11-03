
/** Account and tenant administration workflows. */

import { createCredentialsDialog } from './credentials-dialog.js';
import { createConfirmationDialog } from './confirmation-dialog.js';

export function createAccountFeature({
    state,
    mainPanelContent,
    escapeHtml,
    formatRole,
    showAlert,
    clearAlert,
    setButtonBusy,
    showToast,
    requestJson,
    API_BASE,
    getAuthHeaders,
    loadDashboardData
}) {
    let credentialsDialog;
    let confirmationDialog;

    function getCredentialsDialog() {
        if (!credentialsDialog) credentialsDialog = createCredentialsDialog();
        return credentialsDialog;
    }

    function getConfirmationDialog() {
        if (!confirmationDialog) confirmationDialog = createConfirmationDialog();
        return confirmationDialog;
    }

    function getManageableHouses() {
        if (state.role === 'admin') return state.houses || [];

        return (state.houses || []).filter(
            house => Number(house.owner_id) === Number(state.profile?.id)
        );
    }

    function canEditAccount(account) {
        if (!account) return false;
        if (state.role === 'admin') return true;

        if (
            state.role !== 'owner' ||
            ['owner', 'admin'].includes(
                String(account.role || '').toLowerCase()
            )
        ) {
            return false;
        }

        const ownedIds = new Set(
            getManageableHouses().map(house => Number(house.id))
        );

        return (account.house_ids || []).some(
            id => ownedIds.has(Number(id))
        );
    }

    // --------------------------------------------------
    // ACCOUNT LIST
    // --------------------------------------------------

    function renderTenantList() {
        const accounts = (state.accounts || []).filter(account =>
            ['owner', 'tenant', 'user'].includes(
                String(account.role || '').toLowerCase()
            )
        );

        const pageSize = 10;
        let currentPage = 1;
        let selectedAccountId = null;

        mainPanelContent.innerHTML = `
            <div class="account-toolbar">
                <input
                    id="accountSearch"
                    type="search"
                    placeholder="Search name or email"
                    aria-label="Search accounts"
                >

                <select id="accountRoleFilter" aria-label="Filter by role">
                    <option value="all">All account types</option>
                    <option value="owner">Owners</option>
                    <option value="tenant">Tenants</option>
                    <option value="user">Regular users</option>
                </select>

                <button
                    type="button"
                    id="createAccountBtn"
                    class="primary-btn account-create-btn"
                >
                    + Create account
                </button>
            </div>

            <div id="accountList" class="account-list"></div>
            <div
                id="selectedAccountActions"
                class="account-selection-actions"
                hidden
                aria-live="polite"
            >
                <span id="selectedAccountLabel" class="meta"></span>
                <div class="account-selection-buttons">
                    <button type="button" id="suspendSelectedAccount" class="mini-btn danger">
                        Suspend account
                    </button>
                    <button type="button" id="reactivateSelectedAccount" class="mini-btn" hidden>
                        Reactivate account
                    </button>
                    <button type="button" id="deleteSelectedAccount" class="mini-btn danger">
                        Delete account
                    </button>
                </div>
            </div>

            <div id="accountPagination" class="account-pagination"></div>
        `;

        const accountList = document.getElementById('accountList');
        const pagination = document.getElementById('accountPagination');
        const searchInput = document.getElementById('accountSearch');
        const roleFilter = document.getElementById('accountRoleFilter');

        document.getElementById('createAccountBtn').addEventListener(
            'click',
            () => openAccountEditor()
        );

        function renderRows(filteredAccounts) {
            const start = (currentPage - 1) * pageSize;
            const pageAccounts = filteredAccounts.slice(
                start,
                start + pageSize
            );

            accountList.innerHTML = pageAccounts.length
                ? pageAccounts.map(account => {
                    const role = String(account.role || '').toLowerCase();
                    const houses = (account.house_names || [])
                        .filter(Boolean)
                        .join(', ');

                    const status = String(account.status || 'active').toLowerCase();
                    const manageable = canEditAccount(account);
                    return `
                        <div class="account-list-row">
                            <input
                                type="radio"
                                name="selectedAccount"
                                class="account-list-select"
                                aria-label="Select ${escapeHtml(account.name || account.email || 'account')} for actions"
                                value="${escapeHtml(account.id)}"
                                ${selectedAccountId === Number(account.id) ? 'checked' : ''}
                                ${manageable ? '' : 'disabled'}
                            >
                            <button
                                type="button"
                                class="account-list-open"
                                data-open-account="${escapeHtml(account.id)}"
                            >
                                <span class="account-list-main">
                                    <strong>${escapeHtml(account.name || 'Unnamed account')}</strong>
                                    <span class="meta">${escapeHtml(account.email || '')}</span>
                                </span>
                                <span class="account-list-property">
                                    ${escapeHtml(houses || (role === 'owner' ? 'Property owner' : 'Not assigned'))}
                                </span>
                                <span class="account-list-status ${status === 'suspended' ? 'suspended' : ''}">
                                    ${escapeHtml(status)}
                                </span>
                                <span class="account-role">${escapeHtml(formatRole(role))}</span>
                                <span class="account-list-arrow" aria-hidden="true">›</span>
                            </button>
                        </div>
                    `;
                }).join('')
                : '<div class="empty">No matching accounts.</div>';

            accountList.querySelectorAll('.account-list-select').forEach(input => {
                input.addEventListener('change', () => {
                    selectedAccountId = Number(input.value);
                    renderSelectedAccountActions(
                        accounts.find(item => Number(item.id) === selectedAccountId)
                    );
                });
            });

            accountList.querySelectorAll('[data-open-account]').forEach(button => {
                button.addEventListener('click', () => {
                    const account = accounts.find(item =>
                        Number(item.id) === Number(button.dataset.openAccount)
                    );

                    if (account) renderAccountDetails(account);
                });
            });
        }

        function renderSelectedAccountActions(account) {
            const actions = document.getElementById('selectedAccountActions');
            const label = document.getElementById('selectedAccountLabel');
            const suspendButton = document.getElementById('suspendSelectedAccount');
            const reactivateButton = document.getElementById('reactivateSelectedAccount');
            if (!actions || !account || !canEditAccount(account)) {
                if (actions) actions.hidden = true;
                return;
            }

            const suspended = String(account.status || 'active').toLowerCase() === 'suspended';
            label.textContent = `Selected: ${account.name || account.email}`;
            suspendButton.hidden = suspended;
            reactivateButton.hidden = !suspended;
            actions.hidden = false;
        }

        function renderPagination(filteredAccounts) {
            const totalPages = Math.ceil(
                filteredAccounts.length / pageSize
            );

            if (totalPages <= 1) {
                pagination.innerHTML = '';
                return;
            }

            pagination.innerHTML = `
                <span class="meta">
                    ${filteredAccounts.length} accounts ·
                    Page ${currentPage} of ${totalPages}
                </span>

                <div class="account-pagination-actions">
                    <button
                        type="button"
                        class="mini-btn"
                        id="accountPreviousPage"
                        ${currentPage === 1 ? 'disabled' : ''}
                    >
                        Previous
                    </button>

                    <button
                        type="button"
                        class="mini-btn"
                        id="accountNextPage"
                        ${currentPage === totalPages ? 'disabled' : ''}
                    >
                        Next
                    </button>
                </div>
            `;

            document.getElementById('accountPreviousPage')
                ?.addEventListener('click', () => {
                    if (currentPage > 1) {
                        currentPage--;
                        applyFilters();
                    }
                });

            document.getElementById('accountNextPage')
                ?.addEventListener('click', () => {
                    if (currentPage < totalPages) {
                        currentPage++;
                        applyFilters();
                    }
                });
        }

        function applyFilters() {
            selectedAccountId = null;
            document.getElementById('selectedAccountActions').hidden = true;
            const query = searchInput.value.trim().toLowerCase();
            const selectedRole = roleFilter.value;

            const filteredAccounts = accounts.filter(account => {
                const role = String(account.role || '').toLowerCase();

                const searchableText =
                    `${account.name || ''} ${account.email || ''}`.toLowerCase();

                return (
                    (selectedRole === 'all' || role === selectedRole) &&
                    searchableText.includes(query)
                );
            });

            const totalPages = Math.max(
                1,
                Math.ceil(filteredAccounts.length / pageSize)
            );

            currentPage = Math.min(currentPage, totalPages);

            renderRows(filteredAccounts);
            renderPagination(filteredAccounts);
        }

        searchInput.addEventListener('input', () => {
            currentPage = 1;
            applyFilters();
        });

        roleFilter.addEventListener('change', () => {
            currentPage = 1;
            applyFilters();
        });

        applyFilters();

        document.getElementById('suspendSelectedAccount').addEventListener(
            'click',
            event => handleSelectedAccountAction('suspend', event.currentTarget)
        );
        document.getElementById('reactivateSelectedAccount').addEventListener(
            'click',
            event => handleSelectedAccountAction('reactivate', event.currentTarget)
        );
        document.getElementById('deleteSelectedAccount').addEventListener(
            'click',
            event => handleSelectedAccountAction('delete', event.currentTarget)
        );

        async function handleSelectedAccountAction(action, button) {
            const account = accounts.find(item => Number(item.id) === selectedAccountId);
            if (!account || !canEditAccount(account)) return;

            const isDelete = action === 'delete';
            const confirmed = await getConfirmationDialog().show({
                title: isDelete
                    ? 'Delete account permanently?'
                    : action === 'suspend' ? 'Suspend account?' : 'Reactivate account?',
                message: isDelete
                    ? `This permanently deletes ${account.name || account.email} and removes their account data and access. This cannot be undone.`
                    : action === 'suspend'
                        ? `Suspend ${account.name || account.email}? Their access grants will be kept. A disconnected device will receive the change when it reconnects.`
                        : `Reactivate ${account.name || account.email}?`,
                confirmText: isDelete ? 'Delete account' : action === 'suspend' ? 'Suspend account' : 'Reactivate account',
                cancelText: 'Cancel',
                danger: action !== 'reactivate'
            });
            if (!confirmed) return;

            setButtonBusy(button, true, isDelete ? 'Deleting…' : 'Updating…');
            try {
                const url = isDelete
                    ? `${API_BASE}/api/accounts/${encodeURIComponent(account.id)}`
                    : `${API_BASE}/api/accounts/${encodeURIComponent(account.id)}/${action}`;
                const result = await requestJson(url, {
                    method: isDelete ? 'DELETE' : 'POST',
                    headers: getAuthHeaders()
                });
                if (result?.success !== true) {
                    throw new Error(result?.error || `Could not ${action} account.`);
                }

                const actionLabel = action === 'suspend'
                    ? 'suspended'
                    : action === 'reactivate'
                        ? 'reactivated'
                        : 'deleted';
                showToast?.(
                    result.authorizationSyncPending
                        ? `Account ${actionLabel}. Device authorization will sync when the device reconnects.`
                        : `Account ${actionLabel} successfully.`
                );
                await loadDashboardData();
            } catch (error) {
                showAlert(mainPanelContent, error.message || `Could not ${action} account.`, 'error');
            } finally {
                setButtonBusy(button, false);
            }
        }
    }

    // --------------------------------------------------
    // ACCOUNT DETAILS
    // --------------------------------------------------

    function renderAccountDetails(account) {
        const role = String(account.role || '').toLowerCase();
        const houses = (account.house_names || []).filter(Boolean);
        const canManage = canEditAccount(account);

        const tenantDetails = role === 'tenant'
            ? `
                <div class="account-info-item">
                    <span class="meta">Unit</span>
                    <strong>${escapeHtml(account.leased_unit || '—')}</strong>
                </div>

                <div class="account-info-item">
                    <span class="meta">Monthly rent / Rent amount</span>
                    <strong>${escapeHtml(account.rent_amount ?? '—')}</strong>
                </div>

                <div class="account-info-item">
                    <span class="meta">Deposit</span>
                    <strong>${escapeHtml(account.deposit ?? '—')}</strong>
                </div>

                <div class="account-info-item">
                    <span class="meta">Balance</span>
                    <strong>${escapeHtml(account.balance ?? '—')}</strong>
                </div>

                <div class="account-info-item">
                    <span class="meta">Billing cycle</span>
                    <strong>${escapeHtml(account.billing_cycle || '—')}</strong>
                </div>

                <div class="account-info-item">
                    <span class="meta">Onboard date</span>
                    <strong>${escapeHtml(account.onboard_date || '—')}</strong>
                </div>
            `
            : '';

        mainPanelContent.innerHTML = `
            <div class="account-detail-view">

                <button
                    type="button"
                    id="backToAccounts"
                    class="mini-btn"
                >
                    ← Back to accounts
                </button>

                <section class="account-detail-card">

                    <div class="account-detail-header">
                        <div class="account-avatar">
                            ${escapeHtml(
                                String(account.name || '?')
                                    .trim()
                                    .split(/\s+/)
                                    .slice(0, 2)
                                    .map(part => part.charAt(0).toUpperCase())
                                    .join('')
                            )}
                        </div>

                        <div class="account-detail-heading">
                            <h2>${escapeHtml(account.name || 'Unnamed account')}</h2>
                            <p class="meta">${escapeHtml(account.email || '')}</p>
                        </div>

                        <span class="account-role">
                            ${escapeHtml(formatRole(role))}
                        </span>
                    </div>

                    <div class="account-detail-section">
                        <h3>Account information</h3>

                        <div class="account-info-grid">
                            <div class="account-info-item">
                                <span class="meta">Account ID</span>
                                <strong>${escapeHtml(account.id)}</strong>
                            </div>

                            <div class="account-info-item">
                                <span class="meta">Account type</span>
                                <strong>${escapeHtml(formatRole(role))}</strong>
                            </div>

                            <div class="account-info-item">
                                <span class="meta">Assigned properties</span>
                                <strong>
                                    ${escapeHtml(houses.join(', ') || 'Not assigned')}
                                </strong>
                            </div>

                            ${tenantDetails}
                        </div>
                    </div>

                    <div class="account-detail-section">
                        <h3>Access management</h3>

                        <div id="accountPropertyAccess">
                            <p class="meta">Loading property access...</p>
                        </div>

                        <div
                            id="accountDeviceAccess"
                            class="account-access-devices"
                        >
                            <p class="meta">Loading device access...</p>
                        </div>
                    </div>

                    <div class="account-detail-section">
                        <h3>Account management</h3>

                        <div class="account-management-actions">
                            ${
                                canManage
                                    ? `
                                        <button
                                            type="button"
                                            id="detailEditAccount"
                                            class="primary-btn"
                                        >
                                            Edit account
                                        </button>

                                        <button
                                            type="button"
                                            id="detailResetPassword"
                                            class="mini-btn danger"
                                        >
                                            Reset password
                                        </button>
                                    `
                                    : `
                                        <span class="meta">
                                            You have view-only access to this account.
                                        </span>
                                    `
                            }
                        </div>
                    </div>

                </section>
            </div>
        `;

        document.getElementById('backToAccounts').addEventListener(
            'click',
            renderTenantList
        );

        document.getElementById('detailEditAccount')?.addEventListener(
            'click',
            () => openAccountEditor(account)
        );

        document.getElementById('detailResetPassword')?.addEventListener(
            'click',
            event => handleAccountPasswordReset(
                account,
                event.currentTarget
            )
        );

        // Load access information only after opening the detail view.
        renderAccountAccess(account);
    }

    // --------------------------------------------------
    // PASSWORD RESET
    // --------------------------------------------------

    async function handleAccountPasswordReset(account, button) {
        if (!account || !canEditAccount(account)) return;

        const confirmed = await getConfirmationDialog().show({
            title: 'Reset Password?',
            message: `A new temporary password will be generated for ${account.name || account.email}. The account holder will need to change it on their next sign-in.`,
            confirmText: 'Reset Password',
            cancelText: 'Cancel',
            danger: true
        });

        if (!confirmed) return;

        setButtonBusy(button, true, 'Resetting...');

        try {
            const result = await requestJson(
                `${API_BASE}/api/accounts/${encodeURIComponent(account.id)}/reset-password`,
                {
                    method: 'POST',
                    headers: getAuthHeaders()
                }
            );

            if (!result?.success || !result?.tempPassword) {
                throw new Error(
                    result?.message || 'Password reset was not confirmed.'
                );
            }

            getCredentialsDialog().show({
                accountEmail: account.email,
                tempPassword: result.tempPassword,
                emailSent: result.emailSent === true,
                action: 'reset'
            });

        } catch (error) {
            showAlert(
                mainPanelContent,
                error.message || 'Unable to reset password.',
                'error'
            );
        } finally {
            setButtonBusy(button, false);
        }
    }

    // --------------------------------------------------
    // ACCESS MANAGEMENT
    // --------------------------------------------------

    function attachAccessListeners(container, account) {
        container.querySelectorAll('[data-access-action]').forEach(button => {
            button.addEventListener('click', event => {
                handleAccountAccessAction(
                    account,
                    event.currentTarget
                );
            });
        });
    }

    async function renderAccountAccess(account) {
        const propertyContainer = document.getElementById(
            'accountPropertyAccess'
        );

        const deviceContainer = document.getElementById(
            'accountDeviceAccess'
        );

        if (!propertyContainer || !deviceContainer) return;

        const role = String(account.role || '').toLowerCase();
        const canManage = canEditAccount(account);
        const houses = getManageableHouses();

        // PROPERTY ACCESS

        if (role === 'user') {
            try {
                const propertyResults = await Promise.all(
                    houses.map(async house => {
                        const result = await requestJson(
                            `${API_BASE}/api/houses/${encodeURIComponent(house.id)}/access`,
                            { headers: getAuthHeaders() }
                        );

                        const users = result.users || [];

                        return {
                            house,
                            assigned: users.some(
                                user => Number(user.id) === Number(account.id)
                            )
                        };
                    })
                );

                propertyContainer.innerHTML = `
                    <h4>Property access</h4>

                    ${
                        propertyResults.length
                            ? propertyResults.map(({ house, assigned }) => `
                                <div class="account-access-row">
                                    <div>
                                        <strong>
                                            ${escapeHtml(house.name || `Property ${house.id}`)}
                                        </strong>

                                        <span class="meta">
                                            ${assigned ? 'Access assigned' : 'No access'}
                                        </span>
                                    </div>

                                    ${
                                        canManage
                                            ? assigned
                                                ? `
                                                    <button
                                                        type="button"
                                                        class="mini-btn danger"
                                                        data-access-action="remove-house"
                                                        data-house-id="${escapeHtml(house.id)}"
                                                    >
                                                        Remove
                                                    </button>
                                                `
                                                : `
                                                    <button
                                                        type="button"
                                                        class="mini-btn"
                                                        data-access-action="add-house"
                                                        data-house-id="${escapeHtml(house.id)}"
                                                    >
                                                        Grant access
                                                    </button>
                                                `
                                            : ''
                                    }
                                </div>
                            `).join('')
                            : '<p class="meta">No manageable properties found.</p>'
                    }
                `;

            } catch (error) {
                propertyContainer.innerHTML = `
                    <p class="error-text">
                        Unable to load property access:
                        ${escapeHtml(error.message)}
                    </p>
                `;
            }

        } else if (role === 'tenant') {
            const assignedHouseIds = new Set(
                (account.house_ids || []).map(Number)
            );

            const assignedHouses = houses.filter(
                house => assignedHouseIds.has(Number(house.id))
            );

            propertyContainer.innerHTML = `
                <h4>Property access</h4>

                ${
                    assignedHouses.length
                        ? assignedHouses.map(house => `
                            <div class="account-access-row">
                                <div>
                                    <strong>
                                        ${escapeHtml(house.name || `Property ${house.id}`)}
                                    </strong>

                                    <span class="meta">
                                        Tenant property assignment
                                    </span>
                                </div>

                                <span class="account-role">Assigned</span>
                            </div>
                        `).join('')
                        : '<p class="meta">No assigned properties.</p>'
                }

                <p class="meta">
                    Tenant property assignments are managed through Edit account.
                </p>
            `;

        } else {
            propertyContainer.innerHTML = `
                <h4>Property access</h4>

                <p class="meta">
                    Property access management is available for tenant
                    and regular user accounts.
                </p>
            `;
        }

        // Attach property listeners after rendering.
        attachAccessListeners(propertyContainer, account);

        // DEVICE ACCESS

        if (!['tenant', 'user'].includes(role)) {
            deviceContainer.innerHTML = `
                <h4>Device access</h4>
                <p class="meta">
                    Device access is not applicable to this account type.
                </p>
            `;
            return;
        }

        deviceContainer.innerHTML = `
            <h4>Device access</h4>
            <p class="meta">Loading devices...</p>
        `;

        try {
            const houseDevices = await Promise.all(
                houses.map(async house => {
                    const result = await requestJson(
                        `${API_BASE}/api/houses/${encodeURIComponent(house.id)}/devices`,
                        { headers: getAuthHeaders() }
                    );

                    return (result.devices || []).map(device => ({
                        ...device,
                        house_name: house.name || `House ${house.id}`
                    }));
                })
            );

            const devices = houseDevices.flat();

            const deviceResults = await Promise.all(
                devices.map(async device => {
                    const result = await requestJson(
                        `${API_BASE}/api/devices/${encodeURIComponent(device.id)}/access`,
                        { headers: getAuthHeaders() }
                    );

                    return {
                        device,
                        assigned: (result.users || []).some(
                            user => Number(user.id) === Number(account.id)
                        )
                    };
                })
            );

            deviceContainer.innerHTML = `
                <h4>Device access</h4>

                ${
                    deviceResults.length
                        ? deviceResults.map(({ device, assigned }) => `
                            <div class="account-access-row">
                                <div>
                                    <strong>
                                        ${escapeHtml(
                                            device.device_name ||
                                            device.name ||
                                            `Device ${device.id}`
                                        )}
                                    </strong>

                                    <span class="meta">
                                        ${escapeHtml(device.house_name)}
                                        ${
                                            device.device_type || device.type
                                                ? ` · ${escapeHtml(device.device_type || device.type)}`
                                                : ''
                                        }
                                    </span>

                                    <span class="meta">
                                        ${assigned ? 'Access assigned' : 'No access'}
                                    </span>
                                </div>

                                ${
                                    canManage
                                        ? assigned
                                            ? `
                                                <button
                                                    type="button"
                                                    class="mini-btn danger"
                                                    data-access-action="remove-device"
                                                    data-device-id="${escapeHtml(device.id)}"
                                                >
                                                    Remove
                                                </button>
                                            `
                                            : `
                                                <button
                                                    type="button"
                                                    class="mini-btn"
                                                    data-access-action="add-device"
                                                    data-device-id="${escapeHtml(device.id)}"
                                                >
                                                    Grant access
                                                </button>
                                            `
                                        : ''
                                }
                            </div>
                        `).join('')
                        : '<p class="meta">No devices found in your manageable properties.</p>'
                }
            `;

            // Attach device listeners after rendering.
            attachAccessListeners(deviceContainer, account);

        } catch (error) {
            deviceContainer.innerHTML = `
                <p class="error-text">
                    Unable to load device access:
                    ${escapeHtml(error.message)}
                </p>
            `;
        }
    }

    // --------------------------------------------------
    // GRANT / REMOVE ACCESS
    // --------------------------------------------------

    async function handleAccountAccessAction(account, button) {
        if (!account || !canEditAccount(account)) return;

        const action = button.dataset.accessAction;
        const houseId = button.dataset.houseId;
        const deviceId = button.dataset.deviceId;

        const isRemoval =
            action === 'remove-house' ||
            action === 'remove-device';

        if (isRemoval) {
            const confirmed = await getConfirmationDialog().show({
                title: 'Remove access?',
                message: `Remove ${account.name || account.email}'s access to this ${action === 'remove-house' ? 'property' : 'device'}?`,
                confirmText: 'Remove access',
                cancelText: 'Cancel',
                danger: true
            });

            if (!confirmed) return;
        }

        setButtonBusy(button, true, 'Saving...');

        try {
            let url;
            let method;
            let body;

            switch (action) {
                case 'add-house':
                    url = `${API_BASE}/api/houses/${encodeURIComponent(houseId)}/access`;
                    method = 'POST';
                    body = JSON.stringify({ user_id: account.id });
                    break;

                case 'remove-house':
                    url = `${API_BASE}/api/houses/${encodeURIComponent(houseId)}/access/${encodeURIComponent(account.id)}`;
                    method = 'DELETE';
                    break;

                case 'add-device':
                    url = `${API_BASE}/api/devices/${encodeURIComponent(deviceId)}/access`;
                    method = 'POST';
                    body = JSON.stringify({ user_id: account.id });
                    break;

                case 'remove-device':
                    url = `${API_BASE}/api/devices/${encodeURIComponent(deviceId)}/access/${encodeURIComponent(account.id)}`;
                    method = 'DELETE';
                    break;

                default:
                    return;
            }

            const result = await requestJson(url, {
                method,
                headers: getAuthHeaders(),
                ...(body ? { body } : {})
            });

            if (result?.success === false) {
                throw new Error(
                    result.message || 'Access update failed.'
                );
            }

            showAlert(
                mainPanelContent,
                'Account access updated successfully.',
                'success'
            );

            await renderAccountAccess(account);

        } catch (error) {
            showAlert(
                mainPanelContent,
                error.message || 'Unable to update account access.',
                'error'
            );
        } finally {
            setButtonBusy(button, false);
        }
    }

    // --------------------------------------------------
    // ACCOUNT EDITOR
    // --------------------------------------------------

    function openAccountEditor(account = null) {
        const dialog = document.getElementById('accountEditorDialog');
        const form = document.getElementById('accountEditorForm');
        const roles = document.getElementById('accountRole');

        roles.name = 'role';

        const houseSelect = document.getElementById('accountHouse');
        const isEdit = Boolean(account);
        const manageableHouses = getManageableHouses();

        const allowedRoles = state.role === 'admin'
            ? ['owner', 'tenant', 'user']
            : ['tenant', 'user'];

        roles.innerHTML = allowedRoles.map(role => `
            <option value="${role}">
                ${role === 'user'
                    ? 'Regular user'
                    : role[0].toUpperCase() + role.slice(1)}
            </option>
        `).join('');

        if (
            account &&
            !allowedRoles.includes(String(account.role || '').toLowerCase())
        ) {
            return;
        }

        houseSelect.innerHTML = manageableHouses.map(house => `
            <option value="${escapeHtml(house.id)}">
                ${escapeHtml(house.name || `Property ${house.id}`)}
            </option>
        `).join('');

        form.reset();

        form.elements.account_id.value = account?.id || '';

        roles.value = String(
            account?.role ||
            (state.role === 'admin' ? 'owner' : 'tenant')
        ).toLowerCase();

        roles.disabled = isEdit;

        form.elements.name.value = account?.name || '';
        form.elements.email.value = account?.email || '';

        [...houseSelect.options].forEach(option => {
            option.selected = (account?.house_ids || [])
                .map(Number)
                .includes(Number(option.value));
        });

        form.elements.leased_unit.value = account?.leased_unit || '';
        form.elements.rent_amount.value = account?.rent_amount ?? '';
        form.elements.deposit.value = account?.deposit ?? 0;
        form.elements.balance.value = account?.balance ?? 0;
        form.elements.billing_cycle.value = account?.billing_cycle || 'monthly';

        form.elements.onboard_date.value = account?.onboard_date
            ? String(account.onboard_date).slice(0, 10)
            : [
                new Date().getFullYear(),
                String(new Date().getMonth() + 1).padStart(2, '0'),
                String(new Date().getDate()).padStart(2, '0')
            ].join('-');

        document.getElementById('accountEditorTitle').textContent =
            isEdit ? 'Edit account' : 'Create account';

        document.getElementById('accountEditorSubmit').textContent =
            isEdit ? 'Save changes' : 'Create account';

        document.getElementById('accountEditorHint').textContent =
            isEdit
                ? 'Email and account details will be updated. Passwords and existing device permissions are not changed.'
                : 'New accounts receive a temporary password and must change it on first sign-in.';

        clearAlert(document.getElementById('accountEditorAlert'));

        const sync = () => {
            const isTenant = roles.value === 'tenant';

            document.querySelectorAll(
                '#accountEditorForm .account-tenant-only'
            ).forEach(field => {
                field.hidden = !isTenant;

                field.querySelectorAll('input,select').forEach(input => {
                    input.required =
                        isTenant && input.name === 'rent_amount';
                });
            });

            document.getElementById('accountHouseField').hidden =
                roles.value === 'owner';

            houseSelect.required = roles.value !== 'owner';
            houseSelect.multiple = roles.value === 'user';
        };

        roles.onchange = sync;
        sync();

        dialog.showModal();
    }

    // --------------------------------------------------
    // SAVE ACCOUNT
    // --------------------------------------------------

    async function handleAccountEditor(event) {
        event.preventDefault();

        const form = event.currentTarget;
        const button = document.getElementById('accountEditorSubmit');
        const alert = document.getElementById('accountEditorAlert');
        const values = new FormData(form);

        const accountId = String(
            values.get('account_id') || ''
        ).trim();

        const existingAccount = accountId
            ? state.accounts.find(
                account => Number(account.id) === Number(accountId)
            )
            : null;

        const role = String(
            existingAccount?.role || values.get('role') || ''
        ).toLowerCase();

        const houseSelect = document.getElementById('accountHouse');

        const houseIds = role === 'owner'
            ? []
            : [...houseSelect.selectedOptions]
                .map(option => Number(option.value))
                .filter(Boolean);

        const payload = {
            role,
            name: String(values.get('name') || '').trim(),
            email: String(values.get('email') || '').trim(),
            house_ids: houseIds
        };

        if (!payload.name || !payload.email) {
            return showAlert(
                alert,
                'Name and email are required.',
                'error'
            );
        }

        if (role !== 'owner' && !houseIds.length) {
            return showAlert(
                alert,
                'Assign at least one property to this account.',
                'error'
            );
        }

        if (role === 'tenant') {
            Object.assign(payload, {
                house_id: houseIds[0],
                leased_unit: String(
                    values.get('leased_unit') || ''
                ).trim(),
                rent_amount: Number(values.get('rent_amount')),
                deposit: Number(values.get('deposit') || 0),
                balance: Number(values.get('balance') || 0),
                billing_cycle: String(
                    values.get('billing_cycle') || 'monthly'
                ),
                onboard_date: String(
                    values.get('onboard_date') || ''
                )
            });
        }

        setButtonBusy(button, true, 'Saving…');

        let createdAccount = null;
        let successMessage = '';

        try {
            if (accountId) {
                await requestJson(
                    `${API_BASE}/api/accounts/${encodeURIComponent(accountId)}`,
                    {
                        method: 'PUT',
                        headers: getAuthHeaders(),
                        body: JSON.stringify(payload)
                    }
                );

                successMessage = 'Account updated successfully.';

            } else {
                createdAccount = await requestJson(
                    `${API_BASE}/api/provisioning/register`,
                    {
                        method: 'POST',
                        headers: getAuthHeaders(),
                        body: JSON.stringify(payload)
                    }
                );

                if (
                    !createdAccount?.success ||
                    !createdAccount.user?.id ||
                    !createdAccount.tempPassword
                ) {
                    throw new Error(
                        createdAccount?.message ||
                        'Account creation was not confirmed.'
                    );
                }

                successMessage = 'Account created successfully.';
            }

            await loadDashboardData();

        } catch (error) {
            showAlert(
                alert,
                error.message || 'Unable to save account.',
                'error'
            );
            return;

        } finally {
            setButtonBusy(button, false);
        }

        if (createdAccount) {
            document.getElementById('accountEditorDialog').close();

            getCredentialsDialog().show({
                accountEmail: payload.email,
                tempPassword: createdAccount.tempPassword,
                emailSent: createdAccount.emailSent === true,
                action: 'created'
            });

        } else {
            showAlert(alert, successMessage, 'success');
        }
    }

    return {
        getManageableHouses,
        canEditAccount,
        renderTenantList,
        openAccountEditor,
        handleAccountEditor
    };
}
