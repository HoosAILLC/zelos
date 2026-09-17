import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Fixed PowerShell code. Neither the downloaded path nor the publisher becomes
// source code, a shell argument, or part of an error shown to the renderer.
export const WINDOWS_UPDATE_SIGNATURE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$signature = Get-AuthenticodeSignature -LiteralPath $env:ZELOS_UPDATE_FILE
if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or
    $null -eq $signature.SignerCertificate -or $null -eq $signature.TimeStamperCertificate) {
  throw 'The update does not have a valid timestamped publisher signature.'
}
$publisher = $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
if (-not [string]::Equals($publisher, $env:ZELOS_UPDATE_PUBLISHER, [StringComparison]::Ordinal)) {
  throw 'The update publisher does not match this app.'
}
Write-Output 'ZELOS_SIGNATURE_OK'
`;

export async function verifyWindowsUpdate(file, publisher, { run = promisify(execFile), env = process.env } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || typeof publisher !== 'string' || !publisher.trim()) throw new Error('Invalid update signature request');
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const result = await run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_UPDATE_SIGNATURE_SCRIPT], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 128 * 1024,
      env: { ...env, ZELOS_UPDATE_FILE: file, ZELOS_UPDATE_PUBLISHER: publisher },
    });
    if (result.stdout.trim() !== 'ZELOS_SIGNATURE_OK') throw new Error('Signature verification did not complete');
  } catch { throw new Error('The Windows update signature could not be verified.'); }
}
