import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  observationStatement,
  observationSupport,
  observationType,
  showsRequestFormFields,
} from "../../src/research/intake-evidence.js";
import { classifyFit } from "../../src/research/fit-rubric.js";
import {
  buildAssessmentResult,
  parseAssessmentDraft,
  type RetrievedSource,
} from "../../src/research/lead-intake-assessment.js";
import { ASSESSMENT_CATEGORY_IDS } from "../../src/research/openai-assessor.js";
import {
  RAFA_CTA_CHUNK,
  RAFA_FAQ_REQUEST_CHUNK,
  RAFA_HEADER_CHUNK,
  RAFA_REQUEST_SECTION_CHUNK,
} from "../helpers/rafa-request-fixture.js";

// Rafa's Auto Repair: the saved research shows a request mechanism that none of the earlier
// observation types could express. These tests use the exact saved excerpts.
const HOME = "https://rafasautorepair.com/";
const ABOUT = "https://rafasautorepair.com/about";
const sources: RetrievedSource[] = [
  {
    id: "S1",
    chunkId: "chunk-request-section",
    sourceUrl: HOME,
    via: "keyword",
    text: RAFA_REQUEST_SECTION_CHUNK,
  },
  {
    id: "S2",
    chunkId: "chunk-faq",
    sourceUrl: HOME,
    via: "keyword",
    text: RAFA_FAQ_REQUEST_CHUNK,
  },
  {
    id: "S3",
    chunkId: "chunk-cta",
    sourceUrl: ABOUT,
    via: "keyword",
    text: RAFA_CTA_CHUNK,
  },
  {
    id: "S4",
    chunkId: "chunk-header",
    sourceUrl: HOME,
    via: "keyword",
    text: RAFA_HEADER_CHUNK,
  },
];

const FAQ_QUOTE =
  "Send a service request through this site or call the shop directly.";
// From the saved request section: the vehicle and contact fields through the submit button.
const FIELDS_QUOTE = RAFA_REQUEST_SECTION_CHUNK.slice(
  RAFA_REQUEST_SECTION_CHUNK.indexOf("Year"),
  RAFA_REQUEST_SECTION_CHUNK.indexOf(
    "We’ll call to confirm before any work starts.",
  ),
).trim();
const MINIMAL_FIELDS_QUOTE =
  "Name\n\nPhone\n\nBest day or time\n\nAnything else (optional)\n\nRequest Service";
const CTA_LINKS =
  "[Request Service](https://rafasautorepair.com/#request) [Call (505) 204-4418](tel:+15052044418)";

const rawDraft = (change: (draft: Record<string, any>) => void = () => {}) => {
  const draft: Record<string, any> = {
    categories: ASSESSMENT_CATEGORY_IDS.map((category) => ({
      category,
      observations: [],
      unknowns: [],
      hypotheses: [],
      discovery_questions: [],
    })),
    primary_opportunity_hypothesis: {
      category: "follow_up",
      observed: "callback_offered",
      unknown: "followup_ownership",
    },
    primary_discovery_question:
      "When a new customer reaches out, how does the request get to the person who follows up with them?",
    preliminary_fit: { signals: [], unknowns: [] },
    top_opportunities: [],
  };
  change(draft);
  return draft;
};
const observe = (
  type: string,
  source: string,
  quote: string,
  pool: RetrievedSource[] = sources,
) => {
  const category = observationType(type)!.category;
  const draft = rawDraft((value) => {
    value.categories
      .find((item: any) => item.category === category)
      .observations.push({ type, citations: [{ source, quote }] });
  });
  const { result, withheld } = buildAssessmentResult(
    parseAssessmentDraft(
      draft,
      pool.map((item) => item.id),
    ),
    pool,
  );
  const accepted = result.categories.flatMap((item) => item.observations);
  return { accepted, unconfirmed: result.unconfirmed, withheld, result };
};

