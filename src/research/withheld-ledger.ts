import type { AssessmentCategoryId } from "./intake-evidence.js";

// A diagnostic ledger of model outputs the server withheld, one entry per withheld item. It exists so a
// reviewer can see why `withheld` is what it is. It is stored with the assessment result under
// `diagnostics.withheld`, is never rendered in the ordinary assessment page, and is meant for offline
// auditing or an operator-only view.
//
// It is deliberately not a copy of the model's response, and it keeps Relay's rule that only verified
// content is persisted. Every field is a closed code, a catalog id, a position, a stored chunk id, or a
// short sanitized excerpt (at most EXCERPT_LIMIT characters) of a real quote: text that is verbatim in the
// saved research and was withheld for what it does not show. Model-written text (an invented quote, a
// discovery question, hostile text) is never stored, only the code naming the rule it broke. Nothing here
// is verified evidence: an excerpt is exactly what was NOT accepted.

export const EXCERPT_LIMIT = 80;

// What kind of validation rule rejected the item.
export const WITHHELD_CAUSES = [
  "quote_verification", // the cited quote is missing, not in the stored source, instruction-like, or contradicted
  "duplicate_evidence", // the same claim or the same quote was already used
  "wrong_category", // a claim or hypothesis filed under a category it does not belong to
  "unsupported_claim", // the quote does not show the exact typed claim
  "evidence_not_accepted", // a hypothesis cited evidence the server did not accept
  "unsupported_premise", // a question names a website feature no accepted observation shows
  "text_standard", // model-written text broke the discovery-question or text standard
] as const;
export type WithheldCause = (typeof WITHHELD_CAUSES)[number];

// Every reason, and the cause it belongs to. A reason names the exact check that failed.
export const WITHHELD_REASON_CAUSE = {
  observation_wrong_category: "wrong_category",
  no_citations: "quote_verification",
  instruction_like_quote: "quote_verification",
  quote_not_verbatim: "quote_verification",
  phone_number_contradicted: "quote_verification",
  claim_not_shown_by_quote: "unsupported_claim",
  duplicate_observation_type: "duplicate_evidence",
  signal_quote_shared: "duplicate_evidence",
  hypothesis_evidence_not_accepted: "evidence_not_accepted",
  hypothesis_evidence_wrong_category: "wrong_category",
  question_unsupported_premise: "unsupported_premise",
  question_length: "text_standard",
  question_not_one_question: "text_standard",
  question_not_a_process_question: "text_standard",
  question_leads_with_technology: "text_standard",
  question_accusatory: "text_standard",
  question_contains_figure: "text_standard",
  question_instruction_like: "text_standard",
  question_markup_or_link: "text_standard",
  question_internal_id: "text_standard",
} as const satisfies Record<string, WithheldCause>;
export type WithheldReason = keyof typeof WITHHELD_REASON_CAUSE;
export const WITHHELD_REASONS = Object.keys(WITHHELD_REASON_CAUSE) as WithheldReason[];

// Where in the model's draft the item was.
export type WithheldField =
  | "observations"
  | "fit_signals"
  | "category_hypotheses"
  | "primary_hypothesis"
  | "top_opportunities"
  | "category_questions"
  | "primary_question";

// What became of the evidence a rejected hypothesis cited.
export type EvidenceStatus =
  | "rejected" // the model reported it, and the server withheld it (see the earlier entry)
  | "unconfirmed" // the model reported it, and it is shown as Unconfirmed, which supports nothing
  | "accepted_in_other_category" // accepted, but under a different category than the hypothesis
  | "not_reported"; // the model never reported that evidence

export type WithheldEntry = {
  field: WithheldField;
  // The category the model filed the item under, where it has one.
  category?: AssessmentCategoryId;
  // Position within that list in the model's draft, zero-based.
  index: number;
  // The observation type, signal id, or cited evidence id. Never free text.
  claim?: string;
  reason: WithheldReason;
  cause: WithheldCause;
  // The retrieved sources the item cited: the assessment's source id and the stored chunk id.
  sources?: { sourceId: string; chunkId: string }[];
  // The catalog unknown id a hypothesis was paired with.
  unknown?: string;
  evidenceStatus?: EvidenceStatus;
  // The website feature a question presupposed.
  feature?: string;
  // The primary question was replaced by the server's channel-neutral wording.
  replacedByNeutral?: true;
  // A sanitized, truncated excerpt of a withheld quote that is verbatim in the saved research, for
  // recognition only. Never model-written text.
  excerpt?: string;
};

export type WithheldInput = Omit<WithheldEntry, "cause" | "excerpt"> & { excerpt?: string };

