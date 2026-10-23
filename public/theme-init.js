// Apply the stored theme before the first paint.
try {
  const theme = localStorage.getItem('bridge.theme')
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme)
} catch { /* storage can be unavailable */ }
