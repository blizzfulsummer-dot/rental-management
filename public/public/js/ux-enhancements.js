(() => {
      const eyeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
      const eyeOffIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.1 3.8M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7a10 10 0 0 0 4-.8"/></svg>';
      function enhancePasswordInputs() {
        document.querySelectorAll('input[type="password"]:not([data-visibility-ready])').forEach(input => {
          input.dataset.visibilityReady = 'true';
          const wrap = document.createElement('div');
          wrap.className = 'password-field-wrap';
          input.parentNode.insertBefore(wrap, input);
          wrap.appendChild(input);
          const toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'password-toggle';
          toggle.setAttribute('aria-label', 'Show password');
          toggle.setAttribute('aria-pressed', 'false');
          toggle.title = 'Show password';
          toggle.innerHTML = eyeIcon;
          toggle.addEventListener('click', () => {
            const reveal = input.type === 'password';
            input.type = reveal ? 'text' : 'password';
            toggle.innerHTML = reveal ? eyeOffIcon : eyeIcon;
            toggle.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
            toggle.setAttribute('aria-pressed', String(reveal));
            toggle.title = reveal ? 'Hide password' : 'Show password';
            input.focus({ preventScroll: true });
          });
          wrap.appendChild(toggle);
        });
      }
      function showToast(message, type = 'success') {
        const region = document.getElementById('toastRegion');
        if (!region || !message) return;
        const toast = document.createElement('div');
        toast.className = `reman-toast${type === 'error' ? ' error' : ''}`;
        toast.textContent = message;
        region.appendChild(toast);
        window.setTimeout(() => toast.remove(), 4200);
      }
      // Provide visible loading feedback even while the page's data panel is being rendered.
      function showInlineLoading() {
        const panel = document.getElementById('mainPanelContent');
        if (!panel || panel.dataset.loadingHint === 'shown') return;
        panel.dataset.loadingHint = 'shown';
      }
      enhancePasswordInputs();
      const observer = new MutationObserver(() => enhancePasswordInputs());
      observer.observe(document.body, { childList: true, subtree: true });
      document.addEventListener('click', event => {
        const button = event.target.closest('#refreshBtn');
        if (!button) return;
        const original = button.dataset.originalLabel || button.textContent.trim() || 'Refresh';
        button.dataset.originalLabel = original;
        button.disabled = true;
        button.textContent = 'Refreshing…';
        const restore = () => { button.disabled = false; button.textContent = original; };
        // requestJson owns the visible global fetch indicator; restore after the refresh promise settles.
        const waitForRefresh = () => {
          if (!button.isConnected) return;
          const overlay = document.getElementById('globalLoading');
          if (overlay && overlay.classList.contains('visible')) window.setTimeout(waitForRefresh, 120);
          else restore();
        };
        window.setTimeout(waitForRefresh, 120);
      });
      // Export a tiny UX helper for existing handlers without changing API contracts.
      window.remanUX = { showToast, showInlineLoading };
      // Timer-based global submit animation removed. Async forms now use the
      // shared button helper and restore state from their actual Promise completion.

    })();