// An excerpt is kept only for rejections of a quote that is verbatim in the saved research. For every
// other reason (no quote, a quote not in the source, instruction-like text, any question) the text is
// model-written or hostile, so only the code is recorded.
const EXCERPT_REASONS: ReadonlySet<WithheldReason> = new Set([
  "observation_wrong_category",
  "phone_number_contradicted",
  "claim_not_shown_by_quote",
  "duplicate_observation_type",
  "signal_quote_shared",
]);

// One short, safe line of a withheld real quote. Control and format characters are removed, links
// and e-mail addresses are redacted, angle brackets are dropped, whitespace is collapsed, and the length
// is capped. It is for recognition, never for display as evidence.
export function ledgerExcerpt(value: string): string {
  const clean = value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    .replace(/(?:https?:\/\/|www\.)\S+/gi, "[link]")
    .replace(/\b(?:tel|sms|mailto|javascript|data):\S*/gi, "[link]")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > EXCERPT_LIMIT ? `${clean.slice(0, EXCERPT_LIMIT - 1).trimEnd()}…` : clean;
}

// Builds the stored entry: the cause comes from the reason, the excerpt is sanitized, and unset fields are
// absent rather than undefined.
export function withheldEntry(input: WithheldInput): WithheldEntry {
  const entry: WithheldEntry = {
    field: input.field,
    index: input.index,
    reason: input.reason,
    cause: WITHHELD_REASON_CAUSE[input.reason],
  };
  if (input.category !== undefined) entry.category = input.category;
  if (input.claim !== undefined) entry.claim = input.claim;
  if (input.sources?.length) entry.sources = input.sources;
  if (input.unknown !== undefined) entry.unknown = input.unknown;
  if (input.evidenceStatus !== undefined) entry.evidenceStatus = input.evidenceStatus;
  if (input.feature !== undefined) entry.feature = input.feature;
  if (input.replacedByNeutral) entry.replacedByNeutral = true;
  if (input.excerpt && EXCERPT_REASONS.has(input.reason)) {
    const excerpt = ledgerExcerpt(input.excerpt);
    if (excerpt) entry.excerpt = excerpt;
  }
  return entry;
}

type WithDiagnostics = { withheld?: unknown; diagnostics?: { withheld?: unknown } | undefined } | null | undefined;

// The stored ledger, or null for an assessment saved before the ledger existed.
export function storedLedger(result: unknown): WithheldEntry[] | null {
  const ledger = (result as WithDiagnostics)?.diagnostics?.withheld;
  return Array.isArray(ledger) ? (ledger as WithheldEntry[]) : null;
}

// The recorded withheld count must equal the ledger's size. An assessment without a ledger (saved earlier)
// is not checked, and nothing is inferred about it.
export function assertLedgerMatchesCount(result: unknown, withheldCount: number): void {
  const diagnostics = (result as WithDiagnostics)?.diagnostics;
  if (diagnostics === undefined) return;
  const ledger = diagnostics?.withheld;
  if (!Array.isArray(ledger) || ledger.length !== withheldCount || (result as { withheld?: unknown }).withheld !== withheldCount)
    throw new Error("Assessment withheld count does not match its rejection ledger.");
}

// A grouped, line-per-entry view for an operator reading a saved assessment offline.
export function summarizeWithheldLedger(result: unknown): {
  recorded: boolean;
  total: number;
  byCause: Record<string, number>;
  byReason: Record<string, number>;
  lines: string[];
} {
  const ledger = storedLedger(result);
  const total = ledger?.length ?? Number((result as { withheld?: unknown })?.withheld ?? 0);
  if (!ledger) return { recorded: false, total, byCause: {}, byReason: {}, lines: [] };
  const byCause: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  for (const entry of ledger) {
    byCause[entry.cause] = (byCause[entry.cause] ?? 0) + 1;
    byReason[entry.reason] = (byReason[entry.reason] ?? 0) + 1;
  }
  const lines = ledger.map((entry) =>
    [
      `${entry.field}${entry.category ? `[${entry.category}]` : ""}#${entry.index}`,
      entry.claim ? `claim=${entry.claim}` : "",
      `reason=${entry.reason}`,
      `cause=${entry.cause}`,
      entry.evidenceStatus ? `evidence=${entry.evidenceStatus}` : "",
      entry.unknown ? `unknown=${entry.unknown}` : "",
      entry.feature ? `feature=${entry.feature}` : "",
      entry.sources?.length ? `chunks=${entry.sources.map((item) => item.chunkId).join(",")}` : "",
      entry.replacedByNeutral ? "replaced=neutral" : "",
      entry.excerpt ? `excerpt=${JSON.stringify(entry.excerpt)}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
  return { recorded: true, total, byCause, byReason, lines };
}