test("the sentence offering a service request through the site is recognized, cited, and worded by the server", () => {
  const { accepted, unconfirmed, withheld } = observe(
    "service_request_offered",
    "S2",
    FAQ_QUOTE,
  );
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0]!.type, "service_request_offered");
  assert.equal(
    accepted[0]!.statement,
    "The website invites visitors to send a service request through the site.",
  );
  assert.deepEqual(accepted[0]!.citations, [
    { sourceId: "S2", sourceUrl: HOME, chunkId: "chunk-faq", quote: FAQ_QUOTE },
  ]);
  assert.deepEqual(unconfirmed, []);
  // Only the placeholder primary hypothesis (callback was not reported here) is withheld.
  assert.equal(withheld, 1);
});

test("the request section's fields and submit button are recognized as a request form", () => {
  for (const quote of [FIELDS_QUOTE, MINIMAL_FIELDS_QUOTE]) {
    const { accepted, unconfirmed } = observe(
      "request_form_fields_shown",
      "S1",
      quote,
    );
    assert.deepEqual(
      accepted.map((item) => item.type),
      ["request_form_fields_shown"],
      quote,
    );
    assert.equal(
      accepted[0]!.statement,
      "The website shows a request form with fields for the visitor's details and a submit button.",
    );
    assert.equal(accepted[0]!.citations[0]!.quote, quote);
    assert.deepEqual(unconfirmed, []);
  }
  // The saved section really contains the fields and the standalone button the quote relies on.
  assert.match(
    FIELDS_QUOTE,
    /Make & model[\s\S]*Name[\s\S]*Phone[\s\S]*Best day or time[\s\S]*\n\nRequest Service$/,
  );
});

test("a call to action, a contact link, or a bare label is not proof of a request mechanism", () => {
  const offered = observationType("service_request_offered")!;
  const fields = observationType("request_form_fields_shown")!;
  const form = observationType("contact_form_offered")!;
  const sample: [string, string, string][] = [
    // [type under test, source, quote] -- all verbatim in the saved excerpts.
    ["service_request_offered", "S1", "Request Service"],
    ["service_request_offered", "S3", CTA_LINKS],
    ["request_form_fields_shown", "S1", "Request Service"],
    ["request_form_fields_shown", "S3", CTA_LINKS],
    ["request_form_fields_shown", "S1", "Name\n\nPhone"],
    ["contact_form_offered", "S1", "Request Service"],
    // The service-request sentence still does not claim a "form", so the form type does not take it.
    ["contact_form_offered", "S2", FAQ_QUOTE],
  ];
  for (const [type, source, quote] of sample) {
    const { accepted, unconfirmed, withheld } = observe(type, source, quote);
    assert.deepEqual(accepted, [], `${type}: ${quote}`);
    assert.deepEqual(unconfirmed, [], `${type}: ${quote}`);
    assert.ok(withheld >= 2, `${type}: ${quote} is withheld and counted`);
  }

  // Direct checks of each pattern's boundaries.
  for (const quote of [
    "Contact our team with a few details.",
    "Get in touch with the shop.",
    "Send a service request by mail.",
    "Send a service request to our office.",
    "Tell us your name and phone number and we will take it from there.",
    "Request service",
    "Online scheduling for new customers.",
  ])
    assert.equal(observationSupport(offered, [quote]), "unsupported", quote);
  for (const quote of [
    "Phone\n\nEmail\n\nAddress\n\nContact Us",
    "Name\n\nPhone\n\nRequest Service",
    "Name\n\nPhone\n\nEmail",
    "Request Service Call (505) 204-4418 Contact Us About Reviews",
    "Please send us your name, phone, email and address, then submit",
    "[Request Service](https://rafasautorepair.com/#request)\n\nName\n\nPhone\n\nEmail",
  ])
    assert.equal(observationSupport(fields, [quote]), "unsupported", quote);
  assert.equal(showsRequestFormFields(MINIMAL_FIELDS_QUOTE), true);
  assert.equal(
    showsRequestFormFields("Name\n\nPhone\n\nEmail\n\nSubmit"),
    true,
  );
  assert.equal(
    showsRequestFormFields("Name\n\nPhone\n\nEmail\n\nSubmit now and save"),
    false,
  );
  assert.equal(observationSupport(form, [FAQ_QUOTE]), "unsupported");
});

