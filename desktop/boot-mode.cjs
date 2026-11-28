const DEFAULT_CLOUD_URL = 'https://work.manyaitool.com';

function normalizeUrl(raw) {
  return typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
}

/**
 * Resolves whether the desktop shell boots Local-First (embedded local server)
 * or connects to a Cloud Control Plane.
 *
 * Precedence:
 * 1. testMode -> local
 * 2. DUOLAWORK_CLOUD_URL env -> cloud
 * 3. ~/.config/duolawork-desktop/client.json (`mode: 'local'` or `serverUrl`)
 * 4. Legacy owner auto-login file (`cloud-access.json`) -> cloud (DEFAULT_CLOUD_URL)
 * 5. Fresh external install -> local (Local-First, zero login wall)
 */
function resolveDesktopBootMode({
  envCloudUrl = '',
  clientConfig = null,
  hasCloudAccess = false,
  testMode = false,
  defaultCloudUrl = DEFAULT_CLOUD_URL
} = {}) {
  if (testMode) {
    return { mode: 'local', cloudUrl: '' };
  }
  const envUrl = normalizeUrl(envCloudUrl);
  if (envUrl) {
    return { mode: 'cloud', cloudUrl: envUrl };
  }
  if (clientConfig && typeof clientConfig === 'object') {
    if (clientConfig.mode === 'local') {
      return { mode: 'local', cloudUrl: '' };
    }
    const cfgUrl = normalizeUrl(clientConfig.serverUrl);
    if (cfgUrl) {
      return { mode: 'cloud', cloudUrl: cfgUrl };
    }
  }
  if (hasCloudAccess) {
    return { mode: 'cloud', cloudUrl: normalizeUrl(defaultCloudUrl) };
  }
  return { mode: 'local', cloudUrl: '' };
}

module.exports = { DEFAULT_CLOUD_URL, resolveDesktopBootMode };
