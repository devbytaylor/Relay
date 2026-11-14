// The assessment pipeline version: how Relay turns saved research into an assessment, apart from the
// fit rubric. It covers what reaches the assessor (retrieval and its ordering), which typed evidence
// the server can recognize and how quotes are validated (the observation catalog, hedge and interface
// checks), and how discovery questions are grounded. It does not cover the A/B/C rubric, whose own
// version is FIT_RUBRIC_VERSION in fit-rubric.ts; a pipeline change is not a rubric change and must not
// be recorded as one.
//
// The version is part of an assessment's evidence fingerprint (see lead-assessments.ts). Raising it
// makes every earlier completed assessment, for every prospect, "outdated": each is kept and still
// shown as history, and a new paid run becomes possible for that prospect, but only when a person
// confirms it. Nothing is regenerated automatically.
//
// BASELINE is the pipeline that produced every assessment saved before this mechanism existed. It adds
// nothing to the fingerprint, so those fingerprints are unchanged. Do not raise
// ASSESSMENT_PIPELINE_VERSION casually: raise it in its own reviewed change, only when earlier
// assessments should become eligible for regeneration, and update the activation test with it.
export const BASELINE_ASSESSMENT_PIPELINE_VERSION = 1;
export const ASSESSMENT_PIPELINE_VERSION = 1;

export function requirePipelineVersion(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < BASELINE_ASSESSMENT_PIPELINE_VERSION
  )
    throw new Error("Assessment pipeline version must be an integer of at least 1.");
  return value;
}
