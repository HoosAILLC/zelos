# Signing desktop releases

This is the maintainer setup for signed macOS and Windows downloads and their update feeds. Apple Developer and Windows signing accounts have not yet been set up, and real signing has not been exercised end to end. The published **1.8.1 downloads remain unsigned and require manual updates**; adding this workflow does not change existing downloads.

The release workflow, `.github/workflows/release.yml`, requires signing and verification for all four installers. A manual run builds verified candidates; a matching version tag also publishes the release after every required job passes. The separate `.github/workflows/desktop.yml` workflow produces unsigned development previews and cannot publish a release.

## Set up the publisher accounts

Choose whether the publisher is you personally or an existing legal organization before enrolling. The name on the certificates must match the verified identity; `Zelos` remains the product name. Do not put a product or trading name into fields asking for your personal legal name.

| Account | Published base cost in USD | What is included |
| --- | --- | --- |
| Apple Developer Program | $99 per year; local pricing varies | Developer ID signing and access to Apple's notarization service |
| Azure Artifact Signing Basic | $9.99 per account per month | 5,000 signatures per month; $0.005 for each additional signature |

Apple's price is listed in its [enrollment guide](https://developer.apple.com/programs/enroll/); Microsoft's rates are in its [pricing-tier table](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-change-sku). These base fees total **$218.88 per year**, before taxes, extra signatures, or other Azure resources. Each signed file consumes signing usage, so one Zelos release requires multiple signatures. Review the actual price at checkout.

