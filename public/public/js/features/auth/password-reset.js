/** Email OTP password-reset flow, isolated from application bootstrap. */
export function initPasswordResetFeature({ API_BASE, requestJson, setButtonBusy, showAlert, clearAlert, loginAlert, openAuthDialog }) {
  let passwordResetEmail = '';
  const byId = id => document.getElementById(id);

  byId('forgotPasswordLink').addEventListener('click', () => {
    clearAlert(byId('forgotPasswordAlert'));
    clearAlert(byId('completeResetAlert'));
    byId('completeResetForm').hidden = true;
    byId('resetEmail').value = byId('email').value.trim();
    openAuthDialog('forgotPasswordDialog');
  });

  byId('forgotPasswordForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = byId('requestResetBtn');
    const email = byId('resetEmail').value.trim();
    const alert = byId('forgotPasswordAlert');
    clearAlert(alert);
    setButtonBusy(button, true, 'Sending code…');
    try {
      const result = await requestJson(`${API_BASE}/api/password-reset/request`, {
        method: 'POST', body: JSON.stringify({ email })
      });
      passwordResetEmail = email;
      byId('completeResetForm').hidden = false;
      showAlert(alert, result.message || 'If the account is eligible, a verification code has been sent.', 'success');
    } catch (error) {
      showAlert(alert, error.message || 'Unable to request password reset. Please try again later.', 'error');
    } finally {
      setButtonBusy(button, false);
    }
  });

  byId('completeResetForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = byId('completeResetBtn');
    const code = byId('resetCode').value.trim();
    const password = byId('resetNewPassword').value;
    const confirmPassword = byId('resetConfirmPassword').value;
    const alert = byId('completeResetAlert');
    clearAlert(alert);
    if (password !== confirmPassword) return showAlert(alert, 'Passwords do not match.', 'error');
    if (password.length < 8) return showAlert(alert, 'Use at least 8 characters for your password.', 'error');
    setButtonBusy(button, true, 'Updating password…');
    try {
      const email = passwordResetEmail || byId('resetEmail').value.trim();
      const result = await requestJson(`${API_BASE}/api/password-reset/confirm`, {
        method: 'POST', body: JSON.stringify({ email, code, newPassword: password })
      });
      byId('password').value = '';
      byId('email').value = email;
      byId('forgotPasswordDialog').close();
      byId('forgotPasswordForm').reset();
      byId('completeResetForm').reset();
      byId('completeResetForm').hidden = true;
      byId('forgotPasswordLink').hidden = true;
      showAlert(loginAlert, result.message || 'Password reset successfully. Please sign in.', 'success');
      passwordResetEmail = '';
    } catch (error) {
      showAlert(alert, error.message || 'Password reset failed. Check the code and try again.', 'error');
    } finally {
      setButtonBusy(button, false);
    }
  });
}
