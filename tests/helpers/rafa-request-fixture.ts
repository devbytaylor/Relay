// Exact text saved for Rafa's Auto Repair (https://rafasautorepair.com/) in relay_dev, copied verbatim from the
// stored research chunks. Used as regression fixtures; no provider or database is involved.

export const RAFA_FAQ_REQUEST_CHUNK =
  "I broke down on a road trip. Can you help today?\n\nCall and tell us where you are and what happened. Travellers passing through Santa Fe are a real part of what we do — several reviews describe same-day diagnosis and being back on the road the next morning. We can’t promise a timeline before we see the vehicle, but we’ll tell you honestly and quickly what’s possible.\n\nHow do I get an appointment?\n\nSend a service request through this site or call the shop directly. Tell us the vehicle, what it’s doing, and roughly when you’re free.\n\nRequest service";

export const RAFA_REQUEST_SECTION_CHUNK =
  "## What’s it doing?\n\nNo diagnosis required from you. We’ll call you back to confirm a time, and we’ll tell you what we think before anything is booked.\n\nRather talk to a person?\n\n[(505) 204-4418](tel:+15052044418)\n\nMonday – Friday · call to confirm today’s hours\n\nLeave this empty\n\n1 — What’s going on?\n\nNot sureCheck engine lightScheduled maintenanceBrakesStrange noiseWon’t startOverheatingSecond opinionPre-purchase inspectionSomething else\n\n2 — Your vehicle\n\nYear\n\nMake & model\n\nMileage (optional — helps us tell you what’s due)\n\n3 — How we reach you\n\nName\n\nPhone\n\nBest day or time\n\nAnything else (optional)\n\nRequest Service\n\nWe’ll call to confirm before any work starts. No obligation, no charge for the call.\n\n[Call](tel:+15052044418) [Request Service](https://rafasautorepair.com/#request)";

export const RAFA_CTA_CHUNK =
  "## Tell us what it’s doing. We’ll take it from there.\n\nDiagnosis, scheduled service or a second opinion on somebody else’s estimate. You don’t have to know what’s wrong — that’s the job.\n\n[Request Service](https://rafasautorepair.com/#request) [Call (505) 204-4418](tel:+15052044418)\n\n[Call](tel:+15052044418) [Request Service](https://rafasautorepair.com/#request)";

export const RAFA_ESTIMATE_FAQ_CHUNK =
  "No. It is the single thing our customers write about most. One reviewer was told by other shops that he needed a new motor; the actual repair was six hundred dollars. Another was told by a tire shop that her rotors were bad — they weren’t. We tell you what we find, including when the answer is that nothing needs doing.\n\nWhat does it cost, and how firm is the estimate?\n\nWe diagnose first, then quote, then you decide. Customers write repeatedly that the final bill matched the estimate — which is the number that actually matters. We are not trying to be the lowest price in Santa Fe; we are trying to be the shop where the right work gets done once.\n\nWhat kinds of vehicles do you work on?\n\nDomestic and import cars, pickups, SUVs, vans and older vehicles. Customers have brought us everything from a Subaru and a Corolla to an F-150, a Jeep, an Acura and a Corvette. If you are not sure whether your vehicle is a fit, call and ask — we will tell you honestly.\n\nCan you inspect a used vehicle before I buy it?\n\nYes, and it is one of the best hours you can spend. We look at the vehicle the way we would if it were already yours, and tell you what it will need and roughly when.";

export const RAFA_HEADER_CHUNK =
  "[Call (505) 204-4418](tel:+15052044418)\n\n2877 Trades West Rd, Santa Fe, NM 87507\n\nMonday – Friday · call to confirm today’s hours\n\n![Four service bays at Rafa's Auto Repair in Santa Fe, with vehicles raised on lifts and a technician at work](https://rafasautorepair.com/assets/img/shop-bays.jpg)\n\nIndependent auto repair · Santa Fe, New Mexico";