1. **Enroll with Apple.** Use an Apple Account with two-factor authentication. Individuals and sole proprietors enroll under their legal name. Organizations need a legal entity, a D-U-N-S number (except government entities), someone authorized to bind the organization, a work-domain email, and a functional organization website. Begin at [Apple Developer enrollment](https://developer.apple.com/programs/enroll/). The account holder completes identity verification, accepts the agreements, and approves the membership purchase directly with Apple; the [Apple Developer app instructions](https://developer.apple.com/help/account/membership/enrolling-in-the-app/) describe the ID and payment steps. Wait for approval before creating the Developer ID certificate below.
2. **Prepare Azure billing and eligibility.** Artifact Signing requires a paid Azure subscription; free, trial, and sponsored subscriptions are not supported. See [Microsoft's account requirements](https://learn.microsoft.com/en-us/azure/artifact-signing/faq). Public Trust individual developers must be in the US or Canada, with an Individual-type billing account whose legal name and address match their ID. Organization eligibility currently covers the US, Canada, EU, UK, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway, and Israel. Check the current [eligibility and setup requirements](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart) before enabling a paid resource.
3. **Create the Windows signing account.** In the Azure portal, register `Microsoft.CodeSigning`, create a Basic Artifact Signing account, and assign the account holder the Identity Verifier role. The owner completes public identity validation in the portal, including any requested identification or business records. After approval, create a **Public Trust** certificate profile. Continue with the scoped CI signing identity below.
4. **Configure GitHub after both approvals.** Create the Mac certificate and dedicated notarization password, then the Azure signing service principal. Put secrets directly into the `release-signing` environment using the tables below. Share only completion status and non-secret identifiers when coordinating setup; do not send identity documents, payment information, account passwords, or private keys through chat.

Account enrollment, identity verification, legal agreements, and payment are owner steps. This repository does not create those accounts or authorize purchases. Signed downloads and in-app installation must wait for successful enrollment, configured credentials, and a complete signed candidate run.

## Store credentials in GitHub

Create the GitHub environment **`release-signing`** under the repository's **Settings → Environments**. The Mac build, Windows build, and native Windows verification jobs use this environment. Put signing secrets there; the variables below can be repository Actions variables or environment variables. Any environment branch/tag rules must allow the reviewed candidate branch and intended release tags. Configure protection rules appropriate for who may authorize signing.

Enter secret values directly in GitHub's secret fields or through a secure secret-management workflow. Do not paste private keys, certificate exports, passwords, or client secrets into chat, issues, source files, workflow YAML, or build logs. Base64 encodes a certificate bundle; it does not encrypt it.

Keep certificate exports outside the checkout and retain any necessary backup in secure storage. Limit access to release workflows and tags, and rotate credentials when they expire or are exposed. Non-secret publisher identities and account identifiers go in Actions variables.

## macOS: Developer ID and notarization

1. Use an Apple Developer Program team and create a **Developer ID Application** certificate. Install it on the Mac that generated its private key. A Developer ID Installer certificate is for installer packages and does not replace the application certificate. Follow [Apple's certificate instructions](https://developer.apple.com/help/account/certificates/create-developer-id-certificates).
2. In Keychain Access, export the signing identity, including its private key, as a password-protected `.p12`. Encode the file as base64 for the secret below; keep the export password separate. See [Apple's export instructions](https://support.apple.com/guide/keychain-access/import-and-export-keychain-items-kyca35961/mac).
3. Generate a dedicated [Apple app-specific password](https://support.apple.com/en-us/102654) for notarization. Use an Apple Account authorized for this team; do not use the account's main password.
4. Add these Actions settings:

| Setting | Type | Value |
| --- | --- | --- |
| `MAC_CSC_LINK` | Secret | Base64-encoded Developer ID Application `.p12`, including the private key |
| `MAC_CSC_KEY_PASSWORD` | Secret | Password protecting that `.p12` |
| `APPLE_ID` | Secret | Apple Account email used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | Secret | Dedicated app-specific password |
| `APPLE_TEAM_ID` | Variable | The team's 10-character identifier |
| `MAC_SIGNING_IDENTITY` | Variable | Certificate name without the `Developer ID Application: ` prefix; retain the team suffix, for example `Example Company (ABCDE12345)` |

The workflow passes the Mac certificate secrets to electron-builder as `CSC_LINK` and `CSC_KEY_PASSWORD`. The signed configuration enables hardened runtime; electron-builder signs, notarizes, and staples the application. The verifier separately submits the signed disk image for notarization and staples it, then mounts that image read-only to inspect the application it actually contains. See [electron-builder's notarization documentation](https://www.electron.build/v26/docs/notarization/) for the underlying authentication flow.

The first real candidate run must establish that Apple accepts both architectures, that the notarization ticket is available, and that Gatekeeper accepts the packaged application. A successful build alone is not sufficient.

## Windows: choose one signing provider

Set `WINDOWS_SIGNING_PROVIDER` to `azure` or `certificate`. For either provider, set the variable `WINDOWS_PUBLISHER_NAME` to the certificate's exact common name (CN). This is the verified legal publisher identity, which may differ from the product name `Zelos`.

### Azure Artifact Signing

Microsoft now calls this service **Artifact Signing**, formerly Trusted Signing. Follow the [Microsoft setup guide](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart) to create the signing account, complete identity validation, and create a **Public Trust** certificate profile. Check current regional and identity eligibility before starting setup. Private Trust and Public Trust Test profiles are not suitable for these public downloads.

Create a dedicated [Microsoft Entra application and service principal](https://learn.microsoft.com/en-us/entra/identity-platform/howto-create-service-principal-portal). Grant it the **Artifact Signing Certificate Profile Signer** role scoped to the release certificate profile. Owner or Contributor alone does not grant signing permission; see [Microsoft's signing roles](https://learn.microsoft.com/en-us/azure/artifact-signing/concept-resources-roles).

| Setting | Type | Value |
| --- | --- | --- |
| `WINDOWS_SIGNING_PROVIDER` | Variable | `azure` |
| `WINDOWS_PUBLISHER_NAME` | Variable | Exact verified certificate CN from the profile |
| `AZURE_SIGNING_ENDPOINT` | Variable | Regional signing endpoint shown for the account |
| `AZURE_SIGNING_ACCOUNT` | Variable | Signing account name |
| `AZURE_CERTIFICATE_PROFILE` | Variable | Public Trust certificate profile name |
| `AZURE_TENANT_ID` | Variable | Microsoft Entra tenant ID |
| `AZURE_CLIENT_ID` | Variable | Dedicated application's client ID |
| `AZURE_CLIENT_SECRET` | Secret | Client secret **value**, not its identifier |

This workflow uses client-secret authentication. It does not currently configure GitHub OIDC federation. Record the secret's expiry and replace it before expiry. Signing runs inside electron-builder so the application, embedded uninstaller, and final installer are signed during packaging.

### Existing certificate bundle

Use a valid, publicly trusted code-signing certificate and its private key in a password-protected `.pfx` or `.p12`, only where the issuer permits that use in CI. A self-signed development certificate will not pass the release trust check.

| Setting | Type | Value |
| --- | --- | --- |
| `WINDOWS_SIGNING_PROVIDER` | Variable | `certificate` |
| `WINDOWS_PUBLISHER_NAME` | Variable | Exact certificate CN |
| `WIN_CSC_LINK` | Secret | Base64-encoded certificate/private-key bundle |
| `WIN_CSC_KEY_PASSWORD` | Secret | Bundle password |

## Validate a candidate before publishing

1. Commit the reviewed release changes with matching root and desktop package versions. Run the release workflow manually for that commit before creating its release tag.
2. Require every signing, test, and startup job to pass. macOS builds run on the corresponding Intel and Apple Silicon runners. Windows ARM64 is built and signed on x64, then checked on a native ARM64 runner; cross-building alone does not establish that it runs on ARM64.
3. Inspect the final candidate artifacts: `zelos-signed-macos-x64`, `zelos-signed-macos-arm64`, `zelos-signed-windows-x64`, and `zelos-signed-windows-arm64`. They contain the installation/update packages and their `.signature.json` receipts. The intermediate `candidate-windows-*` artifacts have not yet passed native verification. The macOS gate verifies the disk image and the app inside both the disk image and update ZIP: signatures, expected publisher/team, secure timestamps, app hardened runtime, stapled notarization tickets, and Gatekeeper acceptance. Windows installs silently into an isolated directory before checking the final installer and installed payload, including the actual NSIS uninstaller and native `.exe`, `.dll`, and `.node` files, for valid embedded Authenticode signatures, the expected publisher, and valid timestamps. Windows SignTool warnings fail the check.
4. Download and install both Mac and both Windows candidates on appropriate clean machines. Confirm the displayed publisher, first launch, normal startup, and uninstall behavior. Do not disable Gatekeeper or SmartScreen to count an unsigned candidate as a signed-release success.
5. After the first complete signing run and candidate review succeed, create the matching `v<version>` tag. The tag workflow rebuilds, verifies, and publishes; a manual candidate run does not publish by itself. Keep the old public release available if any required gate fails.

The automated startup check exercises the installed or mounted native Electron executable in Node mode, including the bundled core, local server, and backup workers. It does not open the normal desktop window or exercise renderer/GPU helpers. The clean-machine launch in step 4 remains necessary to validate the full signed GUI and first-download experience.

The release preparation and publication scripts require seven packages: two Mac disk images, two Mac update ZIPs, two Windows installers, and the matching source archive. They recompute package hashes and match signature receipts to the version, full source commit, platform, architecture, and artifact digest. A receipt records native verification results; the operating system's embedded signatures and Apple's notarization are the actual trust mechanisms. The source archive has a checksum and does not claim OS signing.

## Signed update feeds and the first upgrade

Only signed release builds contain the native update configuration. The release publishes separate feeds for each platform and architecture: `latest-arm64-mac.yml`, `latest-x64-mac.yml`, `latest-arm64.yml`, and `latest-x64.yml`. Mac feeds select the verified ZIP application; Windows feeds select the verified NSIS installer. Release checks bind each feed to the exact package bytes using SHA-512 before publication. Keep the expected publisher identity consistent across releases so clients can verify replacements.

Existing unsigned 1.8.1 installations and unsigned previews cannot bootstrap this updater automatically. Users must download and install the first signed release once. After that, an installed signed Mac or Windows app checks after 45 seconds and every six hours by default. Users can turn off **Settings → About → Updates → Check for updates automatically**. Downloads and installation remain separate user actions; see [Updating from an earlier version](INSTALL.md#updating-from-an-earlier-version).

The native updater stays disabled for launches using `--home`, `--port`, `ZELOS_HOME`, or `ZELOS_PORT`, preserving those custom startup settings through a manual upgrade. Mac apps must be installed in Applications and reopened there. Include these manual fallback cases in release QA; they must not schedule background checks or invoke the native installer.

Before announcing automatic-update support, verify an upgrade between two distinct signed versions on each supported platform and architecture, including draft saving, the recovery backup, restart, and the retained data. A passing first-install test does not establish that replacing an existing installation works.

Signing does not guarantee an immediate absence of Windows prompts. A new, correctly signed download can still lack SmartScreen reputation; Microsoft says reputation develops over time and does not promise a threshold. See [SmartScreen guidance for app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

Documentation and provider requirements checked September 17, 2026. Credentials, successful notarization, and real signed installation checks remain necessary before announcing signed downloads.
