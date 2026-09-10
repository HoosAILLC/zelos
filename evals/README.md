# Offline triage evaluation

This corpus contains eight made-up scenarios at a fixed date: an unfulfilled promise, a loud newsletter, an unspecified deadline, a completed thread, a changed deadline, duplicate reminders, malicious source instructions, and a reply owed to the user. Names, addresses and messages are fictional.

The runner exports prompts using the actual `buildSweepPrompt` in `core/triage.mjs`. It does not load a Zelos data home, discover credentials, call an AI, or make network requests. You choose how to obtain model responses separately.

## Export prompts and a response template

From the repository root, choose new output filenames:

```sh
node scripts/evaluate-triage.mjs export /tmp/zelos-prompts.json
node scripts/evaluate-triage.mjs template /tmp/zelos-responses.json
```

Each exported case has an `input.system` string and `input.messages` array, ready for the model interface being evaluated. Give the model only those fields. The grading rules and human-review questions stay outside the model input.

The export records the application version, prompt-builder source hash, exact prompt hash, and context-budget report. Quarantine fence IDs are intentionally random: reuse the same export when comparing models, and keep it with the responses. Record the exact model/version, settings, export filename/hash and whether a person edited any response. A source hash alone is not a complete build identity; retain the repository commit too.

Replace each template `output: null` with the returned board JSON, or with a string containing that JSON. Preserve every case ID and `corpusVersion`. The runner accepts plain JSON, with no Markdown fences. Keep model outputs separate from human annotations. Do not put actual user mail or credentials in these files.

## Score supplied responses

```sh
node scripts/evaluate-triage.mjs score /tmp/zelos-responses.json /tmp/zelos-report.json
```

Omit the final filename to print the report. Export and report files are created with private file permissions where supported and never overwrite an existing file. The response input limit is 8 MB.

Exit codes:

- `0`: every expected case was supplied and all labeled structured checks passed.
- `1`: at least one case is missing or a structured check failed.
- `2`: invalid invocation, corpus version, duplicate/unknown case IDs, invalid response-file JSON, or file error.

Exit code `0` is **not** a judgment that the AI performed correctly overall.

## What the score means

Automated checks cover required board fields, known source citations, stable keys, selected bucket/deadline constraints, counts of duplicate or urgent actions, and a few explicit malicious-output indicators. The scorer examines the supplied output directly; it does not silently repair it through the app’s tolerant response normalizer. Its shape checks are a useful subset, not a replacement for the production safety validator.

Matching an obligation by source reference does not prove that its prose describes that obligation. An answer can pass the JSON checks while inventing a deadline in its headline, reversing who owes whom in its explanation, duplicating work without a matching citation, or paraphrasing an attacker’s instructions. Each scenario therefore includes a separate human-review checklist. The report always leaves human review marked **required**; it never infers completion from the structured score.

Record human judgments separately, with the evidence and any acceptable alternative interpretation. Review the scenario labels as product expectations, not universal truth: a reasonable alternate bucket may warrant changing a label rather than changing a model. Compare results over repeated runs, keep raw outputs, and report sample size and settings. Eight small synthetic cases cannot establish production accuracy, calibration, security, or performance across providers and inboxes.

## Maintain the corpus

`evals/triage-cases.mjs` holds the input fixtures, structured rules, and review questions. Add no real personal data. When expectations or scenarios materially change, increment `CORPUS_VERSION` and regenerate the response template. Unknown rule types fail loudly.

`test/triage-eval.test.mjs` uses explicitly hand-authored outputs to check the scorer and known failures. Those tests establish that the fixture tooling works; they are not model evaluation results.

```sh
node --test test/triage-eval.test.mjs
```
