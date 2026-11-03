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
import { writeAuditLog } from './lib/auditLog.js';
import { getAllowedFingerprintIds } from './lib/fingerprintAuthorization.js';

export class HouseRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.houseId =
      Number(String(state.id).match(/house-(\d+)/)?.[1]) || null;

    this.userColumns = new Set();

    // Rebuild the in-memory index after a hibernation wake-up.
    // The WebSockets and their serialized attachments are authoritative.
    this.sessions = new Map();

    const availableSockets = typeof this.state?.getWebSockets === 'function'
      ? this.state.getWebSockets()
      : [];

    for (const ws of availableSockets) {
      try {
        const attachment = ws.deserializeAttachment();

        if (attachment &&typeof attachment.sessionId === "string"){
            // Restore houseId after Durable Object reconstruction.
          const attachmentHouseId = Number(attachment.houseId);

          if (Number.isInteger(attachmentHouseId) && attachmentHouseId > 0) {
              this.houseId = attachmentHouseId;
            }

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

    if (session.sessionId) {
      if (ws && typeof ws.serializeAttachment === 'function') {
        ws.serializeAttachment(attachment);
      }
      this.sessions.set(session.sessionId, session);
    }
  }

  async ensureUserColumns() {
    if (this.userColumns.size) return this.userColumns;

    try {
      const result = await this.env.DB.prepare('PRAGMA table_info(users)').all();
      this.userColumns = new Set((result.results || []).map(column => column.name));
    } catch (error) {
      // Permission checks must fail closed if account status cannot be read.
      throw error;
    }

    return this.userColumns;
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

  resolveSocket(sessionKeyOrWs, fallbackSession = null) {
    if (typeof sessionKeyOrWs === 'string') {
      const resolvedSession = this.sessions.get(sessionKeyOrWs) || fallbackSession;
      return resolvedSession?.ws || fallbackSession?.ws || null;
    }

    return sessionKeyOrWs || fallbackSession?.ws || null;
  }

  getAllSessions() {
    // Cloudflare's accepted WebSockets are the source of truth after hibernation.
    // Rebuild the index from them and deduplicate by sessionId so one connection
    // can never be broadcast to or processed more than once.
    const sockets = typeof this.state?.getWebSockets === 'function'
      ? this.state.getWebSockets()
      : null;

    const sessionsById = new Map();

    if (Array.isArray(sockets)) {
      for (const ws of sockets) {
        try {
          const attachment = ws.deserializeAttachment();
          if (!attachment || typeof attachment.sessionId !== 'string') continue;
          const session = {
            ...attachment,
            houseId: attachment.houseId ?? this.houseId,
            deviceId: attachment.deviceId ?? null,
            ws
          };
          sessionsById.set(session.sessionId, session);
        } catch (error) {
          console.error(
            `[HouseRoom ${this.houseId}] Failed to read session attachment:`,
            error
          );
        }
      }

      // Discard stale in-memory entries no longer represented by an accepted socket.
      this.sessions = sessionsById;
    } else {
      // Lightweight fallback used by unit tests and non-hibernating adapters.
      for (const [sessionId, session] of this.sessions.entries()) {
        if (!session?.ws) continue;
        sessionsById.set(session.sessionId || sessionId, {
          ...session,
          sessionId: session.sessionId || sessionId,
          houseId: session.houseId ?? this.houseId,
          deviceId: session.deviceId ?? null
        });
      }
      this.sessions = sessionsById;
    }

    const browserSessions = [];
    const latestDeviceSessions = new Map();
    for (const session of sessionsById.values()) {
      if (session.clientType !== 'device') {
        browserSessions.push(session);
        continue;
      }
      const deviceKey = Number(session.deviceId);
      const previous = latestDeviceSessions.get(deviceKey);
      const currentTime = Date.parse(session.connectedAt || '') || 0;
      const previousTime = Date.parse(previous?.connectedAt || '') || 0;
      if (!previous || currentTime >= previousTime) {
        latestDeviceSessions.set(deviceKey, session);
      }
    }

    // A device has one authoritative live socket. During a reconnect, an old
    // closing socket can briefly remain in getWebSockets(); prefer the newest
    // connection so commands are never delivered to both sockets.
    return [...browserSessions, ...latestDeviceSessions.values()];
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

  broadcastToDeviceClients(message, deviceId, excludeSessionId = null) {
    for (const session of this.getAllSessions()) {
      if (session.sessionId === excludeSessionId) continue;
      if (session.clientType !== 'web' || Number(session.deviceId) !== Number(deviceId)) continue;
      this.send(session.ws, message);
    }
  }

  // ---------------------------------------------------------
  // WebSocket connection
  // ---------------------------------------------------------

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/authorization-sync') {
      try {
        const payload = await request.json();
        const deviceId = Number(payload.deviceId);
        if (!Number.isSafeInteger(deviceId) || deviceId <= 0) {
          return new Response('Invalid device ID', { status: 400 });
        }
        const delivered = await this.syncDeviceFingerprintAuthorization(deviceId);
        return Response.json({ success: true, delivered });
      } catch (error) {
        console.error(`[HouseRoom ${this.houseId}] Authorization sync failed:`, error);
        return new Response('Authorization sync failed', { status: 500 });
      }
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    if (request.method !== "GET") {
      return new Response("Expected GET", { status: 400 });
    }

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

    // A physical device should have one authoritative socket. Replacing an old
    // connection prevents duplicate command delivery after Wi-Fi reconnects.
    if (clientType === 'device') {
      for (const existing of this.getAllSessions()) {
        if (existing.clientType !== 'device' || Number(existing.deviceId) !== deviceId) continue;
        try { existing.ws.close(4001, 'Replaced by a newer device connection'); } catch {}
        await this.handleClose(existing.ws, 4001, 'Replaced by a newer device connection');
      }
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

      if (clientType === 'device') {
        session.authorizationSyncPending =
          !(await this.syncDeviceFingerprintAuthorization(deviceId));
        this.saveSession({ ...session, ws: serverWs });
      }

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
            if (session.authorizationSyncPending) {
              session.authorizationSyncPending =
                !(await this.syncDeviceFingerprintAuthorization(session.deviceId));
              this.saveSession(session);
            }
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

         await this.handleDeviceResponse(
            ws,
            session,
            message
          );
          break;

        case "device.event":
          if (session.clientType !== "device") {
            this.sendError(ws, "Only devices can send device events");
            return;
          }
          await this.handleDeviceEvent(session, message);
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
    const socket = this.resolveSocket(ws, session);
    if (!socket || !session) {
      return;
    }

    session.lastMessageAt = new Date().toISOString();
    this.saveSession(session);

    if (session.clientType === "device") {
      await this.setDeviceStatus(session.deviceId, "online");
    }

    this.send(socket, {
      type: "pong",
      timestamp: new Date().toISOString(),
      requestId: message.requestId
    });
  }

  // ---------------------------------------------------------
  // Device command routing and authorization
  // ---------------------------------------------------------

  async handleDeviceCommand(ws, session, message) {
    const resolvedSession = typeof ws === 'string'
      ? (this.sessions.get(ws) || session)
      : session;
    const socket = this.resolveSocket(ws, resolvedSession || session);

    if (!resolvedSession || !socket) {
      return;
    }

    const targetDeviceId = Number(message.targetDeviceId);
    const { command, params } = message;

    if (
      !Number.isInteger(targetDeviceId) ||
      targetDeviceId <= 0 ||
      typeof command !== "string" ||
      !command.trim()
    ) {
      this.sendError(
        socket,
        "device_command requires targetDeviceId and command"
      );
      return;
    }

    if (
      message.commandId !== undefined &&
      (typeof message.commandId !== "string" ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(message.commandId))
    ) {
      this.sendError(socket, "device_command requires a valid commandId");
      return;
    }
    const commandId = message.commandId || crypto.randomUUID();

    if (
      Number.isInteger(resolvedSession.deviceId) &&
      Number(resolvedSession.deviceId) !== targetDeviceId
    ) {
      this.sendError(
        socket,
        "You are not authorized to control this device"
      );
      return;
    }

    let allowed = true;

    if (this.env?.DB && typeof this.env.DB.prepare === 'function') {
      try {
        allowed = await this.canAccessDevice(
          resolvedSession.userId,
          targetDeviceId
        );
      } catch (error) {
        console.error(
          `[HouseRoom ${this.houseId}] Device authorization query failed:`,
          error
        );

        this.sendError(socket, "Unable to verify device permissions");
        return;
      }
    }

    if (!allowed) {
      await writeAuditLog(this.env, {
        userId: resolvedSession.userId,
        deviceId: targetDeviceId,
        action: 'device.command',
        outcome: 'denied',
        source: 'web',
        commandId,
        details: { command, reason: 'not_authorized' }
      });
      this.sendError(
        socket,
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
      await writeAuditLog(this.env, {
        userId: resolvedSession.userId,
        deviceId: targetDeviceId,
        action: 'device.command',
        outcome: 'failed',
        source: 'web',
        commandId,
        details: { command, reason: 'device_offline' }
      });
      this.sendError(
        socket,
        `Device ${targetDeviceId} not connected`
      );
      return;
    }

    const commandMessage = {
      type: "device_command",
      commandId,
      deviceId: targetDeviceId,
      command,
      id: message.id,
      state: message.state,
      params: params || {},
      fromUserId: resolvedSession.userId,
      fromSessionId: resolvedSession.sessionId,
      timestamp: new Date().toISOString()
    };

    const pendingKey = `pending-command:${commandId}`;
    if (this.state?.storage?.put) {
      try {
        const timeoutMs = 10_000;
        await this.state.storage.put(pendingKey, {
          commandId,
          targetDeviceId,
          command,
          fromSessionId: resolvedSession.sessionId,
          userId: resolvedSession.userId,
          source: 'web',
          deadline: Date.now() + timeoutMs,
          timeoutMs
        });
      } catch (error) {
        console.error(`[HouseRoom ${this.houseId}] Could not track command:`, error);
        this.sendError(socket, "Unable to track device command");
        return;
      }
    }

    let delivered = false;

    for (const deviceSession of deviceSessions) {
      if (this.send(deviceSession.ws, commandMessage)) {
        delivered = true;
      }
    }

    if (!delivered) {
      if (this.state?.storage?.delete) {
        await this.state.storage.delete(pendingKey);
      }
      await writeAuditLog(this.env, {
        userId: resolvedSession.userId,
        deviceId: targetDeviceId,
        action: 'device.command',
        outcome: 'failed',
        source: 'web',
        commandId,
        details: { command, reason: 'delivery_failed' }
      });
      this.sendError(socket, "Failed to deliver command to device");
      return;
    }

    if (this.state?.storage?.put) {
      await this.scheduleNextAlarm();
    }

    this.send(socket, {
      type: "command_routed",
      commandId,
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
    const userColumns = await this.ensureUserColumns();
    const activeClause = userColumns.has('is_active')
      ? "AND COALESCE(u.is_active, 1) = 1"
      : "";
    const statusClause = userColumns.has('status')
      ? "AND LOWER(COALESCE(u.status, 'active')) != 'suspended'"
      : "";
    const access = await this.env.DB.prepare(`
      SELECT d.id
      FROM devices d
      JOIN houses h ON h.id = d.house_id
      JOIN users u ON u.id = ?
      WHERE d.id = ?
        AND d.house_id = ?
        ${activeClause}
        ${statusClause}
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

    this.broadcastToDeviceClients(
      updateMessage,
      session.deviceId,
      session.sessionId
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

        this.broadcastToDeviceClients(update, deviceId);

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

  
  async handleDeviceResponse(ws, session, message) {
    const socket = this.resolveSocket(ws, session);
    if (!socket || !session) {
      return;
    }

    if (Number(message.deviceId) !== session.deviceId) {
      this.sendError(
        socket,
        "Device response does not match the connected device"
      );
      return;
    }

    const commandId = message.commandId
      ? String(message.commandId)
      : null;

    if (commandId) {
      const storageKey = `pending-command:${commandId}`;
      const pending = await this.state.storage.get(storageKey);

      // Ignore a response that doesn't match this device.
      if (
        pending &&
        pending.targetDeviceId === session.deviceId &&
        pending.command === message.command
      ) {
        if (Date.now() >= pending.deadline) {
          await this.state.storage.delete(storageKey);
          await writeAuditLog(this.env, {
            userId: pending.userId ?? null,
            deviceId: session.deviceId,
            action: 'device.command',
            outcome: 'timeout',
            source: pending.source || 'web',
            commandId,
            details: { command: pending.command, reason: 'late_response' }
          });

          this.broadcastToDeviceClients({
            type: "command_timeout",
            commandId,
            targetDeviceId: session.deviceId,
            command: pending.command,
            status: "unresponsive",
            error: "Device response arrived after the timeout",
            timestamp: new Date().toISOString()
          }, session.deviceId);
        } else {
          await this.state.storage.delete(storageKey);

          await writeAuditLog(this.env, {
            userId: pending.userId ?? null,
            deviceId: session.deviceId,
            action: 'device.command',
            outcome: message.success === false ? 'failed' : 'success',
            source: pending.source || 'web',
            commandId,
            details: {
              command: pending.command,
              message: typeof message.message === 'string'
                ? message.message.slice(0, 500)
                : null,
              eventId: typeof message.eventId === 'string'
                ? message.eventId.slice(0, 128)
                : null
            }
          });

          this.broadcastToDeviceClients({
            type: "command_result",
            commandId,
            targetDeviceId: session.deviceId,
            command: pending.command,
            success: message.success !== false,
            response: message,
            status: message.success === false
              ? "failed"
              : "acknowledged",
            timestamp: new Date().toISOString()
          }, session.deviceId);
        }

        await this.scheduleNextAlarm();
      }

    }

    // Preserve delivery of the original device response.
    this.broadcastToDeviceClients({
      ...message,
      type: "device_response",
      deviceId: session.deviceId,
      fromDeviceSessionId: session.sessionId,
      timestamp: new Date().toISOString()
    }, session.deviceId, session.sessionId);
  }

  async syncDeviceFingerprintAuthorization(deviceId) {
    if (!this.houseId) {
      console.error(`[HouseRoom] Cannot sync fingerprint authorization without a house ID`);
      return false;
    }
    try {
      const allowedFingerprintIds = await getAllowedFingerprintIds(
        this.env,
        deviceId,
        this.houseId
      );
      const message = {
        type: 'fingerprint.authorization.sync',
        deviceId,
        allowedFingerprintIds,
        updatedAt: new Date().toISOString()
      };
      let delivered = false;
      for (const session of this.getAllSessions()) {
        if (session.clientType === 'device' && session.deviceId === deviceId) {
          delivered = this.send(session.ws, message) || delivered;
        }
      }
      return delivered;
    } catch (error) {
      console.error(
        `[HouseRoom ${this.houseId}] Fingerprint authorization sync failed for device ${deviceId}:`,
        error
      );
      return false;
    }
  }

  async handleDeviceEvent(session, message) {
    if (
      Number(message.deviceId) !== session.deviceId ||
      typeof message.event !== 'string' ||
      !/^[a-z0-9._-]{1,80}$/i.test(message.event) ||
      typeof message.success !== 'boolean'
    ) {
      this.sendError(session.ws, 'Invalid device event');
      return;
    }

    await writeAuditLog(this.env, {
      deviceId: session.deviceId,
      action: `device.${message.event}`,
      outcome: message.success ? 'success' : 'failed',
      source: typeof message.source === 'string'
        ? message.source.slice(0, 40)
        : 'device',
      details: {
        message: typeof message.message === 'string'
          ? message.message.slice(0, 500)
          : null
      }
    });
  }

  // ---------------------------------------------------------
  // Fingerprint workflows
  // ---------------------------------------------------------

  async handleFingerprintEvent(ws, deviceSession, message) {
    const resolvedDeviceSession = typeof ws === 'string'
      ? (this.sessions.get(ws) || deviceSession)
      : deviceSession;
    const socket = this.resolveSocket(ws, resolvedDeviceSession || deviceSession);
    if (!resolvedDeviceSession || !socket) {
      return;
    }

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
              pending_expires_at = NULL,
              updated_at = ?
          WHERE device_id = ?
            AND fingerprint_id = ?
            AND enrollment_pending = 1
        `).bind(
          forwarded.timestamp,
          deviceSession.deviceId,
          fingerprintId
        ).run();
        await this.syncDeviceFingerprintAuthorization(deviceSession.deviceId);

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
              pending_expires_at = NULL,
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
        await this.syncDeviceFingerprintAuthorization(deviceSession.deviceId);

      } else if (
        message.event === "recognized" &&
        message.success === true
      ) {
        const enrollment = await this.env.DB.prepare(`
          SELECT user_id
          FROM device_fingerprint_enrollments
          WHERE device_id = ? AND fingerprint_id = ?
        `).bind(deviceSession.deviceId, fingerprintId).first();
        const userColumns = await this.ensureUserColumns();
        const activeClause = userColumns.has('is_active')
          ? "AND COALESCE(u.is_active, 1) = 1"
          : "";
        const statusClause = userColumns.has('status')
          ? "AND LOWER(COALESCE(u.status, 'active')) != 'suspended'"
          : "";

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
            ${activeClause}
            ${statusClause}
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
        eventUserId = enrollment?.user_id ?? null;
        await writeAuditLog(this.env, {
          userId: eventUserId,
          deviceId: deviceSession.deviceId,
          action: 'fingerprint.recognition',
          outcome: authorized ? 'success' : 'denied',
          source: 'fingerprint',
          details: {
            fingerprintId,
            confidence: Number.isFinite(Number(message.confidence))
              ? Number(message.confidence)
              : null
          }
        });

        if (authorized) {
          const commandId = crypto.randomUUID();
          const command = {
            type: "device_command",
            deviceId: resolvedDeviceSession.deviceId,
            commandId,
            command: "door.unlock",
            params: {},
            timestamp: new Date().toISOString()
          };
          if (this.state?.storage?.put) {
            const timeoutMs = 10_000;
            await this.state.storage.put(`pending-command:${commandId}`, {
              commandId,
              targetDeviceId: resolvedDeviceSession.deviceId,
              command: command.command,
              fromSessionId: null,
              userId: authorized.user_id,
              source: 'fingerprint',
              deadline: Date.now() + timeoutMs,
              timeoutMs
            });
            await this.scheduleNextAlarm();
          }
          this.send(socket, {
            ...command
          });
        }
      } else if (message.event === 'unrecognized' || message.event === 'scan_error') {
        await writeAuditLog(this.env, {
          deviceId: deviceSession.deviceId,
          action: `fingerprint.${message.event}`,
          outcome: 'denied',
          source: 'fingerprint',
          details: {
            message: typeof message.message === 'string'
              ? message.message.slice(0, 500)
              : null
          }
        });
      }

      if (!['recognized', 'unrecognized', 'scan_error'].includes(message.event)) {
        await writeAuditLog(this.env, {
          userId: eventUserId,
          deviceId: deviceSession.deviceId,
          action: `fingerprint.${message.event}`,
          outcome: message.success === false ? 'failed' : 'success',
          source: 'fingerprint',
          details: {
            fingerprintId,
            message: typeof message.message === 'string'
              ? message.message.slice(0, 500)
              : null
          }
        });
      }

      // Preserve the original fingerprint event audience:
      // admin/owner, or the user associated with the fingerprint.
      for (const clientSession of this.getAllSessions()) {
        if (
          clientSession.sessionId === resolvedDeviceSession.sessionId ||
          clientSession.clientType !== "web" ||
          clientSession.deviceId !== resolvedDeviceSession.deviceId ||
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
          clientSession.sessionId !== resolvedDeviceSession.sessionId &&
          clientSession.clientType === "web" &&
          clientSession.deviceId === resolvedDeviceSession.deviceId &&
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

  handleGetDevices(ws, requestingSession) {
    const devicesById = new Map();
    const canListAllDevices = requestingSession?.role === 'admin';

    for (const session of this.getAllSessions()) {
      if (
        session.clientType !== "device" ||
        !Number.isInteger(session.deviceId) ||
        (!canListAllDevices && Number(session.deviceId) !== Number(requestingSession?.deviceId))
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

    // First expire commands whose acknowledgement deadline passed.
    await this.expirePendingCommands();

    // Keep your existing stale-session watchdog.
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

    // Schedule the next command deadline or watchdog check.
    await this.scheduleNextAlarm();
  }
  
  // ---------------------------------------------------------
  // Command acknowledgement and timeout tracking
  // ---------------------------------------------------------

  async scheduleNextAlarm() {
    const pending = await this.state.storage.list({
      prefix: "pending-command:"
    });

    let nextDeadline = Date.now() + 60_000;

    for (const command of pending.values()) {
      if (Number.isFinite(command.deadline)) {
        nextDeadline = Math.min(
          nextDeadline,
          command.deadline
        );
      }
    }

    if (this.getAllSessions().length === 0 && pending.size === 0) {
      return;
    }

    await this.state.storage.setAlarm(nextDeadline);
  }

  async expirePendingCommands() {
    const now = Date.now();
    const pending = await this.state.storage.list({
      prefix: "pending-command:"
    });

    for (const [key, command] of pending) {
      if (command.deadline > now) continue;

      // Delete before notifying, so duplicate alarm execution
      // cannot report the same timeout more than once.
      await this.state.storage.delete(key);
      await writeAuditLog(this.env, {
        userId: command.userId ?? null,
        deviceId: command.targetDeviceId,
        action: 'device.command',
        outcome: 'timeout',
        source: command.source || 'web',
        commandId: command.commandId,
        details: {
          command: command.command,
          reason: 'no_acknowledgement',
          timeoutMs: command.timeoutMs
        }
      });

      const timeoutMessage = {
        type: "command_timeout",
        commandId: command.commandId,
        targetDeviceId: command.targetDeviceId,
        command: command.command,
        status: "unresponsive",
        error: "Device did not acknowledge the command in time",
        timeoutMs: command.timeoutMs,
        timestamp: new Date().toISOString()
      };

      // Notify the original requester if still connected.
      const requester = this.getAllSessions().find(
        session =>
          session.sessionId === command.fromSessionId &&
          session.clientType === "web"
      );

      if (requester) {
        this.send(requester.ws, timeoutMessage);
      }

      // Also notify other web sessions viewing this device.
      for (const session of this.getAllSessions()) {
        if (
          session.clientType === "web" &&
          session.deviceId === command.targetDeviceId &&
          session.sessionId !== command.fromSessionId
        ) {
          this.send(session.ws, timeoutMessage);
        }
      }

      console.warn(
        `[HouseRoom ${this.houseId}] Command ${command.commandId} timed out for device ${command.targetDeviceId}`
      );
    }
  }

}