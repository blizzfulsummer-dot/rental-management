
export async function sendTemporaryPasswordEmail({
  env,
  name,
  email,
  role,
  tempPassword
}) {

  const fromEmail = env.RESEND_FROM_EMAIL;

  if (!fromEmail) {
    throw new Error('RESEND_FROM_EMAIL is missing');
  }

  const rawApiKey = env.EMAIL_SERVICE_KEY;
const apiKey = rawApiKey?.trim();

console.log('[ReMan Email Diagnostic]', {
  apiKeyConfigured: Boolean(apiKey),
  rawLength: rawApiKey?.length,
  trimmedLength: apiKey?.length,
  rawHasWhitespace: rawApiKey ? /\s/.test(rawApiKey) : null,
  trimmedHasWhitespace: apiKey ? /\s/.test(apiKey) : null,
  startsWithRe: apiKey?.startsWith('re_'),
  senderConfigured: Boolean(env.RESEND_FROM_EMAIL)
});

const whitespacePositions = [];
for (let i = 0; i < apiKey.length; i++) {
  if (/\s/.test(apiKey[i])) {
    whitespacePositions.push({
      position: i,
      characterCode: apiKey.charCodeAt(i)
    });
  }
}

console.log(JSON.stringify({
  diagnostic: 'REMAN_SECRET_TEST_V2',
  configured: Boolean(rawApiKey),
  rawLength: rawApiKey?.length ?? 0,
  trimmedLength: apiKey.length,
  whitespaceCount: whitespacePositions.length,
  whitespacePositions,
  startsWithRe: apiKey.startsWith('re_')
}));

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
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
