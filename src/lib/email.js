
export async function sendTemporaryPasswordEmail({
  env,
  name,
  email,
  role,
  tempPassword
}) {
  if (!env.EMAIL_SERVICE_KEY) {
    throw new Error('OTP_EMAIL_SERVICE_API_KEY is not configured');
  }

  if (!env.RESEND_FROM_EMAIL) {
    throw new Error('RESEND_FROM_EMAIL is not configured');
  }

  console.log('ReMan email configuration:', {
  apiKeyConfigured: Boolean(env.EMAIL_SERVICE_KEY),
  sender: env.RESEND_FROM_EMAIL,
  recipientConfigured: Boolean(email),
  recipientValid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
});

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.EMAIL_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
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

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
  console.error('Resend delivery failed:', {
    status: response.status,
    response: result
  });

  throw new Error(
    `Resend API error (${response.status}): ${result.message || JSON.stringify(result)}`
  );
}

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
