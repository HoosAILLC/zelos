# Releasing Zelos

1. Bump the version in package.json, desktop/package.json, and both root version fields in desktop/package-lock.json. Update RELEASE-NOTES.md.
2. Run the full suite and `node scripts/build-website.mjs`. Review the built demo. Merge only after the supported operating-system and Node checks pass.
3. Tag that exact commit `v<version>` and push the tag. The desktop workflow runs the suite, builds both Mac and Windows architectures, checks the versions, and publishes a GitHub release only after both builds succeed. The release includes the exact source archive, checksums, and a manifest with the commit.
4. Download the `zelos-website` artifact from that tag's workflow. Publish that directory to the existing Netlify site `zelos-app` (site ID `3d9cce7b-a802-4587-8ae4-51ab51bd8906`). For example: `netlify deploy --site 3d9cce7b-a802-4587-8ae4-51ab51bd8906 --dir <artifact-directory> --no-build --prod`. Use an authenticated Netlify account; never put a token in this repository.
5. Check the live release.json, demo version, and all download redirects. They must name the same tag. Download and inspect at least one packaged app and confirm its version and source commit.

Manual desktop workflow runs preserve installers as workflow artifacts without publishing a release. Tag releases do not automatically publish the website because Netlify credentials are not stored in GitHub. The matching website artifact is retained for deployment and rollback. To roll back the website, restore the previous Netlify deployment; previous GitHub releases remain available. Do not move or reuse a published tag.

Signing and notarisation are not configured. Set up publisher certificates and provider OAuth registrations separately before claiming a warning-free installation or a shared one-click provider sign-in.
