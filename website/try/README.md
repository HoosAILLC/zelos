# Current interactive website preview

The website build copies the complete current `ui/` into `/try/`, then overlays only the files in this directory. Do not put application views, styles, icons or libraries here just to take a snapshot: a checked-in UI fork goes stale. The build generates endpoint signatures directly from `ui/lib/api.js`, copies the original recipe catalog and bundled meal photos, and isolates presentation preference keys under `zelos.demo.*`.

The `/demo/` compatibility route now serves the same current preview, including bookmarked hash routes. The public installer is separately pinned by `website/release.json`; the preview uses the package version. Build the website before viewing it; this adapter folder is not a standalone site.

`lib/api.js` is the browser-memory transport. The fictional Quillon Row records in `lib/sample-data.js` reset on reload, with dates rebased on opening. Money review suggestions, evidence checks and Undo use `lib/demo-money.js`. Meal discovery, favorites, sample weeks and selected ingredient lists use `lib/demo-meals.js`; recipes come from the real application catalog, and no model or personal health assessment is performed. The shared groceries appear in Health too. Health also offers a fixed dinner-week example with editable recipes, explicit review, idempotent Save and preference-staleness checks; it is labeled as a prepared example without health assessment.

There are two intentional presentation adapters. `lib/bank-link.js` explains linking without a credential flow. `views/family.js` mounts the current application Family component and adds a fictional-person switch; `lib/demo-family.js` supplies isolated owner, parent and collaborator snapshots. Real Family mutations are unavailable.

`demo.js` adds a measured notice bar, reset, same-origin route bridge and disabled credential/file inputs. Unknown operations fail explicitly. There is no network transport, sending, account linking, upload, purchase, guest invitation or credential creation. The deployed CSP independently blocks connections and form submission on both preview paths.

Run `node --test test/website-preview.test.mjs test/release.test.mjs`. Tests build isolated output directories and cover current UI/asset parity, blocked transports, completion and Undo, Money reconciliation, Family isolation, conversations, exports, and selected meal-to-grocery flows.
