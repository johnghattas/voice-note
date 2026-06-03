// Theme management module - IIFE to prevent FOUC
(function() {
  'use strict';

  const STORAGE_KEY = 'voicenotes_theme';
  const THEME_LIGHT = 'light';
  const THEME_DARK = 'dark';

  /**
   * Get the initial theme preference
   * Priority: localStorage > system preference > default (light)
   */
  function getInitialTheme() {
    // Check localStorage first
    const savedTheme = localStorage.getItem(STORAGE_KEY);
    if (savedTheme === THEME_LIGHT || savedTheme === THEME_DARK) {
      return savedTheme;
    }

    // Fall back to system preference
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return THEME_DARK;
    }

    // Default to light
    return THEME_LIGHT;
  }

  /**
   * Apply theme to the document
   */
  function applyTheme(theme) {
    const html = document.documentElement;
    html.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }

  /**
   * Toggle between light and dark themes
   */
  function toggleTheme() {
    const html = document.documentElement;
    const currentTheme = html.getAttribute('data-theme') || THEME_LIGHT;
    const newTheme = currentTheme === THEME_LIGHT ? THEME_DARK : THEME_LIGHT;
    applyTheme(newTheme);
    return newTheme;
  }

  /**
   * Get current theme
   */
  function getCurrentTheme() {
    return document.documentElement.getAttribute('data-theme') || THEME_LIGHT;
  }

  // Apply theme immediately to prevent FOUC
  const initialTheme = getInitialTheme();
  applyTheme(initialTheme);

  // Listen for system preference changes (only if user hasn't manually set a preference)
  if (window.matchMedia) {
    const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');

    // Only listen to system changes if no explicit preference is saved
    darkModeQuery.addEventListener('change', (e) => {
      const savedTheme = localStorage.getItem(STORAGE_KEY);
      // Only auto-update if user hasn't manually set a theme
      if (!savedTheme) {
        const newTheme = e.matches ? THEME_DARK : THEME_LIGHT;
        applyTheme(newTheme);
      }
    });
  }

  // Expose toggle function globally for button onclick handlers
  window.toggleTheme = toggleTheme;
  window.getCurrentTheme = getCurrentTheme;

})();
