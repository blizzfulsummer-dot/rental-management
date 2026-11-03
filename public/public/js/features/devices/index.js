import { createDeviceSocketService } from './socket.js';
import { bindFingerprintHandlers } from './fingerprints.js';

/**
 * Device management feature.
 *
 * Owns device rendering, access management, pairing, WebSocket commands, and
 * fingerprint enrollment UI. Dependencies are injected from the app bootstrap
 * so this module does not own global application state or API configuration.
 */
export function createDeviceFeature({
  state, mainPanelContent, API_BASE, WS_BASE, escapeHtml,
  canManageDeviceAccess, showAlert, requestJson, getAuthHeaders,
  setButtonBusy, loadDashboardData, renderMainPanel
}) {
    const deviceSocket = createDeviceSocketService({ API_BASE, WS_BASE, requestJson, getAuthHeaders });

    function renderDeviceList() {
      if (!state.houses.length) {
        mainPanelContent.innerHTML = '<div class="empty">No property is assigned to this account, so there are no property devices to show.</div>';
        return;
      }

      const selectedHouse = state.houses.find(house => Number(house.id) === Number(state.selectedHouseId)) || state.houses[0];
      state.selectedHouseId = Number(selectedHouse.id);
      const selectedHouseId = selectedHouse.id;
      const {
        openDeviceSocket,
        createCommandId,
        sendPersistentDeviceCommand,
        waitForSocketResponse,
        waitForDeviceResponse
      } = deviceSocket;
      const canManageDevices = state.role === 'admin' || state.role === 'owner';
      const visibleDevices = state.devices.filter(device => {
        return Number(device.house_id) === Number(selectedHouseId);
      });

      const cards = visibleDevices.map(device => `
        ${(() => {
          const enrollments = state.fingerprints[device.id] || [];
          const mine = enrollments.find(item => Number(item.user_id) === Number(state.profile?.id));
          const isUserOrTenant = ['user', 'tenant'].includes(String(state.role || '').toLowerCase());
          const hasActiveFingerprint = mine?.status === 'active' && !mine.enrollment_pending;
          const showUnlockButton = !isUserOrTenant || !hasActiveFingerprint;
          const deviceUsers = state.deviceAccess[device.id] || [];
          const deviceUserIds = new Set(deviceUsers.map(user => Number(user.id)));
          const availableUsers = state.provisionableUsers.filter(user => !deviceUserIds.has(Number(user.id)));
          const fingerprintRows = enrollments.map(item => `
            <div class="inline-actions">
              <span class="meta">Slot ${escapeHtml(item.fingerprint_id)}: ${escapeHtml(item.name || item.email || `User ${item.user_id}`)}: ${escapeHtml(item.status)}${item.enrollment_pending ? ' (enrollment in progress)' : ''}</span>
              ${canManageDevices && item.status !== 'disabled' ? `
                <button class="mini-btn" type="button" data-fingerprint-action="disable" data-device-id="${escapeHtml(device.id)}" data-fingerprint-id="${escapeHtml(item.fingerprint_id)}">Disable</button>
                <button class="mini-btn" type="button" data-fingerprint-action="delete" data-device-id="${escapeHtml(device.id)}" data-fingerprint-id="${escapeHtml(item.fingerprint_id)}">Delete</button>
              ` : ''}
            </div>
          `).join('');
          return `
        <article class="device-card device-card-modern">
          <div class="device-card-head">
            <div class="device-icon-tile" aria-hidden="true">⌁</div>
            <div class="device-card-title"><span class="device-kicker">CONNECTED DEVICE</span><h3>${escapeHtml(device.device_name || `Device ${device.id}`)}</h3><div class="meta">${escapeHtml(device.type || 'Unknown')} <span class="meta-dot">•</span> ${escapeHtml(selectedHouse.name || `Property ${selectedHouse.id}`)}</div></div>
            <span class="device-status ${['online', 'active', 'on'].includes(String(device.status || '').toLowerCase()) ? 'online' : 'offline'}"><span class="status-dot"></span>${escapeHtml(device.status || 'offline')}</span>
          </div>
          <div class="device-card-divider"></div>
          <div class="device-section-label">QUICK CONTROLS</div>
          <div class="inline-actions">
                ${showUnlockButton ? `
    <button class="mini-btn" type="button"
      data-device-command="door.unlock"
      data-device-id="${escapeHtml(device.id)}">Unlock Door</button>
  ` : ''}

  ${!isUserOrTenant ? `
    <button class="mini-btn" type="button" data-device-command="door.lock" data-device-id="${escapeHtml(device.id)}">Lock door</button>
    <button class="mini-btn" type="button" data-device-command="io.set" data-control-id="relay2" data-control-state="true" data-device-id="${escapeHtml(device.id)}">Relay 2 on</button>
    <button class="mini-btn" type="button" data-device-command="io.set" data-control-id="relay2" data-control-state="false" data-device-id="${escapeHtml(device.id)}">Relay 2 off</button>
  ` : ''}
</div>
          <div class="device-edit-form">
            <strong>Fingerprint Access</strong>
            <p class="meta">${mine ? `Your fingerprint: slot ${mine.fingerprint_id} (${escapeHtml(mine.status)}${mine.enrollment_pending ? ', enrollment in progress' : ''})` : 'No fingerprint is registered for your account on this device.'}</p>
            <div class="inline-actions">
            <button class="mini-btn" type="button" data-fingerprint-enroll data-device-id="${escapeHtml(device.id)}">${isUserOrTenant ? 'Register My Fingerprint' : mine?.status === 'active' ? 'Re-enroll my fingerprint' : 'Register My Fingerprint'}</button>  
            </div>
            ${canManageDevices ? fingerprintRows : ''}
            <div class="meta" data-fingerprint-status="${escapeHtml(device.id)}" aria-live="polite"></div>
          </div>
          ${canManageDeviceAccess(device) ? `
            <section class="device-edit-form">
              <strong>Provision user or tenant access</strong>
              ${availableUsers.length ? `
                <form class="device-access-form" data-device-id="${escapeHtml(device.id)}">
                  <select name="user_id" aria-label="User or tenant" required>
                    <option value="">Select a user or tenant</option>
                    ${availableUsers.map(user => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name || user.email)} (${escapeHtml(user.role)})</option>`).join('')}
                  </select>
                  <button class="mini-btn" type="submit">Grant device access</button>
                </form>
              ` : '<p class="meta">No additional users or tenants are available to assign.</p>'}
              ${deviceUsers.length ? deviceUsers.map(user => `
                <div class="inline-actions">
                  <span class="meta">${escapeHtml(user.name || user.email)} (${escapeHtml(user.role)})</span>
                  <button class="mini-btn danger" type="button" data-revoke-device-access="${escapeHtml(device.id)}" data-user-id="${escapeHtml(user.id)}">Revoke</button>
                </div>
              `).join('') : '<p class="meta">No users currently have access to this device.</p>'}
            </section>
          ` : ''}
          ${canManageDevices ? `
            
<div class="inline-actions">
  <button
    class="mini-btn"
    type="button"
    data-edit-device="${escapeHtml(device.id)}">
    Edit
  </button>

  <button
    class="mini-btn danger"
    type="button"
    data-delete-device="${escapeHtml(device.id)}">
    Delete
  </button>
</div>

<form
  class="device-edit-form"
  data-device-id="${escapeHtml(device.id)}"
  hidden>

  <input
    name="name"
    aria-label="Device name"
    value="${escapeHtml(device.device_name || '')}"
    required />

  <input
    name="type"
    aria-label="Device type"
    value="${escapeHtml(device.device_type || '')}"
    required />

  <div class="inline-actions">
    <button class="mini-btn" type="submit">Save</button>
    <button class="mini-btn" type="button" data-cancel-device-edit>
      Cancel
    </button>
  </div>
</form>

            <div class="inline-actions">
  <span class="tag">
    ${device.pairing_configured ? 'Paired' : 'Not paired'}
  </span>

  <button class="mini-btn" type="button"
    data-pair-device="${escapeHtml(device.id)}">
    ${device.pairing_configured ? 'Regenerate pairing key' : 'Pair device'}
  </button>
</div>
          ` : ''}
        </article>
          `;
        })()}
      `).join('');

      const houseOptions = state.houses.map(house => `
        <option value="${escapeHtml(house.id)}" ${Number(house.id) === Number(selectedHouseId) ? 'selected' : ''}>
          ${escapeHtml(house.name || `Property ${house.id}`)}
        </option>
      `).join('');
      const deviceContent = visibleDevices.length
        ? `<div class="card-grid">${cards}</div>`
        : '<div class="empty">No devices are associated with this property yet.</div>';
      const addDeviceForm = canManageDevices ? `
        <form id="addDeviceForm" class="device-edit-form">
          <strong>Add a device to ${escapeHtml(selectedHouse.name || `Property ${selectedHouse.id}`)}</strong>
          <input name="name" aria-label="New device name" placeholder="Device name" required />
          <input name="type" aria-label="New device type" placeholder="Device type (e.g. Switch)" required />
          <button class="primary-btn" type="submit">Add device</button>
        </form>
      ` : '';

      mainPanelContent.innerHTML = `
        <label class="house-selector" for="deviceHouseSelect">
          Devices for Property
          <select id="deviceHouseSelect">${houseOptions}</select>
        </label>
        <div id="deviceNotice" class="alert"></div>
        ${addDeviceForm}
        ${deviceContent}
      `;
      document.getElementById('deviceHouseSelect').addEventListener('change', event => {
        state.selectedHouseId = Number(event.target.value);
        renderMainPanel();
      });

        mainPanelContent.querySelectorAll('[data-edit-device]').forEach(button => {
  button.addEventListener('click', () => {
    const deviceId = button.dataset.editDevice;
    const form = mainPanelContent.querySelector(
      `form.device-edit-form[data-device-id="${deviceId}"]`
    );

    if (!form) return;

    form.hidden = false;
    button.hidden = true;
  });
});

mainPanelContent.querySelectorAll('[data-cancel-device-edit]').forEach(button => {
  button.addEventListener('click', () => {
    const form = button.closest('form.device-edit-form');
    if (!form) return;

    form.reset();
    form.hidden = true;

    const editButton = mainPanelContent.querySelector(
      `[data-edit-device="${form.dataset.deviceId}"]`
    );

    if (editButton) editButton.hidden = false;
  });
});

      const deviceNotice = document.getElementById('deviceNotice');
      mainPanelContent.querySelectorAll('.device-access-form').forEach(form => {
        form.addEventListener('submit', async event => {
          event.preventDefault();
          const deviceId = Number(form.dataset.deviceId);
          const userId = Number(new FormData(form).get('user_id'));
          const button = form.querySelector('button[type="submit"]');
          button.disabled = true;
          try {
            const result = await requestJson(`${API_BASE}/api/devices/${deviceId}/access`, {
              method: 'POST',
              headers: getAuthHeaders(),
              body: JSON.stringify({ user_id: userId })
            });
            state.deviceAccess[deviceId] = [...(state.deviceAccess[deviceId] || []), result.user];
            renderMainPanel();
            showAlert(document.getElementById('deviceNotice'), `Device access granted to ${result.user.name || result.user.email}.`, 'success');
          } catch (error) {
            showAlert(deviceNotice, error.message || 'Unable to grant device access.', 'error');
            button.disabled = false;
          }
        });
      });



      mainPanelContent.querySelectorAll('[data-revoke-device-access]').forEach(button => {
        button.addEventListener('click', async () => {
          const deviceId = Number(button.dataset.revokeDeviceAccess);
          const userId = Number(button.dataset.userId);
          button.disabled = true;
          let socket;
          try {
            const fingerprintData = await requestJson(
              `${API_BASE}/api/devices/${deviceId}/fingerprints`,
              { headers: getAuthHeaders() }
            );
            const fingerprint = (fingerprintData?.enrollments || []).find(
              item => Number(item.user_id) === userId
            );
            if (fingerprint?.enrollment_pending) {
              showAlert(
                deviceNotice,
                'Finish or cancel fingerprint enrollment before revoking this user\'s device access.',
                'error'
              );
              return;
            }
            if (!window.confirm(
              `Revoke this user's access to the device${fingerprint?.status === 'active' ? ' and remove their fingerprint from it' : ''}?`
            )) return;

            if (fingerprint?.status === 'active') {
              socket = await openDeviceSocket(deviceId, selectedHouseId);
              const commandId = createCommandId();
              const responsePromise = waitForSocketResponse(
                socket,
                message => message.type === 'device_response' &&
                  Number(message.deviceId) === deviceId &&
                  message.command === 'fingerprint.delete' &&
                  message.commandId === commandId,
                'The device did not confirm fingerprint removal. Access was not revoked.'
              );
              sendPersistentDeviceCommand(socket, deviceId, 'fingerprint.delete', {
                id: Number(fingerprint.fingerprint_id),
                commandId
              });
              await responsePromise;
            }

            await requestJson(`${API_BASE}/api/devices/${deviceId}/access/${userId}`, {
              method: 'DELETE',
              headers: getAuthHeaders()
            });
            state.deviceAccess[deviceId] = (state.deviceAccess[deviceId] || []).filter(user => Number(user.id) !== userId);
            renderMainPanel();
            showAlert(
              document.getElementById('deviceNotice'),
              fingerprint?.status === 'active'
                ? 'Device access revoked and fingerprint removed from the device.'
                : 'Device access revoked.',
              'success'
            );
          } catch (error) {
            showAlert(deviceNotice, error.message || 'Unable to revoke device access.', 'error');
            button.disabled = false;
          } finally {
            if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
          }
        });
      });
      function showPairingKey(deviceId, pairingKey) {
        const notice = document.getElementById('deviceNotice');
        if (!notice) return;
        const panel = document.createElement('div');
        panel.className = 'pairing-key-panel';
        const apiUrl = new URL(API_BASE);
        const heading = document.createElement('strong');
        heading.textContent = 'One-time ESP32 pairing key';
        const instructions = document.createElement('p');
        instructions.textContent = `Save this key now. In the ESP32 setup portal configure API host ${apiUrl.hostname}, port ${apiUrl.port || (apiUrl.protocol === 'https:' ? '443' : '80')}, secure ${apiUrl.protocol === 'https:' ? 'true' : 'false'}, device ID ${deviceId}, enable authentication, and paste the key as the device credential. The key will not be shown again.`;
        const key = document.createElement('code');
        key.textContent = pairingKey;
        const copy = document.createElement('button');
        copy.className = 'mini-btn';
        copy.type = 'button';
        copy.textContent = 'Copy pairing key';
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(pairingKey);
            copy.textContent = 'Copied';
          } catch {
            copy.textContent = 'Select and copy the key above';
          }
        });
        panel.append(heading, instructions, key, copy);
        notice.replaceChildren(panel);
        notice.className = 'alert success show';
      }
      const refreshDevices = async () => {
        state.devices = [];
        await loadDashboardData();
        state.activeView = 'devices';
        renderMainPanel();
      };

      bindFingerprintHandlers({
        root: mainPanelContent, state, API_BASE, requestJson, getAuthHeaders,
        openDeviceSocket: deviceId => openDeviceSocket(deviceId, selectedHouseId),
        createCommandId, waitForDeviceResponse, waitForSocketResponse, sendPersistentDeviceCommand,
        refreshDevices, showAlert, deviceNotice
      });

      document.getElementById('addDeviceForm')?.addEventListener('submit', async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector('button[type="submit"]');
        const formData = new FormData(form);
        setButtonBusy(button, true, 'Adding device…');
        try {
          const result = await requestJson(`${API_BASE}/api/houses/${selectedHouseId}/devices`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ name: formData.get('name'), type: formData.get('type') })
          });
          await refreshDevices();
          showPairingKey(result.device.id, result.pairing_key);
        } catch (error) {
          showAlert(document.getElementById('deviceNotice') || deviceNotice, error.message || 'Unable to add device.', 'error');
        } finally {
          setButtonBusy(button, false);
        }
      });

      mainPanelContent.querySelectorAll('form.device-edit-form[data-device-id]').forEach(form => {
        form.addEventListener('submit', async event => {
          event.preventDefault();
          const button = form.querySelector('button[type="submit"]');
          const formData = new FormData(form);
          setButtonBusy(button, true, 'Saving device…');
          try {
            await requestJson(`${API_BASE}/api/devices/${form.dataset.deviceId}`, {
              method: 'PUT',
              headers: getAuthHeaders(),
              body: JSON.stringify({ name: formData.get('name'), type: formData.get('type') })
            });
            await refreshDevices();
          } catch (error) {
            showAlert(document.getElementById('deviceNotice') || deviceNotice, error.message || 'Unable to update device.', 'error');
          } finally {
            setButtonBusy(button, false);
          }
        });
      });

      mainPanelContent.querySelectorAll('[data-delete-device]').forEach(button => {
        button.addEventListener('click', async () => {
          if (!window.confirm('Delete this device?')) return;
          try {
            await requestJson(`${API_BASE}/api/devices/${button.dataset.deleteDevice}`, {
              method: 'DELETE',
              headers: getAuthHeaders()
            });
            await refreshDevices();
          } catch (error) {
            showAlert(document.getElementById('deviceNotice') || deviceNotice, error.message || 'Unable to delete device.', 'error');
          }
        });
      });

      mainPanelContent.querySelectorAll('[data-pair-device]').forEach(button => {
        button.addEventListener('click', async () => {
          if (!window.confirm('Generate a new pairing key? The current key will stop working.')) return;
          setButtonBusy(button, true, 'Pairing…');
          try {
            const result = await requestJson(`${API_BASE}/api/devices/${button.dataset.pairDevice}/pairing-key`, {
              method: 'POST',
              headers: getAuthHeaders()
            });
            await refreshDevices();
            showPairingKey(button.dataset.pairDevice, result.pairing_key);
          } catch (error) {
            showAlert(document.getElementById('deviceNotice') || deviceNotice, error.message || 'Unable to pair device.', 'error');
          } finally {
            setButtonBusy(button, false);
          }
        });
      });

      mainPanelContent.querySelectorAll('[data-device-command]').forEach(button => {
        button.addEventListener('click', async () => {
          const deviceId = Number(button.dataset.deviceId);
          const command = button.dataset.deviceCommand;
          setButtonBusy(button, true, 'Sending…');
          let socket;
          try {
            socket = await openDeviceSocket(deviceId, selectedHouseId);
            const commandId = createCommandId();
            const responsePromise = waitForSocketResponse(
              socket,
              message => message.type === 'device_response' &&
                Number(message.deviceId) === deviceId &&
                message.command === command &&
                message.commandId === commandId,
              'The device did not confirm the command.'
            );
            socket.send(JSON.stringify({
              type: 'device_command', targetDeviceId: deviceId, command,
              commandId,
              id: button.dataset.controlId || '',
              state: button.dataset.controlState === 'true', params: {}
            }));
            await responsePromise;
            showAlert(deviceNotice, 'Device command confirmed.', 'success');
          } catch (error) {
            showAlert(deviceNotice, error.message || 'Unable to control device.', 'error');
          } finally {
            if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
            setButtonBusy(button, false);
          }
        });
      });
    }


  return { renderDeviceList };
}
