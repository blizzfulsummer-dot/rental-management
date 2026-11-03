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
