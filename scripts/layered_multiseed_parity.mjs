import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import playwright from "../frontend/node_modules/@playwright/test/index.js";

const baseUrl = process.env.DEMO_URL ?? "http://127.0.0.1:4175";
const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
const fixture = JSON.parse(await readFile(new URL("./fixtures/layered_multiseed_python_golden.json", import.meta.url), "utf8"));
const { chromium } = playwright;
const result = { baseUrl, cases: [], failure: null };
let browser;

try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage();
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const actual = await page.evaluate(async (golden) => {
    const algorithm = await import("/src/portfolio/layeredDiscovery.ts");
    const topic = { entities: golden.entities, relations: golden.relations, evidence: [], metadata: {} };
    return golden.cases.map((testCase) => {
      const input = testCase.input;
      const output = algorithm.discoverLayered(topic, input.seed_vids[0], input.seed_vids, {
        entityTypes: new Set(input.allowed_entity_types ?? []), relationCategories: new Set(), relations: new Set(input.allowed_relation_types ?? []),
      }, input.hop, input.max_nodes, input.max_edges);
      return {
        name: testCase.name,
        nodes: output.nodeIds.map((id) => {
          const item = output.nodeMeta.get(id);
          return { id, layer: item.layer, priority_score: item.priorityScore, min_seed_distance: item.minSeedDistance, bridge_seed_count: item.supportSeeds.length, local_anchor_seed: item.localAnchorSeed, matched_seed_pairs: item.matchedSeedPairs, seed_support_vids: item.supportSeeds, score_breakdown: item.scoreBreakdown };
        }),
        edges: output.edgeIds.map((id) => output.edgeMeta.get(id)).map((edge) => ({ source: edge.source, target: edge.target, rank: edge.rank, layer: edge.layer, priority_score: edge.priority_score, seed_support_vids: edge.seed_support_vids, path_pair: edge.path_pair, is_backbone: edge.is_backbone })),
        dropped: output.dropped.map((item) => ({ node_id: item.id, reason: item.reason })),
      };
    });
  }, fixture);
  for (const expected of fixture.cases) {
    const received = actual.find((item) => item.name === expected.name);
    assert.ok(received, `missing case ${expected.name}`);
    // Python deliberately leaves seed score_breakdown empty; the UI keeps a
    // zero-valued structural breakdown for safe rendering, so normalize that
    // representational difference before comparing algorithm outputs.
    for (const node of received.nodes) if (node.priority_score === 100000) node.score_breakdown = {};
    assert.deepEqual(received.nodes, expected.nodes, `${expected.name}: node parity`);
    const byStableJson = (left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right));
    assert.deepEqual([...received.edges].sort(byStableJson), [...expected.edges].sort(byStableJson), `${expected.name}: edge parity`);
    assert.deepEqual([...received.dropped].sort(byStableJson), [...expected.dropped].sort(byStableJson), `${expected.name}: dropped parity`);
    result.cases.push({ name: expected.name, pass: true, nodes: received.nodes.length, edges: received.edges.length });
  }
} catch (error) {
  result.failure = String(error);
} finally {
  await browser?.close();
}
await writeFile("/tmp/kg-layered-multiseed-parity.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (result.failure) process.exitCode = 1;
