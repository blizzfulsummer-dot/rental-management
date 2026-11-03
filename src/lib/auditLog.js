export async function writeAuditLog(env, {
  userId = null,
  deviceId = null,
  action,
  outcome,
  source,
  details = null,
  commandId = null,
  timestamp = new Date().toISOString()
}) {
  try {
    const serializedDetails = details === null
      ? null
      : JSON.stringify(details);
    const detailsJson = serializedDetails && serializedDetails.length > 2048
      ? JSON.stringify({
          truncated: true,
          preview: serializedDetails.slice(0, 1900)
        })
      : serializedDetails;
    await env.DB.prepare(`
      INSERT INTO logs (
        user_id, device_id, action, timestamp, outcome, source, details_json, command_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      userId,
      deviceId,
      action,
      timestamp,
      outcome,
      source,
      detailsJson,
      commandId
    ).run();
    return true;
  } catch (error) {
    console.error('Audit log write failed:', error);
    return false;
  }
}
