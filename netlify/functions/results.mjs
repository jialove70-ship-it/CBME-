import { getStore } from "@netlify/blobs";
import { createPollHandlers, STORE_NAME } from "./lib/poll.mjs";

const { results } = createPollHandlers({
  openStore: () => getStore({ name: STORE_NAME, consistency: "strong" }),
});

export default results;
