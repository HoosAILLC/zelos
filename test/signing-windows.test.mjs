import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyWindowsUpdate, WINDOWS_UPDATE_SIGNATURE_SCRIPT } from '../desktop/update-signature.js';

const verifier = fileURLToPath(new URL('../scripts/verify-windows-signature.ps1', import.meta.url));
const nativeOnly = process.platform !== 'win32'
  ? 'Requires native Windows PowerShell, Authenticode, and the installed Windows SDK; no signing is simulated.'
  : false;

describe('Windows runtime signature process boundary', () => {
  it('passes paths and publishers through environment values without constructing command source', async () => {
    const file = path.resolve("literal 'quote' $value [square] & semi;.exe");
    const publisher = "Example 'Publisher' $value & literal";
    let invocation;
    await verifyWindowsUpdate(file, publisher, { env: { SystemRoot: 'C:\\Windows' },
      run: async (...args) => { invocation = args; return { stdout: 'ZELOS_SIGNATURE_OK\r\n' }; } });
    const [command, args, options] = invocation;
    assert.equal(command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_UPDATE_SIGNATURE_SCRIPT]);
    assert.equal(args.some(arg => arg.includes(file) || arg.includes(publisher)), false);
    assert.equal(options.shell, undefined);
    assert.equal(options.env.ZELOS_UPDATE_FILE, file);
    assert.equal(options.env.ZELOS_UPDATE_PUBLISHER, publisher);
    assert.equal(options.timeout, 30_000);
  });

  it('fails closed when PowerShell fails, times out, or does not return exact verification evidence', async () => {
    const file = path.resolve('candidate.exe');
    for (const run of [
      async () => { throw Object.assign(new Error('not installed'), { code: 'ENOENT' }); },
      async () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); },
      async () => ({ stdout: '' }),
      async () => ({ stdout: 'ZELOS_SIGNATURE_OK\nunexpected output' }),
      async () => ({ stdout: 'not verified' }),
    ]) await assert.rejects(verifyWindowsUpdate(file, 'Example Publisher', { run }), /signature could not be verified/);
  });

  it('rejects relative paths and empty publishers before starting PowerShell', async () => {
    let calls = 0;
    const run = async () => { calls++; return { stdout: 'ZELOS_SIGNATURE_OK' }; };
    for (const [file, publisher] of [['relative.exe', 'Example'], [path.resolve('candidate.exe'), ' '], [null, 'Example']]) {
      await assert.rejects(verifyWindowsUpdate(file, publisher, { run }), /Invalid update signature request/);
    }
    assert.equal(calls, 0);
  });
});

