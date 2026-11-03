async function resolveBindingValue(binding) {
  if (binding && typeof binding.get === 'function') return await binding.get();
  return binding;
}


export async function sendTemporaryPasswordEmail({
  env,
  name,
  email,
  role,
  tempPassword
}) {
  const emailServiceKey = env?.EMAIL_SERVICE_KEY;
  const fromEmailBinding = env?.RESEND_FROM_EMAIL;

  if (!emailServiceKey || !fromEmailBinding) {
    console.warn('[ReMan Email] Email delivery is not configured; skipping temp-password email.');
    return null;
  }

  const rawApiKey = await resolveBindingValue(emailServiceKey);
  const apiKey = rawApiKey?.trim();

  const fromEmail = await resolveBindingValue(fromEmailBinding);

  if (!apiKey) {
    console.warn('[ReMan Email] EMAIL_SERVICE_KEY is missing or empty; skipping temp-password email.');
    return null;
  }

  if (!fromEmail) {
    console.warn('[ReMan Email] RESEND_FROM_EMAIL is missing or empty; skipping temp-password email.');
    return null;
  }

  if (/\s/.test(apiKey)) {
    throw new Error('EMAIL_SERVICE_KEY contains internal whitespace');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}` ,
      'Content-Type': 'application/json'
    },
    signal: AbortSignal.timeout(8_000),
    body: JSON.stringify({
      from: fromEmail,
      to: [email],
      subject: 'Your ReMan account is ready',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#333">
          <h2>Welcome to ReMan, ${escapeHtml(name)}!</h2>
          <p>Your ${escapeHtml(role)} account has been created.</p>
          <p>Use the following temporary password to sign in:</p>
          <div style="padding:16px;background:#f3f4f6;border-radius:8px;font-size:20px;font-weight:bold;letter-spacing:2px">
            ${escapeHtml(tempPassword)}
          </div>
          <p><strong>Important:</strong> You must change your password after your first login.</p>
          <p>This temporary password expires in 24 hours.</p>
          <p>If you did not expect this account, please contact your property administrator.</p>
          <p>Regards,<br>ReMan Team</p>
        </div>
      `
    })
  });

  const responseText = await response.text();

  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    result = { message: responseText };
  }

  if (!response.ok) {
    console.error('[Resend Error]', {
      status: response.status,
      response: result
    });

    throw new Error(
      `Resend API error (${response.status}): ${
        result.message || JSON.stringify(result)
      }`
    );
  }

  console.log('[ReMan Email] Accepted by Resend:', result.id);

  return result;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}


export async function sendPasswordResetCodeEmail({ env, name, email, code }) {
  const emailServiceKey = env?.EMAIL_SERVICE_KEY;
  const fromEmailBinding = env?.RESEND_FROM_EMAIL;
  if (!emailServiceKey || !fromEmailBinding) {
    console.warn('[ReMan Email] Password reset email is not configured.');
    return null;
  }

  const apiKey = (await resolveBindingValue(emailServiceKey))?.trim();
  const fromEmail = await resolveBindingValue(fromEmailBinding);
  if (!apiKey || !fromEmail || /\s/.test(apiKey)) {
    console.warn('[ReMan Email] Password reset email configuration is incomplete.');
    return null;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8_000),
    body: JSON.stringify({
      from: fromEmail,
      to: [email],
      subject: 'Your ReMan password reset code',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#333">
          <h2>Password reset</h2>
          <p>Hello ${escapeHtml(name || email)},</p>
          <p>Use this verification code to reset your ReMan password:</p>
          <div style="padding:16px;background:#f3f4f6;border-radius:8px;font-size:28px;font-weight:bold;letter-spacing:6px;text-align:center">${escapeHtml(code)}</div>
          <p>This code expires in 10 minutes and can only be used once.</p>
          <p>If you did not request this, you can safely ignore this email.</p>
        </div>
      `
    })
  });

  const responseText = await response.text();
  let result;
  try { result = JSON.parse(responseText); } catch { result = { message: responseText }; }
  if (!response.ok) {
    console.error('[Resend Password Reset Error]', { status: response.status, response: result });
    throw new Error(`Password reset email delivery failed (${response.status})`);
  }
  return result;
}
