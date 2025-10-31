function resolveAppBaseUrl() {
  const configured = (process.env.APP_BASE_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');

  const clientOrigin = (process.env.CLIENT_ORIGIN || '').split(',').map((item) => item.trim())[0];
  if (clientOrigin) return clientOrigin.replace(/\/+$/, '');

  return 'http://localhost:5173';
}

module.exports = {
  resolveAppBaseUrl,
};