// The forms-category keyword search over Rafa's 73 saved chunks, best match first (ts_rank_cd, then page and chunk
// order), exactly as the retriever read it. The first eight rows: four of them are the same call to action
// repeated on four pages.
export const RAFA_FORMS_KEYWORD_RANKING = [
  {
    id: "d71cc7a3-73fe-48e0-9e44-df1930892194",
    sourceUrl: "https://rafasautorepair.com/",
    content:
      "No. It is the single thing our customers write about most. One reviewer was told by other shops that he needed a new motor; the actual repair was six hundred dollars. Another was told by a tire shop that her rotors were bad — they weren’t. We tell you what we find, including when the answer is that nothing needs doing.\n\nWhat does it cost, and how firm is the estimate?\n\nWe diagnose first, then quote, then you decide. Customers write repeatedly that the final bill matched the estimate — which is the number that actually matters. We are not trying to be the lowest price in Santa Fe; we are trying to be the shop where the right work gets done once.\n\nWhat kinds of vehicles do you work on?\n\nDomestic and import cars, pickups, SUVs, vans and older vehicles. Customers have brought us everything from a Subaru and a Corolla to an F-150, a Jeep, an Acura and a Corvette. If you are not sure whether your vehicle is a fit, call and ask — we will tell you honestly.\n\nCan you inspect a used vehicle before I buy it?\n\nYes, and it is one of the best hours you can spend. We look at the vehicle the way we would if it were already yours, and tell you what it will need and roughly when.",
  },
  {
    id: "25188b4b-a4e4-4e1e-ab5f-f1c00ebbc24e",
    sourceUrl: "https://rafasautorepair.com/about",
    content:
      "## Tell us what it’s doing. We’ll take it from there.\n\nDiagnosis, scheduled service or a second opinion on somebody else’s estimate. You don’t have to know what’s wrong — that’s the job.\n\n[Request Service](https://rafasautorepair.com/#request) [Call (505) 204-4418](tel:+15052044418)\n\n[Call](tel:+15052044418) [Request Service](https://rafasautorepair.com/#request)",
  },
  {
    id: "51d70549-ca55-41c0-8241-b30fd9e3c57b",
    sourceUrl: "https://rafasautorepair.com/honda-acura-repair-santa-fe",
    content:
      "## Tell us what it’s doing. We’ll take it from there.\n\nDiagnosis, scheduled service or a second opinion on somebody else’s estimate. You don’t have to know what’s wrong — that’s the job.\n\n[Request Service](https://rafasautorepair.com/#request) [Call (505) 204-4418](tel:+15052044418)\n\n[Call](tel:+15052044418) [Request Service](https://rafasautorepair.com/#request)",
  },
  {
    id: "03df5a72-5657-4990-b836-9e941a21e22a",
    sourceUrl: "https://rafasautorepair.com/subaru-repair-santa-fe",
    content:
      "## Tell us what it’s doing. We’ll take it from there.\n\nDiagnosis, scheduled service or a second opinion on somebody else’s estimate. You don’t have to know what’s wrong — that’s the job.\n\n[Request Service](https://rafasautorepair.com/#request) [Call (505) 204-4418](tel:+15052044418)\n\n[Call](tel:+15052044418) [Request Service](https://rafasautorepair.com/#request)",
  },
  {
    id: "a4f2b4c7-57f0-4402-99aa-cf09719b5784",
    sourceUrl: "https://rafasautorepair.com/toyota-repair-santa-fe",
    content:
      "## Tell us what it’s doing. We’ll take it from there.\n\nDiagnosis, scheduled service or a second opinion on somebody else’s estimate. You don’t have to know what’s wrong — that’s the job.\n\n[Request Service](https://rafasautorepair.com/#request) [Call (505) 204-4418](tel:+15052044418)\n\n[Call](tel:+15052044418) [Request Service](https://rafasautorepair.com/#request)",
  },
  {
    id: "2083b262-6b9a-4487-880d-fbde3b468cae",
    sourceUrl: "https://rafasautorepair.com/",
    content:
      "## The right repair. Done correctly. By people you _trust._\n\nA correct diagnosis, a straight recommendation, and work that holds. That is the whole of it.\n\nThere is a difference between a shop that is cheap and a shop that doesn’t charge you for things you didn’t need. We would rather be the second one — and the number our customers keep mentioning is not the price, it’s that the final bill matched the estimate.\n\n> “Honestly I can’t recall the last time a SF mechanic final bill was even ‘proximity’ to the estimate.”\n\n![](https://rafasautorepair.com/assets/img/sierra.jpg)\n\nPassing through",
  },
  {
    id: "7f049fa1-0fa9-48c0-b1f5-4f460f6dcdc9",
    sourceUrl: "https://rafasautorepair.com/",
    content:
      "I broke down on a road trip. Can you help today?\n\nCall and tell us where you are and what happened. Travellers passing through Santa Fe are a real part of what we do — several reviews describe same-day diagnosis and being back on the road the next morning. We can’t promise a timeline before we see the vehicle, but we’ll tell you honestly and quickly what’s possible.\n\nHow do I get an appointment?\n\nSend a service request through this site or call the shop directly. Tell us the vehicle, what it’s doing, and roughly when you’re free.\n\nRequest service",
  },
  {
    id: "1f7b5dcb-6ada-44eb-ba3a-d31e88175ae1",
    sourceUrl: "https://rafasautorepair.com/",
    content:
      "## What’s it doing?\n\nNo diagnosis required from you. We’ll call you back to confirm a time, and we’ll tell you what we think before anything is booked.\n\nRather talk to a person?\n\n[(505) 204-4418](tel:+15052044418)\n\nMonday – Friday · call to confirm today’s hours\n\nLeave this empty\n\n1 — What’s going on?\n\nNot sureCheck engine lightScheduled maintenanceBrakesStrange noiseWon’t startOverheatingSecond opinionPre-purchase inspectionSomething else\n\n2 — Your vehicle\n\nYear\n\nMake & model\n\nMileage (optional — helps us tell you what’s due)\n\n3 — How we reach you\n\nName\n\nPhone\n\nBest day or time\n\nAnything else (optional)\n\nRequest Service\n\nWe’ll call to confirm before any work starts. No obligation, no charge for the call.\n\n[Call](tel:+15052044418) [Request Service](https://rafasautorepair.com/#request)",
  },
];
export const RAFA_FAQ_REQUEST_CHUNK_ID = "7f049fa1-0fa9-48c0-b1f5-4f460f6dcdc9";
