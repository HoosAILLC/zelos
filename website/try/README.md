# Interactive website preview

This directory contains a snapshot of the Zelos 1.8.4 development interface, with a browser-only transport in `lib/api.js`. The public installer remains 1.8.1; the marketing page explains that distinction. The older release demo under `/demo/` is still built and tested separately.

`lib/endpoints.js` preserves the current app's endpoint signatures. `lib/sample-data.js` contains only the fictional Quillon Row capture workspace. Dates are rebased when a visitor opens the demo. Edits and prepared example answers live in module memory and reset on reload; presentation preferences use demo-specific storage names.

Money uses the current QA view, styles and analysis libraries. `lib/demo-money.js` adds fictional bank snapshots and pending charges, plus source evidence for recurring and duplicate suggestions. Confirm, dismiss, exclude and Undo work in module memory, with stale-evidence checks; no bank is connected. Family uses the current Family styles with a read-only overview of fictional parent and collaborator views. Selected task and meal-plan snapshots come from the existing sample workspace, with no invitation, credential or guest-portal flow.

Other app views are preserved except for demo-specific background-job wording, mail-result deep links, and isolated preference names. `demo.js` adds the notice, reset control, same-origin route bridge, and disables credential/file inputs. Network operations, credentials, sending, purchases, and real model calls are unsupported. The `/try/*` CSP prohibits network connections and form submission.

The marketing page embeds `/try/` and offers a separate-tab link. Tests in `test/website-preview.test.mjs` cover state changes, cross-view records, finance reconciliation and review Undo, Family view isolation, conversations, selected PDF exports, and blocked external operations.
