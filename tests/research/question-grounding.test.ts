import { strict as assert } from "node:assert";
import { test } from "node:test";
import { discoveryQuestionProblem } from "../../src/research/fit-rubric.js";
import {
  CHANNEL_NEUTRAL_PRIMARY_QUESTION,
  QUESTION_FEATURES,
  ungroundedQuestionFeature,
} from "../../src/research/intake-evidence.js";
import {
  buildAssessmentResult,
  parseAssessmentDraft,
  type RetrievedSource,
} from "../../src/research/lead-intake-assessment.js";
import { ASSESSMENT_CATEGORY_IDS } from "../../src/research/openai-assessor.js";
import { RAFA_FAQ_REQUEST_CHUNK, RAFA_REQUEST_SECTION_CHUNK } from "../helpers/rafa-request-fixture.js";

const accepted = (...types: string[]) => new Set(types);
const FORM = "a website form or online request";

// Rafa's saved questions, verbatim from the stored assessment.
const RAFA_FORM_QUESTION = "When someone sends a service request through the website, what happens next and who handles it?";
const RAFA_PHONE_QUESTION = "When someone calls about a breakdown or another urgent issue, what happens to the request and how does it reach the person who can help?";
const RAFA_FOLLOW_UP_QUESTION = "After you tell someone you’ll call back to confirm a time, how is that callback handled and tracked?";

test("a question that names a website feature needs accepted evidence of that feature", () => {
  // Rafa's saved question presupposes a website request, and the saved assessment accepted none.
  assert.equal(ungroundedQuestionFeature(RAFA_FORM_QUESTION, accepted("phone_number_listed", "callback_offered")), FORM);
  for (const question of [
    "When someone uses the web form instead of calling, what happens from there?",
    "When a customer submits the request form, what happens next, and how do you decide who handles it?",
    "Who sees a quote request that comes in through the website?",
    "What happens to an online service request after it is sent?",
    "When someone fills out the contact form, who is the first to see it?",
  ])
    assert.equal(ungroundedQuestionFeature(question, accepted("phone_number_listed")), FORM, question);

  // Any accepted observation that shows a request mechanism grounds it.
  for (const type of ["contact_form_offered", "service_request_offered", "request_form_fields_shown", "form_urgency_selector_offered"])
    assert.equal(ungroundedQuestionFeature(RAFA_FORM_QUESTION, accepted(type)), null, type);
  // A quote offer does not show a form or an online request.
  assert.equal(ungroundedQuestionFeature(RAFA_FORM_QUESTION, accepted("quote_request_offered")), FORM);

  assert.equal(ungroundedQuestionFeature("How do customers book online, and who confirms the visit?", accepted("callback_offered")), "online booking");
  assert.equal(ungroundedQuestionFeature("How do customers book online, and who confirms the visit?", accepted("online_booking_offered")), null);
  assert.equal(ungroundedQuestionFeature("Who answers questions that come in through the customer portal?", accepted()), "a customer portal");
  assert.equal(ungroundedQuestionFeature("Who answers questions that come in through the customer portal?", accepted("customer_portal_offered")), null);
  assert.equal(ungroundedQuestionFeature("What happens after a customer pays online?", accepted("phone_number_listed")), "online payment");
  assert.equal(ungroundedQuestionFeature("What happens after a customer pays online?", accepted("online_payment_offered")), null);
});

test("channel-neutral questions, and questions about calls and callbacks, are never gated", () => {
  for (const question of [
    CHANNEL_NEUTRAL_PRIMARY_QUESTION,
    "When a new customer reaches out, what happens from there?",
    RAFA_PHONE_QUESTION,
    RAFA_FOLLOW_UP_QUESTION,
    "When a customer calls, who usually takes the initial details and determines the next step?",
    "How do you handle an emergency request that comes in outside office hours?",
    "Who owns the follow-up if someone does not book on the first contact?",
    "What CRM or software do you use to track requests?",
  ])
    assert.equal(ungroundedQuestionFeature(question, accepted()), null, question);
  // Every gated feature has at least one evidence type, and every neutral question above passes the style standard.
  for (const item of QUESTION_FEATURES) assert.ok(item.shownBy.length > 0, item.feature);
  assert.equal(discoveryQuestionProblem(CHANNEL_NEUTRAL_PRIMARY_QUESTION, "primary"), null);
  assert.equal(discoveryQuestionProblem(RAFA_FORM_QUESTION, "primary"), null);
});

