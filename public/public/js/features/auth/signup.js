export function initSignupFeature({ API_BASE, requestJson, setButtonBusy, showAlert, clearAlert, showToast }) {
  const form = document.getElementById('signupForm');
  if (!form) return;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = document.getElementById('signupSubmitBtn');
    const name = document.getElementById('signupName').value.trim();
    const email = document.getElementById('signupEmail').value.trim();
    const password = document.getElementById('signupPassword').value;
    const confirmPassword = document.getElementById('signupConfirmPassword').value;
    const alert = document.getElementById('signupAlert');
    clearAlert(alert);
    if (password !== confirmPassword) return showAlert(alert, 'Passwords do not match.', 'error');
    if (password.length < 8) return showAlert(alert, 'Use at least 8 characters for your password.', 'error');
    setButtonBusy(button, true, 'Creating account…');
    try {
      const result = await requestJson(`${API_BASE}/api/signup`, { method: 'POST', body: JSON.stringify({ name, email, password, role: 'user' }) });
      showAlert(alert, result.message || 'Account created. You can now sign in.', 'success');
      form.reset(); showToast(result.message || 'Account created successfully.');
    } catch (error) { showAlert(alert, error.message || 'Could not create account.', 'error'); }
    finally { setButtonBusy(button, false); }
  });
}
