// Release-only overrides. Local/preview builds keep their explicit ad-hoc defaults.
export function signingConfig(env, platform) {
  const requireValues = (names) => {
    const missing = names.filter(name => !env[name]?.trim());
    if (missing.length) throw new Error(`Signed ${platform} release requires: ${missing.join(', ')}`);
  };
  requireValues(['GITHUB_SHA']);
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA)) throw new Error('Signing requires a full source commit');
  const common = { forceCodeSigning: true, publish: null, extraMetadata: { commit: env.GITHUB_SHA } };
  if (platform === 'darwin') {
    requireValues(['CSC_LINK', 'CSC_KEY_PASSWORD', 'MAC_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']);
    if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) throw new Error('APPLE_TEAM_ID must be a ten-character Apple team identifier');
    const identity = env.MAC_SIGNING_IDENTITY.trim();
    if (identity === '-' || identity.startsWith('Developer ID')) throw new Error('MAC_SIGNING_IDENTITY must be the certificate name without its Developer ID Application prefix');
    if (!identity.endsWith(`(${env.APPLE_TEAM_ID})`)) throw new Error('MAC_SIGNING_IDENTITY must end with the configured Apple team identifier in parentheses');
    return { ...common, mac: {
      identity, type: 'distribution', hardenedRuntime: true, notarize: true,
      // Assessment happens after notarization, including the actual mounted DMG.
      gatekeeperAssess: false, strictVerify: true,
      entitlements: 'build/entitlements.release.plist',
      entitlementsInherit: 'build/entitlements.release.plist',
    }, dmg: { sign: true } };
  }
  if (platform !== 'win32') throw new Error('Signed installers require macOS or Windows');
  requireValues(['WINDOWS_SIGNING_PROVIDER', 'WINDOWS_PUBLISHER_NAME']);
  const win = { signAndEditExecutable: true, signExecutable: true, signExts: ['.exe', '.dll', '.node'] };
  if (env.WINDOWS_SIGNING_PROVIDER === 'azure') {
    requireValues(['AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_CERTIFICATE_PROFILE', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']);
    const endpoint = new URL(env.AZURE_SIGNING_ENDPOINT);
    if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.codesigning.azure.net') || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.port) {
      throw new Error('AZURE_SIGNING_ENDPOINT must be an HTTPS Azure Artifact Signing endpoint');
    }
    win.azureSignOptions = {
      publisherName: env.WINDOWS_PUBLISHER_NAME, endpoint: endpoint.href,
      codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT,
      certificateProfileName: env.AZURE_CERTIFICATE_PROFILE,
      fileDigest: 'SHA256', timestampDigest: 'SHA256', timestampRfc3161: 'http://timestamp.acs.microsoft.com',
    };
  } else if (env.WINDOWS_SIGNING_PROVIDER === 'certificate') {
    requireValues(['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']);
    win.signtoolOptions = {
      publisherName: env.WINDOWS_PUBLISHER_NAME,
      signingHashAlgorithms: ['sha256'], rfc3161TimeStampServer: 'http://timestamp.digicert.com',
    };
  } else throw new Error('WINDOWS_SIGNING_PROVIDER must be azure or certificate');
  return { ...common, win };
}