const HOME = "https://rafasautorepair.com/";
const sources: RetrievedSource[] = [
  { id: "S1", chunkId: "chunk-section", sourceUrl: HOME, via: "keyword", text: RAFA_REQUEST_SECTION_CHUNK },
  { id: "S2", chunkId: "chunk-faq", sourceUrl: HOME, via: "keyword", text: RAFA_FAQ_REQUEST_CHUNK },
];
const FAQ_QUOTE = "Send a service request through this site or call the shop directly.";
// Rafa's saved draft in the typed shape: two accepted observations, and the saved questions.
const rafaDraft = (withRequestEvidence: boolean) => {
  const draft: Record<string, any> = {
    categories: ASSESSMENT_CATEGORY_IDS.map((category) => ({ category, observations: [], unknowns: [], hypotheses: [], discovery_questions: [] })),
    primary_opportunity_hypothesis: { category: "follow_up", observed: "callback_offered", unknown: "followup_ownership" },
    primary_discovery_question: RAFA_FORM_QUESTION,
    preliminary_fit: { signals: [], unknowns: [] },
    top_opportunities: [{ category: "follow_up", observed: "callback_offered", unknown: "followup_ownership" }],
  };
  const category = (name: string) => draft.categories.find((item: any) => item.category === name);
  category("phone_intake").observations.push({ type: "phone_number_listed", citations: [{ source: "S1", quote: "(505) 204-4418" }] });
  category("phone_intake").discovery_questions.push(RAFA_PHONE_QUESTION);
  category("follow_up").observations.push({ type: "callback_offered", citations: [{ source: "S1", quote: "We’ll call you back to confirm a time" }] });
  category("follow_up").discovery_questions.push(RAFA_FOLLOW_UP_QUESTION);
  category("website_forms").discovery_questions.push(RAFA_FORM_QUESTION);
  if (withRequestEvidence)
    category("website_forms").observations.push({ type: "service_request_offered", citations: [{ source: "S2", quote: FAQ_QUOTE }] });
  return draft;
};
const build = (draft: Record<string, any>) => buildAssessmentResult(parseAssessmentDraft(draft, ["S1", "S2"]), sources);
const questionsOf = (result: ReturnType<typeof build>["result"], category: string) =>
  result.categories.find((item) => item.category === category)!.discoveryQuestions;

test("without accepted request evidence, Rafa's form question is not asked and the primary becomes channel-neutral", () => {
  const { result, withheld } = build(rafaDraft(false));
  // The primary question is replaced by the server's channel-neutral wording, and the category question is dropped.
  assert.equal(result.primaryDiscoveryQuestion, CHANNEL_NEUTRAL_PRIMARY_QUESTION);
  assert.deepEqual(questionsOf(result, "website_forms"), []);
  // Questions about calls and callbacks name no website feature and are kept.
  assert.deepEqual(questionsOf(result, "phone_intake"), [RAFA_PHONE_QUESTION]);
  assert.deepEqual(questionsOf(result, "follow_up"), [RAFA_FOLLOW_UP_QUESTION]);
  // Both replaced or dropped questions are counted as withheld; the accepted evidence is untouched.
  assert.equal(withheld, 2);
  assert.equal(result.withheld, 2);
  assert.deepEqual(result.categories.flatMap((item) => item.observations.map((observation) => observation.type)), ["phone_number_listed", "callback_offered"]);
  assert.deepEqual(result.topOpportunities.map((item) => item.title), ["Who owns follow-up"]);
  assert.deepEqual([result.fit.grade, result.fit.basis], ["B", "signals_unclear"]);
  assert.doesNotMatch(JSON.stringify(result), /through the website/);
});

test("with accepted request evidence, Rafa's form question is kept exactly as asked", () => {
  const { result, withheld } = build(rafaDraft(true));
  assert.equal(result.primaryDiscoveryQuestion, RAFA_FORM_QUESTION);
  assert.deepEqual(questionsOf(result, "website_forms"), [RAFA_FORM_QUESTION]);
  assert.equal(withheld, 0);
  assert.ok(result.categories.flatMap((item) => item.observations).some((item) => item.type === "service_request_offered"));
});

test("only accepted evidence grounds a question: unconfirmed, rejected, and cross-claim evidence do not", () => {
  // A request-evidence observation whose quote is not in its source is withheld, so it grounds nothing.
  const forged = rafaDraft(true);
  forged.categories.find((item: any) => item.category === "website_forms").observations[0].citations[0].quote = "Send a service request through this site at any hour.";
  const forgedResult = build(forged);
  assert.equal(forgedResult.result.primaryDiscoveryQuestion, CHANNEL_NEUTRAL_PRIMARY_QUESTION);
  assert.deepEqual(questionsOf(forgedResult.result, "website_forms"), []);
  assert.equal(forgedResult.withheld, 3);

  // Hedged evidence is Unconfirmed, which also grounds nothing.
  const hedged = rafaDraft(false);
  const hedgedSources: RetrievedSource[] = [sources[0]!, { ...sources[1]!, text: `Online service requests are coming soon.\n\n${RAFA_FAQ_REQUEST_CHUNK}` }];
  hedged.categories.find((item: any) => item.category === "website_forms").observations.push({ type: "service_request_offered", citations: [{ source: "S2", quote: "Online service requests are coming soon." }] });
  const hedgedResult = buildAssessmentResult(parseAssessmentDraft(hedged, ["S1", "S2"]), hedgedSources);
  assert.equal(hedgedResult.result.unconfirmed.length, 1);
  assert.equal(hedgedResult.result.primaryDiscoveryQuestion, CHANNEL_NEUTRAL_PRIMARY_QUESTION);

  // An accepted fit signal does not ground a form question; only an observation that shows the feature does.
  const signalOnly = rafaDraft(false);
  signalOnly.preliminary_fit.signals.push({ signal: "coordination_or_handoffs", citations: [{ source: "S1", quote: "We\u2019ll call you back to confirm a time" }] });
  const signalResult = build(signalOnly).result;
  assert.deepEqual(signalResult.fit.signals.map((item) => item.id), ["coordination_or_handoffs"]);
  assert.equal(signalResult.primaryDiscoveryQuestion, CHANNEL_NEUTRAL_PRIMARY_QUESTION);
});

test("a question that already fails the discovery standard is withheld as before, not replaced", () => {
  const draft = rafaDraft(true);
  draft.primary_discovery_question = "Are you interested in automation for the website form?";
  const { result, withheld } = build(draft);
  assert.equal(result.primaryDiscoveryQuestion, null);
  assert.equal(withheld, 1);
});
