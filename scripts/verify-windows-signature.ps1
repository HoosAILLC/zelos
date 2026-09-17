# Run on Windows after installing the candidate into an isolated directory and
# before uploading release artifacts. Pass the installed NSIS uninstaller so
# this verifies the actual embedded payload, not a separate build-time copy.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Installer,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$AppDirectory,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Publisher,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Uninstaller
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Windows signature verification must run on Windows.'
}
if ([string]::IsNullOrWhiteSpace($Publisher)) {
    throw 'Publisher must be the expected certificate common name.'
}

function Get-RequiredItem {
    param([string]$LiteralPath, [bool]$Directory)
    $item = Get-Item -LiteralPath $LiteralPath -Force
    if ($item.PSProvider.Name -ne 'FileSystem' -or $item.PSIsContainer -ne $Directory -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Verification requires ordinary files and directories, not links.'
    }
    return $item
}

function Find-SignTool {
    $command = Get-Command signtool.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) { return $command.Source }

    # Use the installed SDK only. Do not download tools or modify the machine.
    $architecture = switch ($env:PROCESSOR_ARCHITECTURE) {
        'ARM64' { 'arm64' }
        'AMD64' { 'x64' }
        default { 'x86' }
    }
    $roots = @()
    if ($env:WindowsSdkDir) { $roots += Join-Path $env:WindowsSdkDir 'bin' }
    $installedSdk = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots' -Name KitsRoot10 -ErrorAction SilentlyContinue
    if ($null -ne $installedSdk) { $roots += Join-Path $installedSdk.KitsRoot10 'bin' }
    foreach ($programDirectory in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
        if ($programDirectory) { $roots += Join-Path $programDirectory 'Windows Kits\10\bin' }
    }
    foreach ($root in ($roots | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        $versions = @(Get-ChildItem -LiteralPath $root -Directory | Where-Object {
            $_.Name -match '^\d+\.\d+\.\d+\.\d+$'
        } | Sort-Object { [version]$_.Name } -Descending)
        foreach ($directory in $versions) {
            $candidate = Join-Path $directory.FullName "$architecture\signtool.exe"
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
        $candidate = Join-Path $root "$architecture\signtool.exe"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    throw "Windows SDK SignTool for $architecture was not found on PATH or in the installed SDK. Release signatures and timestamps cannot be verified."
}

$installerFile = Get-RequiredItem $Installer $false
$uninstallerFile = Get-RequiredItem $Uninstaller $false
$appFolder = Get-RequiredItem $AppDirectory $true
if ($installerFile.Extension -ine '.exe' -or $uninstallerFile.Extension -ine '.exe') {
    throw 'Installer and Uninstaller must be executable files.'
}
if ([string]::Equals($installerFile.FullName, $uninstallerFile.FullName, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Uninstaller must be the installed NSIS uninstaller.'
}
$appPrefix = $appFolder.FullName.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
if (-not $uninstallerFile.FullName.StartsWith($appPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Uninstaller must be inside the installed AppDirectory.'
}

$entries = @(Get-ChildItem -LiteralPath $appFolder.FullName -Recurse -Force)
if (@($entries | Where-Object {
    ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
}).Count -gt 0) {
    throw 'The packaged app contains a link whose signature coverage cannot be verified.'
}
$appFiles = @($entries | Where-Object {
    -not $_.PSIsContainer -and $_.Extension -in @('.exe', '.dll', '.node')
})
if (@($appFiles | Where-Object {
    $_.Extension -ieq '.exe' -and
    -not [string]::Equals($_.FullName, $uninstallerFile.FullName, [StringComparison]::OrdinalIgnoreCase)
}).Count -eq 0) {
    throw 'The packaged app does not contain an executable to verify.'
}
$signTool = Find-SignTool
$files = @($installerFile, $uninstallerFile) + $appFiles
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$installerSubject = $null

foreach ($file in $files) {
    if (-not $seen.Add($file.FullName)) { continue }
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or
        $null -eq $signature.SignerCertificate) {
        throw "Missing or invalid embedded Authenticode signature: $($file.Name)"
    }
    # Certificate parsing handles escaped commas and other DN characters. Do
    # not match the printable subject with a substring, regex, or wildcard.
    $commonName = $signature.SignerCertificate.GetNameInfo(
        [Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if (-not [string]::Equals($commonName, $Publisher, [StringComparison]::Ordinal)) {
        throw "Unexpected signing publisher: $($file.Name)"
    }
    if ($null -eq $signature.TimeStamperCertificate) {
        throw "Missing Authenticode timestamp: $($file.Name)"
    }

    # /pa checks public Authenticode trust, /all checks every embedded
    # signature, and /tw warns about absent timestamps. Warnings (exit 2)
    # fail release verification too. Windows validates timestamp signatures
    # and signing-time validity; do not compare short-lived certs to today.
    $LASTEXITCODE = 0
    $toolOutput = & $signTool verify /pa /all /v /tw $file.FullName 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "SignTool rejected the signature or timestamp: $($file.Name)"
    }
    if ([string]::Equals($file.FullName, $installerFile.FullName, [StringComparison]::OrdinalIgnoreCase)) {
        $installerSubject = $signature.SignerCertificate.Subject
    }
}

if ([string]::IsNullOrWhiteSpace($installerSubject)) {
    throw 'Installer signature verification did not complete.'
}
[ordered]@{
    publisher = $installerSubject
    checks = @('authenticode', 'timestamp')
} | ConvertTo-Json -Compress
