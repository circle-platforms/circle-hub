import { INTERACTION_SCRIPT } from './interaction.ts';
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
        const selected = button.dataset.themeChoice === choice;
        button.setAttribute('aria-checked', String(selected));
        button.tabIndex = selected ? 0 : -1;
      }
    }
  };
  try { apply(localStorage.getItem(key)); } catch { apply('system'); }
  document.addEventListener('DOMContentLoaded', () => apply(choice), { once: true });
  const choose = (value) => {
    apply(value);
    try {
      if (choice === 'system') localStorage.removeItem(key);
      else localStorage.setItem(key, choice);
    } catch { /* This page still switches when browser storage is blocked. */ }
  };
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest('[data-theme-switch] [data-theme-choice]');
    if (button && valid(button.dataset.themeChoice)) { choose(button.dataset.themeChoice); return; }
  });
  document.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        const search = document.getElementById('console-search');
        if (search) {
          const toggle = document.getElementById('console-navigation-toggle');
          if (toggle) toggle.checked = true;
          search.focus();
          event.preventDefault();
        }
      }
      return;
    }
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest('[data-theme-switch] [data-theme-choice]');
    if (!button) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...button.parentElement.querySelectorAll('[data-theme-choice]')];
    const at = buttons.indexOf(button);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (at + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
    choose(buttons[next].dataset.themeChoice);
    buttons[next].focus();
    event.preventDefault();
  });
  document.addEventListener('circle-hub:render', () => apply(choice));
  window.addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) {
      try { apply(localStorage.getItem(key)); } catch { apply('system'); }
    }
  });
})();\n${INTERACTION_SCRIPT}`;
