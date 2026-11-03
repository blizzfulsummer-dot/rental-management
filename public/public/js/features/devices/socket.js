/** Short-lived, ticket-authenticated WebSocket helpers for ESP device commands. */
export function createDeviceSocketService({ API_BASE, WS_BASE, requestJson, getAuthHeaders }) {
  async function openDeviceSocket(deviceId, houseId) {
    const ticketData = await requestJson(`${API_BASE}/ws/ticket`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ houseId: Number(houseId), deviceId: Number(deviceId), clientType: 'web' })
    });
    if (!ticketData?.ticket) throw new Error('The server did not issue a device connection ticket.');

    const socket = new WebSocket(`${WS_BASE}/ws/house/${Number(houseId)}?ticket=${encodeURIComponent(ticketData.ticket)}`);
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          window.clearTimeout(timeout);
          socket.removeEventListener('open', onOpen);
          socket.removeEventListener('error', onError);
          socket.removeEventListener('close', onClose);
        };
        const finish = error => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve();
        };
        const timeout = window.setTimeout(() => finish(new Error('Could not connect to the device control channel.')), 10000);
        const onOpen = () => finish();
        const onError = () => finish(new Error('Could not connect to the device control channel.'));
        const onClose = () => finish(new Error('Device control connection closed before opening.'));
        socket.addEventListener('open', onOpen);
        socket.addEventListener('error', onError);
        socket.addEventListener('close', onClose);
      });
      return socket;
    } catch (error) {
      if (socket.readyState < WebSocket.CLOSING) socket.close();
      throw error;
    }
  }

  function sendPersistentDeviceCommand(socket, deviceId, command, fields = {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('The device control connection is not open.');
    }
    const commandId = fields.commandId || createCommandId();
    socket.send(JSON.stringify({
      type: 'device_command',
      targetDeviceId: Number(deviceId),
      command,
      ...fields,
      commandId
    }));
    return commandId;
  }

  function createCommandId() {
    if (!globalThis.crypto?.randomUUID) {
      throw new Error('This browser cannot create a secure command ID.');
    }
    return globalThis.crypto.randomUUID();
  }

  function waitForSocketResponse(socket, matches, timeoutMessage, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      let settled = false;
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
      const timeout = window.setTimeout(() => finish(new Error(timeoutMessage)), timeoutMs);
      const onMessage = event => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'error') return finish(new Error(message.error || 'Device command failed.'));
        if (!matches(message)) return;
        if (message.success === false) finish(new Error(message.message || 'The device rejected the command.'));
        else finish(null, message);
      };
      const onClose = () => finish(new Error('Device disconnected before responding.'));
      const onError = () => finish(new Error('Device control connection failed.'));
      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', onClose);
      socket.addEventListener('error', onError);
    });
  }

  function waitForDeviceResponse(socket, deviceId, command) {
    const commandId = createCommandId();
    const response = waitForSocketResponse(
      socket,
      message => message.type === 'device_response' &&
        Number(message.deviceId) === Number(deviceId) &&
        message.command === command &&
        message.commandId === commandId,
      'The device did not respond to the fingerprint sensor check.'
    );
    sendPersistentDeviceCommand(socket, deviceId, command, { commandId });
    return response;
  }

  return {
    openDeviceSocket,
    createCommandId,
    sendPersistentDeviceCommand,
    waitForSocketResponse,
    waitForDeviceResponse
  };
}
