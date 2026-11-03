/** Fingerprint enrollment and template-management interactions. */
export function bindFingerprintHandlers({ root, state, API_BASE, requestJson, getAuthHeaders, openDeviceSocket, createCommandId, waitForDeviceResponse, waitForSocketResponse, sendPersistentDeviceCommand, refreshDevices, showAlert, deviceNotice }) {
      root.querySelectorAll('[data-fingerprint-enroll]').forEach(button => {
        button.addEventListener('click', async () => {
          const deviceId = Number(button.dataset.deviceId);
          const current = (state.fingerprints[deviceId] || []).find(item => Number(item.user_id) === Number(state.profile?.id));
          if (current?.status === 'active' && !window.confirm('Re-enroll and replace your current fingerprint on this device?')) return;
          button.disabled = true;
          let socket;
          let enrollmentReserved = false;
          const status = document.querySelector(`[data-fingerprint-status="${deviceId}"]`);
          try {
            socket = await openDeviceSocket(deviceId);
            const sensorStatus = await waitForDeviceResponse(socket, deviceId, 'fingerprint.status');
            if (!/sensor connected/i.test(sensorStatus.message || '')) {
              throw new Error('Fingerprint sensor is not connected to the device.');
            }
            const reservation = await requestJson(`${API_BASE}/api/devices/${deviceId}/fingerprints/enroll`, {
              method: 'POST',
              headers: getAuthHeaders(),
              body: JSON.stringify({})
            });
            enrollmentReserved = true;

            const commandId = createCommandId();
            const outcome = await new Promise((resolve, reject) => {
              let settled = false;
              const timeout = window.setTimeout(() => finish(new Error('Fingerprint enrollment timed out. You can try again.')), 70000);
              const cleanup = () => {
                window.clearTimeout(timeout);
                socket.removeEventListener('message', onMessage);
                socket.removeEventListener('close', onClose);
                socket.removeEventListener('error', onError);
              };
              const finish = (error, result) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (error) reject(error);
                else resolve(result);
              };
              const onMessage = event => {
                let message;
                try { message = JSON.parse(event.data); } catch { return; }
                if (message.type === 'device_response' &&
                    Number(message.deviceId) === deviceId &&
                    message.command === 'fingerprint.register' &&
                    message.commandId === commandId) {
                  if (message.success === false) {
                    finish(new Error(message.message || 'The device rejected fingerprint enrollment.'));
                  } else {
                    if (status) status.textContent = `Place your finger on the sensor for slot ${reservation.fingerprintId}. Follow the sensor prompts.`;
                  }
                } else if (message.type === 'fingerprint.event' && Number(message.deviceId) === deviceId &&
                           Number(message.id) === Number(reservation.fingerprintId) &&
                           ['enrollment_place_finger', 'enrollment_remove_finger', 'enrollment_place_same_finger'].includes(message.event)) {
                  if (status) status.textContent = message.message || 'Follow the fingerprint sensor prompt.';
                } else if (message.type === 'fingerprint.event' && Number(message.deviceId) === deviceId &&
                           Number(message.id) === Number(reservation.fingerprintId) &&
                           ['enrollment_complete', 'enrollment_failed'].includes(message.event)) {
                  finish(null, { success: message.event === 'enrollment_complete' && message.success === true, message: message.message });
                } else if (message.type === 'error') {
                  finish(new Error(message.error || 'Fingerprint enrollment failed.'));
                }
              };
              const onClose = () => finish(new Error('Device disconnected before enrollment completed.'));
              const onError = () => finish(new Error('Device connection failed during fingerprint enrollment.'));
              socket.addEventListener('message', onMessage);
              socket.addEventListener('close', onClose);
              socket.addEventListener('error', onError);
              try {
                sendPersistentDeviceCommand(socket, deviceId, 'fingerprint.register', {
                id: reservation.fingerprintId,
                  commandId
                });
              } catch (error) {
                finish(error);
              }
            });

            if (!outcome.success) throw new Error(outcome.message || 'Fingerprint enrollment failed.');
            enrollmentReserved = false;
            await refreshDevices();
            const updatedStatus = document.querySelector(`[data-fingerprint-status="${deviceId}"]`);
            if (updatedStatus) updatedStatus.textContent = 'Fingerprint registered successfully.';
          } catch (error) {
            if (enrollmentReserved) {
              try {
                await requestJson(`${API_BASE}/api/devices/${deviceId}/fingerprints/enroll`, {
                  method: 'DELETE',
                  headers: getAuthHeaders()
                });
              } catch (cancelError) {
                console.error('Could not cancel reserved fingerprint enrollment:', cancelError);
              }
            }
            if (status) status.textContent = error.message || 'Fingerprint enrollment failed.';
          } finally {
            if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
            button.disabled = false;
          }
        });
      });

      root.querySelectorAll('[data-fingerprint-action]').forEach(button => {
        button.addEventListener('click', async () => {
          const action = button.dataset.fingerprintAction;
          const deviceId = Number(button.dataset.deviceId);
          const fingerprintId = Number(button.dataset.fingerprintId);
          if (!window.confirm(`${action === 'disable' ? 'Disable' : 'Delete'} this fingerprint? The template will be removed from the sensor.`)) return;
          button.disabled = true;
          let socket;
          try {
            socket = await openDeviceSocket(deviceId);
            const commandId = createCommandId();
            const responsePromise = waitForSocketResponse(
              socket,
              message => message.type === 'device_response' &&
                Number(message.deviceId) === deviceId &&
                message.command === 'fingerprint.delete' &&
                message.commandId === commandId,
              'The device did not confirm fingerprint removal.'
            );
            sendPersistentDeviceCommand(socket, deviceId, 'fingerprint.delete', {
              id: fingerprintId,
              commandId
            });
            await responsePromise;
            await requestJson(`${API_BASE}/api/devices/${deviceId}/fingerprints/${fingerprintId}`, {
              method: 'DELETE',
              headers: getAuthHeaders(),
              body: JSON.stringify({ action })
            });
            await refreshDevices();
          } catch (error) {
            showAlert(document.getElementById('deviceNotice') || deviceNotice, error.message || 'Unable to remove fingerprint.', 'error');
          } finally {
            if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
            button.disabled = false;
          }
        });
      });


}