test("a hedged offer or hedged form is Unconfirmed, never verified", () => {
  const offered = observationType("service_request_offered")!;
  for (const quote of [
    "Online service requests are coming soon.",
    "Online service requests are temporarily unavailable.",
    "We do not accept online service requests.",
  ])
    assert.equal(observationSupport(offered, [quote]), "ambiguous", quote);

  // The banner above the fields bears on them.
  const banner: RetrievedSource[] = [
    {
      id: "S1",
      chunkId: "c",
      sourceUrl: HOME,
      via: "keyword",
      text: "## Request service\n\nComing soon\n\nName\n\nPhone\n\nEmail\n\nSubmit",
    },
  ];
  const result = observe(
    "request_form_fields_shown",
    "S1",
    "Name\n\nPhone\n\nEmail\n\nSubmit",
    banner,
  );
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(
    result.unconfirmed.map((item) => [item.scope, item.id]),
    [["observation", "request_form_fields_shown"]],
  );
});

test("quote verification is unchanged: an altered or invented quote is withheld for the new types", () => {
  for (const [type, source, quote] of [
    [
      "service_request_offered",
      "S2",
      "Send a service request through this site or call the shop directly, any hour.",
    ],
    [
      "service_request_offered",
      "S2",
      "Send a service request through our website.",
    ],
    [
      "request_form_fields_shown",
      "S1",
      "Name\n\nPhone\n\nEmail\n\nRequest Service",
    ],
    // A real quote from another source is not in the cited one.
    ["service_request_offered", "S4", FAQ_QUOTE],
  ] as const) {
    const { accepted, withheld } = observe(type, source, quote);
    assert.deepEqual(accepted, [], quote);
    assert.ok(withheld >= 2, quote);
  }
});

test("accepting the request evidence adds an observation without changing the rubric or thresholds", () => {
  // Rafa's two saved observations alone grade B (signals unclear); a third verified observation does not
  // create a signal, so the grade logic gives the same answer.
  assert.deepEqual(classifyFit({ verifiedObservations: 2, signalIds: [] }), {
    grade: "B",
    basis: "signals_unclear",
  });
  assert.deepEqual(classifyFit({ verifiedObservations: 3, signalIds: [] }), {
    grade: "B",
    basis: "signals_unclear",
  });
  assert.deepEqual(classifyFit({ verifiedObservations: 1, signalIds: [] }), {
    grade: "Unassessed",
    basis: "insufficient_evidence",
  });

  const draft = rawDraft((value) => {
    const category = (name: string) =>
      value.categories.find((item: any) => item.category === name);
    category("phone_intake").observations.push({
      type: "phone_number_listed",
      citations: [{ source: "S1", quote: "(505) 204-4418" }],
    });
    category("follow_up").observations.push({
      type: "callback_offered",
      citations: [
        { source: "S1", quote: "We’ll call you back to confirm a time" },
      ],
    });
    category("website_forms").observations.push({
      type: "service_request_offered",
      citations: [{ source: "S2", quote: FAQ_QUOTE }],
    });
  });
  const { result, withheld } = buildAssessmentResult(
    parseAssessmentDraft(
      draft,
      sources.map((item) => item.id),
    ),
    sources,
  );
  assert.equal(withheld, 0);
  assert.deepEqual(
    result.categories.flatMap((item) =>
      item.observations.map((observation) => observation.type),
    ),
    ["phone_number_listed", "service_request_offered", "callback_offered"],
  );
  assert.deepEqual(
    [result.fit.grade, result.fit.basis],
    ["B", "signals_unclear"],
  );
  assert.deepEqual(
    observationStatement(observationType("service_request_offered")!, [
      FAQ_QUOTE,
    ]),
    "The website invites visitors to send a service request through the site.",
  );
});
