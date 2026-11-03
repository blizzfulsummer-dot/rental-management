export function showToast(message, type = 'success') {
  const region = document.getElementById('toastRegion');
  if (!region || !message) return;
  const toast = document.createElement('div');
  toast.className = `reman-toast${type === 'error' ? ' error' : ''}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.textContent = String(message);
  region.appendChild(toast);
  window.setTimeout(() => toast.remove(), 4200);
}
