# Local development dashboard

From the Relay repository root, run these commands in separate terminals:

```sh
npm run dev:init
npm run dev
```

Open http://127.0.0.1:4310/. The server shows its URL at startup and reloads when imported TypeScript source files change. Press Ctrl+C to stop the server. The `relay_dev` Docker database and its volume persist.

`dev:init` is an explicit, one-time copy of the existing `relay-ask-demo` database into a dedicated local `relay_dev` container. It copies saved research and vectors, then applies only migrations 016 and 017 if absent from the copy. It checks the source container label, target container and volume identity, loopback port, and database identity. If the target already exists, it preserves all data and checks its schema. An interrupted or incomplete import requires inspection; it is never automatically reset. Use `npm run dev:status` to see the dev database URL and vector count.

Starting the dashboard makes no Firecrawl, embedding, Ask Relay, or assessment generation calls. The visible Research, Ask Relay, and Generate Assessment actions can call paid providers when you submit them. The copied demo database has no saved lead assessment, so the assessment panel initially offers generation. It does not display the separate stored v5 trial assessment or the later offline replay as a persisted result. A newly generated assessment will be stored only in `relay_dev`.

The existing `scripts/ask-relay-demo.sh` commands continue to use `relay_demo` independently. Neither the dev startup nor initialization deletes or resets that database.

## When a saved assessment becomes outdated

An assessment records an evidence fingerprint: a hash of the fit rubric version (`FIT_RUBRIC_VERSION`), the research request, its documents and chunks, and, once it is raised above the baseline, the assessment pipeline version (`ASSESSMENT_PIPELINE_VERSION` in `src/research/assessment-pipeline.ts`). The pipeline version covers how evidence is retrieved and ordered, which typed evidence is recognized and how quotes are validated, and how discovery questions are grounded. It is separate from the rubric, so a pipeline change is never recorded as a rubric change.

An assessment is Outdated when its fingerprint no longer matches the current one. Outdated is computed when the page is read; no row is written. An outdated assessment stays visible with an Outdated notice and in the history list, and the page offers Regenerate Assessment. Regenerating still needs the explicit confirmation and makes one paid OpenAI request. Nothing regenerates automatically.

Pipeline version 1 is the baseline and adds nothing to the fingerprint, so assessments saved before the version existed remain current. Raising it affects every completed assessment for every prospect in a database at once (for example both the Sadowski and Rafa assessments in `relay_dev`), so raise it only in its own reviewed change, when earlier assessments should become eligible for regeneration. Regenerating one prospect leaves the others outdated until each is regenerated or left as history.

## Why a model output was withheld (rejection ledger)

Each new assessment stores a rejection ledger at `result.diagnostics.withheld`: one entry for every model output the server withheld, so `withheld_count`, `result.withheld`, and the ledger's length are always the same number. The assessment page never shows it; it is for offline auditing. Assessments saved before the ledger existed have no `diagnostics`, and nothing is inferred for them (their reasons were not recorded and cannot be recovered).

An entry holds only closed codes and ids, never the model's response: `field` and `category` (where the model put it), `index`, `claim` (an observation type, signal, or cited evidence id), `reason` and its `cause`, the cited `sources` (assessment source id and stored chunk id), and for a rejected hypothesis the `unknown` it was paired with and the `evidenceStatus` of what it cited (`rejected`, `unconfirmed`, `accepted_in_other_category`, or `not_reported`). A short sanitized `excerpt` (80 characters at most) is kept only for a quote that is verbatim in the saved research and was withheld for what it does not show. Invented quotes, discovery questions, and instruction-like or link-bearing text are never stored; only the code naming the rule they broke is.

Causes: `quote_verification`, `duplicate_evidence`, `wrong_category`, `unsupported_claim`, `evidence_not_accepted`, `unsupported_premise`, `text_standard`. The full list of reasons is `WITHHELD_REASONS` in `src/research/withheld-ledger.ts`.

The ledger lives inside the existing result JSON and is optional, so the result `schemaVersion` stays 3 and no migration is needed: older rows still validate and render, and code that predates the ledger ignores the extra field. To read one offline against the dev database (read-only):

```sh
docker exec relay-local-dev psql -U relay_dev -d relay_dev -c "SET default_transaction_read_only = on" \
  -At -c "SELECT jsonb_pretty(result->'diagnostics') FROM lead_intake_assessments WHERE id = '<assessment id>'"
```

`summarizeWithheldLedger(result)` in the same module groups a saved result's ledger by cause and reason and prints one line per entry.
