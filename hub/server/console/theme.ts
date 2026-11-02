// A fixed, hash-allowed classic script in <head>: restore the theme before the stylesheet paints.
// CSS handles system changes, including when storage is unavailable or scripts are disabled.
export const THEME_SCRIPT = `(() => {
  const key = 'circle-hub-theme';
  const root = document.documentElement;
  let choice = 'system';
  const valid = (value) => value === 'dark' || value === 'light' || value === 'system';
  const apply = (value) => {
    choice = valid(value) ? value : 'system';
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
    for (const control of document.querySelectorAll('[data-theme-switch]')) {
      control.hidden = false;
      for (const button of control.querySelectorAll('[data-theme-choice]')) {
        button.setAttribute('aria-pressed', String(button.dataset.themeChoice === choice));
      }
    }
  };
  try { apply(localStorage.getItem(key)); } catch { apply('system'); }
  document.addEventListener('DOMContentLoaded', () => apply(choice), { once: true });
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest('[data-theme-switch] [data-theme-choice]');
    if (!button || !valid(button.dataset.themeChoice)) return;
    apply(button.dataset.themeChoice);
    try {
      if (choice === 'system') localStorage.removeItem(key);
      else localStorage.setItem(key, choice);
    } catch { /* This page still switches when browser storage is blocked. */ }
  });
  window.addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) {
      try { apply(localStorage.getItem(key)); } catch { apply('system'); }
    }
  });
})();`;
