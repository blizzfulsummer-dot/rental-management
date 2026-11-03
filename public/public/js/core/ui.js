/**
 * @file ui.js
 * @description UI utility functions for alerts, loaders, and button states.
 */
export function setButtonBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    if (!button.dataset.idleHtml) {
      button.dataset.idleHtml = button.innerHTML;
    }
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span><span>${label || 'Working…'}</span>`;
  } else {
    if (button.dataset.idleHtml) {
      button.innerHTML = button.dataset.idleHtml;
      delete button.dataset.idleHtml;
    }
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

export async function withButtonLoading(
  button,
  action,
  label = 'Processing...'
) {
  if (!button || button.disabled || typeof action !== 'function') return;

  

  setButtonBusy(button, true, label);

  try {
    const result = await action();
    
    return result;
  } finally {
    
    setButtonBusy(button, false);

  }
}