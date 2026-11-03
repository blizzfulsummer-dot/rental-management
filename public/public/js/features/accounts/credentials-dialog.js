
export function createCredentialsDialog() {
    const dialog = document.getElementById('accountCreatedDialog');
    const email = document.getElementById('createdAccountEmail');
    const status = document.getElementById('createdEmailStatus');
    const password = document.getElementById('createdTempPassword');
    const copyButton = document.getElementById('copyCreatedTempPassword');

    // Reuse the existing dialog heading.
    const title = dialog.querySelector('h2');

    function show({ accountEmail, tempPassword, emailSent, action = 'created' }) {
        const isReset = action === 'reset';

        email.textContent = accountEmail;
        password.value = tempPassword;

        if (title) {
            title.textContent = isReset
                ? 'Password Reset Successfully'
                : 'Account Created Successfully';
        }

        status.textContent = emailSent
            ? 'Email request accepted by the email provider. Ask the recipient to check their inbox and spam folder.'
            : 'Email could not be sent. Copy the temporary password and share it securely.';

        copyButton.textContent = 'Copy';
        dialog.showModal();
    }

    async function copyPassword() {
        try {
            await navigator.clipboard.writeText(password.value);
        } catch {
            password.focus();
            password.select();

            if (!document.execCommand('copy')) {
                status.textContent += ' Copy failed. Please select and copy the password manually.';
                return;
            }
        }

        copyButton.textContent = 'Copied!';
    }

    copyButton.addEventListener('click', copyPassword);

    document.querySelectorAll('[data-close-created-dialog]')
        .forEach(button => {
            button.addEventListener('click', () => dialog.close());
        });

    return { show };
}


export function createConfirmationDialog() {
    const dialog = document.getElementById('confirmationDialog');
    const title = document.getElementById('confirmationTitle');
    const message = document.getElementById('confirmationMessage');
    const confirmButton = document.getElementById('confirmationConfirm');
    const cancelButton = document.getElementById('confirmationCancel');
    const icon = document.getElementById('confirmationIcon');

    let resolver = null;

    function show({
        title: heading = 'Are you sure?',
        message: description = 'Please confirm this action.',
        confirmText = 'Confirm',
        cancelText = 'Cancel',
        danger = false
    } = {}) {
        title.textContent = heading;
        message.textContent = description;
        confirmButton.textContent = confirmText;
        cancelButton.textContent = cancelText;

        confirmButton.classList.toggle('danger-btn', danger);
        icon.classList.toggle('danger', danger);

        dialog.showModal();

        return new Promise(resolve => {
            resolver = resolve;
        });
    }

    function finish(result) {
        if (!resolver) return;

        const resolve = resolver;
        resolver = null;

        dialog.close();
        resolve(result);
    }

    confirmButton.addEventListener('click', () => finish(true));
    cancelButton.addEventListener('click', () => finish(false));

    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        finish(false);
    });

    return { show };
}
