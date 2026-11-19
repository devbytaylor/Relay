import { formatResponseReview, parseResponseReviewArgs } from "../src/outreach/response-review.js";

async function main() {
  const identity = parseResponseReviewArgs(process.argv.slice(2));
  const { db } = await import("../src/db.js");
  try {
    const { getResponseReview } = await import("../src/outreach/response-review.js");
    console.log(formatResponseReview(await getResponseReview(db, identity)));
  } finally {
    await db.end();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Response review failed.");
  process.exitCode = 1;
});
