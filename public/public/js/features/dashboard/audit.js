export function createAuditLogFeature({
  API_BASE,
  requestJson,
  getAuthHeaders,
  mainPanelContent,
  escapeHtml,
  isActiveView,
}) {
  async function renderAuditLogs() {
    mainPanelContent.innerHTML = `
      <div class="audit-log-toolbar">
        <p>Recent account and device activity</p>
        <button class="mini-btn" type="button" data-refresh-audit>Refresh</button>
      </div>
      <div class="empty">Loading activity...</div>
    `;

    mainPanelContent.querySelector('[data-refresh-audit]')
      ?.addEventListener('click', () => void renderAuditLogs());

    try {
      const { logs = [] } = await requestJson(`${API_BASE}/api/logs?limit=200`, {
        headers: getAuthHeaders(),
      });
      if (!isActiveView()) return;

      const entries = logs.map((log) => {
        let details = '';
        if (typeof log.details_json === 'string') {
          try {
            details = JSON.stringify(JSON.parse(log.details_json));
          } catch {
            details = log.details_json;
          }
        }

        const outcome = String(log.outcome || 'recorded').toLowerCase();
        const outcomeClass = ['success', 'failed', 'denied', 'timeout'].includes(outcome)
          ? outcome
          : 'recorded';
        const identity = log.user_name || log.user_email || (
          log.user_id ? `Account ${log.user_id}` : 'System'
        );

        return `
          <article class="audit-log-entry">
            <div class="audit-log-heading">
              <strong>${escapeHtml(String(log.action || 'Activity').replace(/[._]/g, ' '))}</strong>
              <span class="audit-outcome ${outcomeClass}">${escapeHtml(outcome)}</span>
            </div>
            <div class="audit-log-meta">
              <span>${escapeHtml(identity)}</span>
              <span>${escapeHtml(log.device_id ? `Device ${log.device_id}` : 'No device')}</span>
              <span>${escapeHtml(log.source || 'unknown source')}</span>
              <time datetime="${escapeHtml(log.timestamp || '')}">${escapeHtml(
                log.timestamp ? new Date(log.timestamp).toLocaleString() : 'Unknown time',
              )}</time>
            </div>
            ${log.command_id ? `<code class="audit-command-id">${escapeHtml(log.command_id)}</code>` : ''}
            ${details ? `<p class="audit-log-details">${escapeHtml(details)}</p>` : ''}
          </article>
        `;
      });

      mainPanelContent.innerHTML = `
        <div class="audit-log-toolbar">
          <p>Recent account and device activity</p>
          <button class="mini-btn" type="button" data-refresh-audit>Refresh</button>
        </div>
        ${entries.length
          ? `<div class="audit-log-list">${entries.join('')}</div>`
          : '<div class="empty">No activity has been recorded yet.</div>'}
      `;
      mainPanelContent.querySelector('[data-refresh-audit]')
        ?.addEventListener('click', () => void renderAuditLogs());
    } catch (error) {
      if (!isActiveView()) return;
      mainPanelContent.innerHTML = `
        <div class="audit-log-toolbar">
          <p>Recent account and device activity</p>
          <button class="mini-btn" type="button" data-refresh-audit>Retry</button>
        </div>
        <div class="empty">${escapeHtml(error.message || 'Could not load activity.')}</div>
      `;
      mainPanelContent.querySelector('[data-refresh-audit]')
        ?.addEventListener('click', () => void renderAuditLogs());
    }
  }

  return { renderAuditLogs };
}