describe('Windows release signature rejection', { skip: nativeOnly }, () => {
  let scratch;
  let native;

  before(() => {
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
      Set-StrictMode -Version Latest
      $ErrorActionPreference = 'Stop'
      $tokens = $null
      $parseErrors = $null
      $ast = [Management.Automation.Language.Parser]::ParseFile(
        $env:ZELOS_TEST_VERIFIER_PATH, [ref]$tokens, [ref]$parseErrors)
      if ($parseErrors.Count -ne 0) { throw ($parseErrors | Out-String) }
      # Exercise the production SDK discovery function, without running its
      # artifact checks or substituting a fake signing tool.
      $functions = @($ast.FindAll({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Find-SignTool'
      }, $true))
      if ($functions.Count -ne 1) { throw 'Expected one production SignTool discovery function' }
      . ([scriptblock]::Create($functions[0].Extent.Text))
      $signTool = Find-SignTool
      $fixture = $null
      foreach ($candidate in @((Join-Path $PSHOME 'pwsh.exe'), $signTool, $env:ZELOS_TEST_NODE_PATH)) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $signature = Get-AuthenticodeSignature -LiteralPath $candidate
        if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or
            $null -eq $signature.SignerCertificate -or $null -eq $signature.TimeStamperCertificate) { continue }
        try {
          $toolOutput = & $signTool verify /pa /all /v /tw $candidate 2>&1
          if ($LASTEXITCODE -ne 0) { continue }
        } catch { continue }
        $fixture = $candidate
        break
      }
      if ($null -eq $fixture) { throw 'No trusted, timestamped runner executable is available for negative tests' }
      [ordered]@{
        signTool = $signTool
        fixture = $fixture
        publisher = $signature.SignerCertificate.GetNameInfo(
          [Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
        subject = $signature.SignerCertificate.Subject
        parameters = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
        architecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString().ToLowerInvariant()
      } | ConvertTo-Json -Compress
    `], {
      encoding: 'utf8', timeout: 60_000, windowsHide: true,
      env: { ...process.env, ZELOS_TEST_VERIFIER_PATH: verifier, ZELOS_TEST_NODE_PATH: process.execPath },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `Native PowerShell/SDK fixture setup failed: ${result.stderr}`);
    native = JSON.parse(result.stdout);
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zelos-signature-test-'));
  });

  after(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });

  function payload() {
    const directory = fs.mkdtempSync(path.join(scratch, 'candidate-'));
    const app = path.join(directory, 'installed app');
    fs.mkdirSync(app);
    const installer = path.join(directory, 'Zelos setup.exe');
    const uninstaller = path.join(app, 'Uninstall Zelos.exe');
    for (const destination of [installer, uninstaller, path.join(app, 'Zelos.exe')]) {
      fs.copyFileSync(native.fixture, destination);
    }
    return { directory, app, installer, uninstaller };
  }

  function removeSignature(file, option = '/s') {
    // Modify only a disposable copy of an existing PE. No certificate is
    // created/imported, no signing account is used, and nothing is executed.
    const result = spawnSync(native.signTool, ['remove', option, file], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `Could not prepare unsigned PE fixture: ${result.stderr}`);
  }

  function signatureDetails(file) {
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference = 'Stop'
      $signature = Get-AuthenticodeSignature -LiteralPath $env:ZELOS_TEST_SIGNATURE_FILE
      [ordered]@{
        status = $signature.Status.ToString()
        hasSigner = $null -ne $signature.SignerCertificate
        hasTimestamp = $null -ne $signature.TimeStamperCertificate
      } | ConvertTo-Json -Compress
    `], { encoding: 'utf8', timeout: 30_000, windowsHide: true,
      env: { ...process.env, ZELOS_TEST_SIGNATURE_FILE: file } });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }

  function verify(candidate, publisher) {
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', verifier,
      '-Installer', candidate.installer, '-AppDirectory', candidate.app,
      '-Uninstaller', candidate.uninstaller, '-Publisher', publisher], {
      encoding: 'utf8', timeout: 90_000, windowsHide: true,
    });
    assert.ifError(result.error);
    return result;
  }

  function reject(candidate, publisher, message) {
    const result = verify(candidate, publisher);
    assert.notEqual(result.status, 0, 'Invalid payload unexpectedly passed release verification');
    assert.equal(result.stdout.trim(), '', 'A failed verification must not emit a passing receipt');
    const errorText = result.stderr.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ');
    assert.match(errorText, message);
  }

  it('parses the production verifier and discovers executable SDK tooling on the native architecture', () => {
    assert.deepEqual(native.parameters, ['Installer', 'AppDirectory', 'Publisher', 'Uninstaller']);
    assert.equal(native.architecture, process.arch);
    assert.ok(path.isAbsolute(native.signTool));
    assert.ok(fs.statSync(native.signTool).isFile());
  });

  it('emits compact evidence for trusted runner fixtures with their actual publisher', () => {
    // This validates the verifier against existing runner signatures. These
    // are copied fixtures, not Zelos builds or proof our release signer works.
    const result = verify(payload(), native.publisher);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      publisher: native.subject, checks: ['authenticode', 'timestamp'],
    });
    assert.equal(result.stdout.trim().split(/\r?\n/).length, 1);
  });

  it('rejects an unsigned installer before producing signature evidence', () => {
    const candidate = payload();
    removeSignature(candidate.installer);
    reject(candidate, native.publisher, /Missing or invalid embedded Authenticode signature: Zelos setup\.exe/);
  });

  it('rejects a valid trusted signature belonging to a different publisher', () => {
    reject(payload(), `${native.publisher} - deliberately incorrect publisher`, /Unexpected signing publisher: Zelos setup\.exe/);
  });

  it('rejects an unsigned installed NSIS uninstaller', () => {
    const candidate = payload();
    removeSignature(candidate.uninstaller);
    reject(candidate, native.publisher, /Missing or invalid embedded Authenticode signature: Uninstall Zelos\.exe/);
  });

  it('runtime updater accepts a real trusted timestamped PE with its actual publisher', async () => {
    await assert.doesNotReject(verifyWindowsUpdate(payload().installer, native.publisher));
  });

  it('runtime updater rejects an unsigned copy and a trusted signature from the wrong publisher', async () => {
    const candidate = payload();
    await assert.rejects(verifyWindowsUpdate(candidate.installer, `${native.publisher} - wrong publisher`), /signature could not be verified/);
    removeSignature(candidate.installer);
    await assert.rejects(verifyWindowsUpdate(candidate.installer, native.publisher), /signature could not be verified/);
  });

  it('runtime updater rejects a real signature after its timestamp is removed', async () => {
    const candidate = payload();
    // SDK /u removes unauthenticated attributes such as timestamps, preserving
    // the original signer. This does not create or import any certificate.
    // https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool
    removeSignature(candidate.installer, '/u');
    const signature = signatureDetails(candidate.installer);
    assert.equal(signature.hasSigner, true);
    assert.equal(signature.hasTimestamp, false);
    await assert.rejects(verifyWindowsUpdate(candidate.installer, native.publisher), /signature could not be verified/);
  });

  it('runtime updater rejects a modified signed PE section', async () => {
    const candidate = payload();
    const bytes = fs.readFileSync(candidate.installer);
    const pe = bytes.readUInt32LE(0x3c);
    assert.equal(bytes.subarray(pe, pe + 4).toString('hex'), '50450000');
    const firstSection = pe + 24 + bytes.readUInt16LE(pe + 20);
    const size = bytes.readUInt32LE(firstSection + 16);
    const offset = bytes.readUInt32LE(firstSection + 20);
    assert.ok(size > 16 && offset > firstSection && offset + size <= bytes.length);
    bytes[offset + 16] ^= 1;
    fs.writeFileSync(candidate.installer, bytes);
    assert.notEqual(signatureDetails(candidate.installer).status, 'Valid');
    await assert.rejects(verifyWindowsUpdate(candidate.installer, native.publisher), /signature could not be verified/);
  });

  it('runtime updater verifies a signed file with shell metacharacters in its literal path', async () => {
    const directory = fs.mkdtempSync(path.join(scratch, 'literal-path-'));
    const file = path.join(directory, "signed 'quote' $value [square] & semi;.exe");
    fs.copyFileSync(native.fixture, file);
    const execute = promisify(execFile);
    await assert.doesNotReject(verifyWindowsUpdate(file, native.publisher, {
      run: async (command, args, options) => {
        assert.equal(args.some(arg => arg.includes(file) || arg.includes(native.publisher)), false);
        assert.equal(options.env.ZELOS_UPDATE_FILE, file);
        assert.equal(options.env.ZELOS_UPDATE_PUBLISHER, native.publisher);
        return execute(command, args, options);
      },
    }));
  });

  for (const extension of ['dll', 'node']) {
    it(`rejects an unsigned nested .${extension} even when installer and app executables are trusted`, () => {
      const candidate = payload();
      const nested = path.join(candidate.app, 'resources', 'native');
      fs.mkdirSync(nested, { recursive: true });
      const binary = path.join(nested, `unsigned.${extension}`);
      fs.copyFileSync(native.fixture, binary);
      removeSignature(binary);
      reject(candidate, native.publisher, new RegExp(`Missing or invalid embedded Authenticode signature: unsigned\\.${extension}`));
    });
  }
});
