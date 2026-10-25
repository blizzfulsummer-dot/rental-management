/**
 * ReMan HouseRoom Durable Object
 *
 * Uses Cloudflare's WebSocket Hibernation API.
 *
 * Preserves:
 * - ESP32 JSON message formats
 * - Device online/offline persistence in D1
 * - Web-to-device command routing
 * - Fingerprint enrollment, deletion, recognition, and door unlocking
 * - Session/device broadcasts
 * - Stale-session cleanup through Durable Object alarms
 *
 * IMPORTANT:
 * The Worker that forwards requests here must validate the single-use
 * WebSocket ticket before supplying identity metadata in the URL.
 *
 * This class is not a substitute for ticket validation.
 */

export class HouseRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.houseId =
      Number(String(state.id).match(/house-(\d+)/)?.[1]) || null;

    // Rebuild the in-memory index after a hibernation wake-up.
    // The WebSockets and their serialized attachments are authoritative.
    this.sessions = new Map();

    for (const ws of this.state.getWebSockets()) {
      try {
        const attachment = ws.deserializeAttachment();

        if (
          attachment &&
          typeof attachment.sessionId === "string"
        ) {
          this.sessions.set(attachment.sessionId, {
            ...attachment,
            ws
          });
        }
      } catch (error) {
        console.error(
          `[HouseRoom ${this.houseId}] Failed to restore WebSocket attachment:`,
          error
        );
      }
    }
  }

  // ---------------------------------------------------------
  // Session and WebSocket helpers
  // ---------------------------------------------------------

  getSession(ws) {
    const attachment = ws.deserializeAttachment();
    if (!attachment || !attachment.sessionId) return null;

    return {
      ...attachment,
      ws
    };
  }

  saveSession(session) {
    const {
      ws,
      ...attachment
    } = session;

    ws.serializeAttachment(attachment);
    this.sessions.set(session.sessionId, session);
  }

  send(ws, message) {
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error(
        `[HouseRoom ${this.houseId}] WebSocket send failed:`,
        error
      );
      return false;
    }
  }

  sendError(ws, error) {
    this.send(ws, {
      type: "error",
      error,
      timestamp: new Date().toISOString()
    });
  }

  getAllSessions() {
    const sessions = [];

    for (const ws of this.state.getWebSockets()) {
      try {
        const attachment = ws.deserializeAttachment();

        if (attachment?.sessionId) {
          const session = { ...attachment, ws };
          this.sessions.set(session.sessionId, session);
          sessions.push(session);
        }
      } catch (error) {
        console.error(
          `[HouseRoom ${this.houseId}] Failed to read session attachment:`,
          error
        );
      }
    }

    return sessions;
  }

  broadcastToClients(
    message,
    excludeSessionId = null,
    filterClientType = null
  ) {
    const messageStr = JSON.stringify(message);

    for (const session of this.getAllSessions()) {
      if (session.sessionId === excludeSessionId) continue;

      if (
        filterClientType &&
        session.clientType !== filterClientType
      ) {
        continue;
      }

      try {
        session.ws.send(messageStr);
      } catch (error) {
        console.error(
          `[HouseRoom ${this.houseId}] Broadcast failed for session ${session.sessionId}:`,
          error
        );
      }
    }
  }

  broadcastSystemMessage(message, excludeSessionId = null) {
    this.broadcastToClients(message, excludeSessionId);
  }

  // ---------------------------------------------------------
  // WebSocket connection
  // ---------------------------------------------------------

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    if (request.method !== "GET") {
      return new Response("Expected GET", { status: 400 });
    }

    const url = new URL(request.url);

    const houseId =
      Number(url.searchParams.get("houseId")) || this.houseId;

    const sessionId = url.searchParams.get("sessionId");
    const userId = Number(url.searchParams.get("userId"));
    const clientType =
      url.searchParams.get("clientType") || "web";
    const deviceIdValue = url.searchParams.get("deviceId");
    const deviceId = deviceIdValue ? Number(deviceIdValue) : null;
    const role = url.searchParams.get("role") || "user";

    if (
      !Number.isInteger(houseId) ||
      houseId <= 0 ||
      !sessionId ||
      !Number.isInteger(userId) ||
      userId <= 0
    ) {
      return new Response("Invalid session metadata", {
        status: 401
      });
    }

    if (!["web", "device"].includes(clientType)) {
      return new Response("Invalid client type", {
        status: 400
      });
    }

    if (
      clientType === "device" &&
      (!Number.isInteger(deviceId) || deviceId <= 0)
    ) {
      return new Response("Invalid device ID", {
        status: 400
      });
    }

    // The namespace/router should send this request only to the
    // Durable Object associated with this house.
    if (this.houseId && this.houseId !== houseId) {
      return new Response("House ID mismatch", { status: 403 });
    }

    this.houseId = houseId;

    // Prevent session-ID collisions within this room.
    if (this.sessions.has(sessionId)) {
      return new Response("Session already connected", {
        status: 409
      });
    }

    const [clientWs, serverWs] = Object.values(new WebSocketPair());

    const now = new Date().toISOString();

    const session = {
      sessionId,
      userId,
      clientType,
      deviceId,
      role,
      houseId,
      connectedAt: now,
      lastMessageAt: now
    };

    // Use the Hibernation API. Do NOT call serverWs.accept()
    // or attach standard onmessage/onclose handlers.
    this.state.acceptWebSocket(serverWs);

    // Attach metadata so the connection can be restored after
    // the Durable Object is evicted and reconstructed.
    serverWs.serializeAttachment(session);
    this.sessions.set(sessionId, {
      ...session,
      ws: serverWs
    });

    try {
      if (clientType === "device") {
        await this.setDeviceStatus(deviceId, "online");
      }

      this.broadcastSystemMessage({
        type: "user_joined",
        sessionId,
        userId,
        clientType,
        deviceId,
        timestamp: new Date().toISOString()
      }, sessionId);

      this.send(serverWs, {
        type: "connected",
        sessionId,
        houseId: this.houseId,
        message: "Connected to house room",
        timestamp: new Date().toISOString()
      });

      // Existing stale-session policy: check every minute.
      await this.state.storage.setAlarm(Date.now() + 60_000);
    } catch (error) {
      console.error(
        `[HouseRoom ${this.houseId}] Connection initialization error:`,
        error
      );

      await this.handleClose(serverWs, 1011, "Initialization failed");

      try {
        serverWs.close(1011, "Initialization failed");
      } catch {
        // The socket may already be closed.
      }

      return new Response("Connection initialization failed", {
        status: 500
      });
    }

    return new Response(null, {
      status: 101,
      webSocket: clientWs
    });
  }

  // ---------------------------------------------------------
  // Cloudflare WebSocket Hibernation event handlers
  // ---------------------------------------------------------

  async webSocketMessage(ws, rawMessage) {
    const session = this.getSession(ws);
    if (!session) {
      try {
        ws.close(1008, "Missing session metadata");
      } catch {}
      return;
    }

    session.lastMessageAt = new Date().toISOString();
    this.saveSession(session);

    let message;

    try {
      const text = typeof rawMessage === "string"
        ? rawMessage
        : new TextDecoder().decode(rawMessage);

      message = JSON.parse(text);
    } catch {
      this.sendError(ws, "Invalid JSON message");
      return;
    }

    if (
      !message ||
      typeof message !== "object" ||
      typeof message.type !== "string" ||
      !message.type
    ) {
      this.sendError(ws, "Message must have a type field");
      return;
    }

    try {
      switch (message.type) {
        case "ping":
          await this.handlePing(ws, session, message);
          break;

        case "pong":
          // A pong is application-level activity.
          session.lastMessageAt = new Date().toISOString();
          this.saveSession(session);

          if (session.clientType === "device") {
            await this.setDeviceStatus(session.deviceId, "online");
          }
          break;

        case "device_command":
          if (session.clientType !== "web") {
            this.sendError(
              ws,
              "Only web clients can send device commands"
            );
            return;
          }

          await this.handleDeviceCommand(
            ws,
            session,
            message
          );
          break;

        case "device_update":
          if (session.clientType !== "device") {
            this.sendError(
              ws,
              "Only devices can send device updates"
            );
            return;
          }

          await this.handleDeviceUpdate(
            ws,
            session,
            message
          );
          break;

        case "device_response":
          if (session.clientType !== "device") {
            this.sendError(
              ws,
              "Only devices can send device responses"
            );
            return;
          }

          this.handleDeviceResponse(
            ws,
            session,
            message
          );
          break;

        case "fingerprint.event":
          if (session.clientType !== "device") {
            this.sendError(
              ws,
              "Only devices can send fingerprint events"
            );
            return;
          }

          await this.handleFingerprintEvent(
            ws,
            session,
            message
          );
          break;

        case "get_devices":
          this.handleGetDevices(ws, session);
          break;

        case "get_sessions":
          if (session.role !== "admin") {
            this.sendError(ws, "Permission denied");
            return;
          }

          this.handleGetSessions(ws);
          break;

        default:
          this.sendError(
            ws,
            `Unknown message type: ${message.type}`
          );
      }
    } catch (error) {
      console.error(
        `[HouseRoom ${this.houseId}] Message handling error:`,
        error
      );

      this.sendError(ws, "Failed to process message");
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    await this.handleClose(ws, code, reason);

    console.log(
      `[HouseRoom ${this.houseId}] WebSocket closed:`,
      { code, reason, wasClean }
    );
  }

  async webSocketError(ws, error) {
    console.error(
      `[HouseRoom ${this.houseId}] WebSocket error:`,
      error
    );

    await this.handleClose(ws, 1011, "WebSocket error");
  }

  // ---------------------------------------------------------
  // Heartbeats
  // ---------------------------------------------------------

  async handlePing(ws, session, message) {
    session.lastMessageAt = new Date().toISOString();
    this.saveSession(session);

    if (session.clientType === "device") {
      await this.setDeviceStatus(session.deviceId, "online");
    }

    this.send(ws, {
      type: "pong",
      timestamp: new Date().toISOString(),
      requestId: message.requestId
    });
  }

  // ---------------------------------------------------------
  // Device command routing and authorization
  // ---------------------------------------------------------

  async handleDeviceCommand(ws, session, message) {
    const targetDeviceId = Number(message.targetDeviceId);
    const { command, params } = message;

    if (
      !Number.isInteger(targetDeviceId) ||
      targetDeviceId <= 0 ||
      typeof command !== "string" ||
      !command.trim()
    ) {
      this.sendError(
        ws,
        "device_command requires targetDeviceId and command"
      );
      return;
    }

    let allowed;

    try {
      allowed = await this.canAccessDevice(
        session.userId,
        targetDeviceId
      );
    } catch (error) {
      console.error(
        `[HouseRoom ${this.houseId}] Device authorization query failed:`,
        error
      );

      this.sendError(ws, "Unable to verify device permissions");
      return;
    }

    if (!allowed) {
      this.sendError(
        ws,
        "You are not authorized to control this device"
      );
      return;
    }

    const deviceSessions = this.getAllSessions().filter(
      current =>
        current.clientType === "device" &&
        current.deviceId === targetDeviceId &&
        current.houseId === this.houseId
    );

    if (deviceSessions.length === 0) {
      this.sendError(
        ws,
        `Device ${targetDeviceId} not connected`
      );
      return;
    }

    const commandMessage = {
      type: "device_command",
      deviceId: targetDeviceId,
      command,
      id: message.id,
      state: message.state,
      params: params || {},
      fromUserId: session.userId,
      fromSessionId: session.sessionId,
      timestamp: new Date().toISOString()
    };

    let delivered = false;

    for (const deviceSession of deviceSessions) {
      if (this.send(deviceSession.ws, commandMessage)) {
        delivered = true;
      }
    }

    if (!delivered) {
      this.sendError(ws, "Failed to deliver command to device");
      return;
    }

    this.send(ws, {
      type: "command_routed",
      targetDeviceId,
      command,
      timestamp: new Date().toISOString()
    });
  }

  async canAccessDevice(userId, deviceId) {
    /*
     * Schema assumptions:
     * - devices(id, house_id)
     * - houses(id, owner_id)
     * - users(id, role)
     * - user_device_access(user_id, device_id)
     * - user_house_access(user_id, house_id, access_level)
     *
     * House access with a viewer-only permission is NOT sufficient
     * to control devices. Adapt the access_level list if your schema
     * uses different control permissions.
     */
    const access = await this.env.DB.prepare(`
      SELECT d.id
      FROM devices d
      JOIN houses h ON h.id = d.house_id
      JOIN users u ON u.id = ?
      WHERE d.id = ?
        AND d.house_id = ?
        AND (
          u.role = 'admin'
          OR (
            u.role = 'owner'
            AND h.owner_id = u.id
          )
          OR EXISTS (
            SELECT 1
            FROM user_device_access a
            WHERE a.user_id = u.id
              AND a.device_id = d.id
          )
          OR EXISTS (
            SELECT 1
            FROM user_house_access a
            WHERE a.user_id = u.id
              AND a.house_id = h.id
              AND LOWER(COALESCE(a.access_level, 'viewer'))
                  IN ('control', 'controller', 'editor', 'owner', 'admin')
          )
        )
    `).bind(userId, deviceId, this.houseId).first();

    return Boolean(access);
  }

  // ---------------------------------------------------------
  // Device status and telemetry
  // ---------------------------------------------------------

  async handleDeviceUpdate(ws, session, message) {
    if (Number(message.deviceId) !== session.deviceId) {
      this.sendError(
        ws,
        "Device update does not match the connected device"
      );
      return;
    }

    /*
     * A live connection/heartbeat determines connectivity.
     * A connected device cannot declare itself offline through
     * a telemetry message.
     */
    if (
      message.status !== undefined &&
      String(message.status).toLowerCase() !== "online"
    ) {
      this.sendError(
        ws,
        "Device status must be online while connected"
      );
      return;
    }

    await this.setDeviceStatus(session.deviceId, "online");

    const updateMessage = {
      type: "device_update",
      deviceId: session.deviceId,
      status: "online",
      data: message.data || {},
      fromDeviceSessionId: session.sessionId,
      timestamp: new Date().toISOString()
    };

    this.broadcastToClients(
      updateMessage,
      session.sessionId,
      "web"
    );
  }

  async setDeviceStatus(deviceId, status) {
    if (
      !Number.isInteger(deviceId) ||
      deviceId <= 0 ||
      !Number.isInteger(this.houseId) ||
      this.houseId <= 0
    ) {
      return;
    }

    status = String(status).toLowerCase();

    if (!["online", "offline"].includes(status)) {
      return;
    }

    try {
      const result = await this.env.DB.prepare(`
        UPDATE devices
        SET status = ?
        WHERE id = ?
          AND house_id = ?
          AND (
            status IS NULL
            OR LOWER(status) != ?
          )
      `).bind(
        status,
        deviceId,
        this.houseId,
        status
      ).run();

      if (result.meta?.changes > 0) {
        const update = {
          type: "device_update",
          deviceId,
          status,
          data: {},
          timestamp: new Date().toISOString()
        };

        this.broadcastToClients(update, null, "web");

        console.log(
          `[HouseRoom ${this.houseId}] Device ${deviceId} is now ${status}`
        );
      }
    } catch (error) {
      console.error(
        `[HouseRoom ${this.houseId}] Failed to persist device status:`,
        error
      );
    }
  }

  handleDeviceResponse(ws, session, message) {
    if (Number(message.deviceId) !== session.deviceId) {
      this.sendError(
        ws,
        "Device response does not match the connected device"
      );
      return;
    }

    this.broadcastToClients({
      ...message,
      type: "device_response",
      deviceId: session.deviceId,
      fromDeviceSessionId: session.sessionId,
      timestamp: new Date().toISOString()
    }, session.sessionId, "web");
  }

  // ---------------------------------------------------------
  // Fingerprint workflows
  // ---------------------------------------------------------

  async handleFingerprintEvent(ws, deviceSession, message) {
    const isScanError = message.event === "scan_error";
  const hasId =
    message.id !== undefined &&
    message.id !== null &&
    message.id !== "";

  const fingerprintId = hasId ? Number(message.id) : null;

  // A scan error does not identify a stored fingerprint.
  // Permit ID 0 or an omitted ID only for this event.
  if (isScanError) {
    if (
      hasId &&
      (!Number.isInteger(fingerprintId) || fingerprintId !== 0)
    ) {
      this.sendError(ws, "Invalid fingerprint event ID");
      return;
    }
  } else if (
    !Number.isInteger(fingerprintId) ||
    fingerprintId < 1 ||
    fingerprintId > 127
  ) {
    this.sendError(ws, "Invalid fingerprint event ID");
    return;
  }

  const forwarded = {
    ...message,
    deviceId: deviceSession.deviceId,
    fromDeviceSessionId: deviceSession.sessionId,
    timestamp: new Date().toISOString()
  };
  
    try {
      let eventUserId = null;

      if (
        message.event === "enrollment_complete" &&
        message.success === true
      ) {
        const enrollment = await this.env.DB.prepare(`
          SELECT user_id
          FROM device_fingerprint_enrollments
          WHERE device_id = ?
            AND fingerprint_id = ?
            AND enrollment_pending = 1
        `).bind(
          deviceSession.deviceId,
          fingerprintId
        ).first();

        eventUserId = enrollment?.user_id ?? null;

        await this.env.DB.prepare(`
          UPDATE device_fingerprint_enrollments
          SET status = 'active',
              enrollment_pending = 0,
              updated_at = ?
          WHERE device_id = ?
            AND fingerprint_id = ?
            AND enrollment_pending = 1
        `).bind(
          forwarded.timestamp,
          deviceSession.deviceId,
          fingerprintId
        ).run();

      } else if (message.event === "enrollment_failed") {
        const enrollment = await this.env.DB.prepare(`
          SELECT user_id
          FROM device_fingerprint_enrollments
          WHERE device_id = ?
            AND fingerprint_id = ?
            AND enrollment_pending = 1
        `).bind(
          deviceSession.deviceId,
          fingerprintId
        ).first();

        eventUserId = enrollment?.user_id ?? null;

        await this.env.DB.prepare(`
          DELETE FROM device_fingerprint_enrollments
          WHERE device_id = ?
            AND fingerprint_id = ?
            AND status = 'pending'
            AND enrollment_pending = 1
        `).bind(
          deviceSession.deviceId,
          fingerprintId
        ).run();

        await this.env.DB.prepare(`
          UPDATE device_fingerprint_enrollments
          SET enrollment_pending = 0,
              updated_at = ?
          WHERE device_id = ?
            AND fingerprint_id = ?
            AND status = 'active'
            AND enrollment_pending = 1
        `).bind(
          forwarded.timestamp,
          deviceSession.deviceId,
          fingerprintId
        ).run();

      } else if ([
        "enrollment_place_finger",
        "enrollment_remove_finger",
        "enrollment_place_same_finger"
      ].includes(message.event)) {
        const enrollment = await this.env.DB.prepare(`
          SELECT user_id
          FROM device_fingerprint_enrollments
          WHERE device_id = ?
            AND fingerprint_id = ?
            AND enrollment_pending = 1
        `).bind(
          deviceSession.deviceId,
          fingerprintId
        ).first();

        eventUserId = enrollment?.user_id ?? null;

      } else if (
        message.event === "deleted" &&
        message.success === true
      ) {
        const enrollment = await this.env.DB.prepare(`
          SELECT user_id
          FROM device_fingerprint_enrollments
          WHERE device_id = ?
            AND fingerprint_id = ?
        `).bind(
          deviceSession.deviceId,
          fingerprintId
        ).first();

        eventUserId = enrollment?.user_id ?? null;

        await this.env.DB.prepare(`
          UPDATE device_fingerprint_enrollments
          SET status = 'disabled',
              enrollment_pending = 0,
              updated_at = ?
          WHERE device_id = ?
            AND fingerprint_id = ?
        `).bind(
          forwarded.timestamp,
          deviceSession.deviceId,
          fingerprintId
        ).run();

      } else if (
        message.event === "recognized" &&
        message.success === true
      ) {
        const authorized = await this.env.DB.prepare(`
          SELECT e.user_id
          FROM device_fingerprint_enrollments e
          JOIN users u ON u.id = e.user_id
          JOIN devices d ON d.id = e.device_id
          JOIN houses h ON h.id = d.house_id
          WHERE e.device_id = ?
            AND e.fingerprint_id = ?
            AND d.house_id = ?
            AND e.status = 'active'
            AND e.enrollment_pending = 0
            AND (
              u.role = 'admin'
              OR (
                u.role = 'owner'
                AND h.owner_id = u.id
              )
              OR EXISTS (
                SELECT 1
                FROM user_device_access a
                WHERE a.user_id = e.user_id
                  AND a.device_id = e.device_id
              )
            )
        `).bind(
          deviceSession.deviceId,
          fingerprintId,
          this.houseId
        ).first();

        forwarded.accessGranted = Boolean(authorized);
        eventUserId = authorized?.user_id ?? null;

        if (authorized) {
          this.send(ws, {
            type: "device_command",
            deviceId: deviceSession.deviceId,
            command: "door.unlock",
            params: {},
            timestamp: new Date().toISOString()
          });
        }
      }

      // Preserve the original fingerprint event audience:
      // admin/owner, or the user associated with the fingerprint.
      for (const clientSession of this.getAllSessions()) {
        if (
          clientSession.sessionId === deviceSession.sessionId ||
          clientSession.clientType !== "web" ||
          clientSession.deviceId !== deviceSession.deviceId ||
          (
            clientSession.role !== "admin" &&
            clientSession.role !== "owner" &&
            clientSession.userId !== eventUserId
          )
        ) {
          continue;
        }

        this.send(clientSession.ws, forwarded);
      }

    } catch (error) {
      console.error(
        `[HouseRoom ${this.houseId}] Failed to process fingerprint event:`,
        error
      );

      // Fail closed: never unlock when authorization processing fails.
      if (message.event === "recognized") {
        return;
      }

      for (const clientSession of this.getAllSessions()) {
        if (
          clientSession.sessionId !== deviceSession.sessionId &&
          clientSession.clientType === "web" &&
          clientSession.deviceId === deviceSession.deviceId &&
          (
            clientSession.role === "admin" ||
            clientSession.role === "owner"
          )
        ) {
          this.sendError(
            clientSession.ws,
            "Fingerprint event could not be persisted"
          );
        }
      }
    }
  }

  // ---------------------------------------------------------
  // Connected device/session lists
  // ---------------------------------------------------------

  handleGetDevices(ws) {
    const devicesById = new Map();

    for (const session of this.getAllSessions()) {
      if (
        session.clientType !== "device" ||
        !Number.isInteger(session.deviceId)
      ) {
        continue;
      }

      const existing = devicesById.get(session.deviceId);

      if (!existing) {
        devicesById.set(session.deviceId, {
          deviceId: session.deviceId,
          connectedAt: session.connectedAt,
          lastMessageAt: session.lastMessageAt
        });
      }
    }

    this.send(ws, {
      type: "devices_list",
      devices: Array.from(devicesById.values()),
      timestamp: new Date().toISOString()
    });
  }

  handleGetSessions(ws) {
    const sessions = this.getAllSessions().map(session => ({
      sessionId: session.sessionId,
      userId: session.userId,
      clientType: session.clientType,
      deviceId: session.deviceId,
      role: session.role,
      connectedAt: session.connectedAt,
      lastMessageAt: session.lastMessageAt
    }));

    this.send(ws, {
      type: "sessions_list",
      sessions,
      timestamp: new Date().toISOString()
    });
  }

  // ---------------------------------------------------------
  // Disconnect and stale-session cleanup
  // ---------------------------------------------------------

  async handleClose(ws, code = 1000, reason = "Disconnected") {
    const session = this.sessions.get(
      this.getSession(ws)?.sessionId
    ) || this.getSession(ws);

    if (!session) return;

    // Delete first to prevent duplicate close/error callbacks
    // from causing duplicate cleanup.
    this.sessions.delete(session.sessionId);

    if (
      session.clientType === "device" &&
      Number.isInteger(session.deviceId)
    ) {
      const stillConnected = this.getAllSessions().some(
        current =>
          current.sessionId !== session.sessionId &&
          current.clientType === "device" &&
          current.deviceId === session.deviceId
      );

      if (!stillConnected) {
        await this.setDeviceStatus(session.deviceId, "offline");
      }
    }

    this.broadcastSystemMessage({
      type: "user_left",
      sessionId: session.sessionId,
      userId: session.userId,
      clientType: session.clientType,
      deviceId: session.deviceId,
      code,
      reason,
      timestamp: new Date().toISOString()
    });

    console.log(
      `[HouseRoom ${this.houseId}] Session ${session.sessionId} disconnected`
    );
  }

  async alarm() {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000;

    for (const session of this.getAllSessions()) {
      const lastMessageTime = Date.parse(session.lastMessageAt);
      const elapsed = now - lastMessageTime;

      if (
        !Number.isFinite(lastMessageTime) ||
        elapsed > staleThreshold
      ) {
        try {
          session.ws.close(1000, "Inactivity timeout");
        } catch {
          // The socket may already be closed.
        }

        await this.handleClose(
          session.ws,
          1000,
          "Inactivity timeout"
        );
      }
    }

    // Keep the stale-session watchdog running only while this room
    // has active connections.
    if (this.getAllSessions().length > 0) {
      await this.state.storage.setAlarm(Date.now() + 60_000);
    }
  }
}