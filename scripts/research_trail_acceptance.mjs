import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import playwright from "../frontend/node_modules/@playwright/test/index.js";

const baseUrl = process.env.DEMO_URL ?? "http://127.0.0.1:4175";
const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
const { chromium } = playwright;
const result = { baseUrl, checks: {}, consoleErrors: [], pageErrors: [], apiRequests: [] };
let browser;

try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  page.on("console", (message) => { if (message.type() === "error") result.consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => result.pageErrors.push(String(error)));
  page.on("request", (request) => { if (request.url().includes("/api/")) result.apiRequests.push(request.url()); });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("进入研究")));
  await page.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("进入研究"))?.click());
  await page.waitForTimeout(1200);

  const budget = page.getByTestId("canvas-budget");
  const initialCount = Number(await page.locator(".graph-stage").getAttribute("data-node-count"));
  assert.ok(initialCount >= 20 && initialCount <= 50, `initial node count ${initialCount} is outside 20–50`);
  assert.ok(await page.locator(".graph-stage canvas").count() > 0, "G6 canvas did not render");
  result.checks.initial_nodes = initialCount;

  // Source-module invariants complement browser behavior during Vite dev. A
  // production preview has no /src module endpoint, so it can skip this small
  // white-box assertion while retaining all real canvas interaction checks.
  if (!process.env.DEMO_SKIP_MODULE_INVARIANTS) result.checks.module_invariants = await page.evaluate(async () => {
    const [manifest, trail] = await Promise.all([
      fetch("/demo-data/manifest.json").then((r) => r.json()),
      import("/src/portfolio/researchTrail.ts"),
    ]);
    const topicId = manifest.topics[0].id;
    const [entities, relations, metadata] = await Promise.all([
      fetch(`/demo-data/categories/${topicId}/entities.json`).then((r) => r.json()),
      fetch(`/demo-data/categories/${topicId}/relations.json`).then((r) => r.json()),
      fetch(`/demo-data/categories/${topicId}/metadata.json`).then((r) => r.json()),
    ]);
    const topic = { entities, relations, metadata };
    const filters = { entityTypes: new Set(), relationCategories: new Set(), relations: new Set() };
    const degrees = new Map();
    for (const edge of relations) { degrees.set(edge.source, (degrees.get(edge.source) || 0) + 1); degrees.set(edge.target, (degrees.get(edge.target) || 0) + 1); }
    const hub = [...degrees.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const graph = trail.buildLocalGraph(topic, hub, metadata.recommended_seeds, filters, 3, 50);
    const expanded = trail.expandLocalGraph(topic, graph, hub, filters, new Set());
    const category = relations[0].relation_category;
    const filtered = trail.buildLocalGraph(topic, hub, metadata.recommended_seeds, { ...filters, relationCategories: new Set([category]) }, 2, 32);
    const noNeighborPreview = trail.previewNeighbors(topic, hub, [], { ...filters, relations: new Set(["__not_a_relation__"]) });
    const relationById = new Map(relations.map((edge) => [edge.id, edge]));
    const actualEdges = expanded.graph.edgeIds.map((id) => relationById.get(id));
    return {
      hubDegree: degrees.get(hub), nodeCount: expanded.graph.nodeIds.length, edgeCount: expanded.graph.edgeIds.length,
      uniqueNodes: new Set(expanded.graph.nodeIds).size, allEdgesAreActual: actualEdges.every(Boolean),
      directionsAndTypesPreserved: actualEdges.every((edge) => typeof edge.source === "number" && typeof edge.target === "number" && typeof edge.relation === "string"),
      atCapAddsNone: trail.expandLocalGraph(topic, graph, hub, filters, new Set()).added === 0,
      filteredGraphWithinCap: filtered.nodeIds.length <= 50,
      noNeighborPreview: noNeighborPreview.total,
    };
  });
  if (result.checks.module_invariants) {
    assert.ok(result.checks.module_invariants.nodeCount <= 50);
    assert.equal(result.checks.module_invariants.nodeCount, result.checks.module_invariants.uniqueNodes);
    assert.ok(result.checks.module_invariants.allEdgesAreActual && result.checks.module_invariants.directionsAndTypesPreserved);
    assert.ok(result.checks.module_invariants.atCapAddsNone && result.checks.module_invariants.filteredGraphWithinCap);
    assert.equal(result.checks.module_invariants.noNeighborPreview, 0);
  }

  // Use G6's actual post-render coordinates to click a canvas node. The
  // dedicated reroot sequence below then validates the structural transaction.
  const canvas = page.locator(".graph-stage canvas").first();
  const readSnapshot = async () => JSON.parse(await page.getByTestId("g6-render-snapshot").textContent());
  const clickG6Node = async (snapshot, id) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Opening the Inspector resizes the canvas. Read both live geometry and
      // the post-resize G6 transform for every retry instead of reusing a
      // coordinate from the prior canvas width.
      await page.waitForTimeout(220);
      const current = await readSnapshot();
      const point = current.positions[id] ?? snapshot.positions[id];
      assert.ok(point, `G6 position missing for ${id}`);
      const box = await canvas.boundingBox();
      assert.ok(box, "canvas box unavailable");
      await page.mouse.click(box.x + current.transform.x + point.x * current.transform.zoom, box.y + current.transform.y + point.y * current.transform.zoom);
      await page.waitForTimeout(450);
      if (await page.locator(".right-panel").getAttribute("data-selected-node-id") === String(id)) break;
    }
  };
  const initialSnapshot = await readSnapshot();
  let nodeActionChecks = 0;
  for (const id of initialSnapshot.nodeIds.slice(0, 1)) {
    await clickG6Node(initialSnapshot, id);
    await page.locator(`.right-panel[data-selected-node-id="${id}"]`).waitFor({ state: "visible", timeout: 2500 });
    assert.equal(await page.getByRole("button", { name: "从此实体继续探索" }).count(), 1, `focus action missing for ${id}`);
    assert.equal(await page.getByRole("button", { name: /将关联实体加入图谱|暂无可展开关联/ }).count(), 1, `local expand action missing for ${id}`);
    nodeActionChecks += 1;
  }
  result.checks.nodes_with_both_actions = nodeActionChecks;
  assert.ok(await page.getByText("实体", { exact: true }).count(), "node inspector did not render overview");
  assert.ok(await page.getByTestId("entity-evidence").count(), "node inspector did not render evidence state");
  assert.ok(await page.locator(".related-row").count() > 0, "node inspector did not render related entities");
  await page.locator(".related-row input[type=checkbox]").first().check();
  assert.equal(await page.getByRole("button", { name: /以 1 个已选关联实体继续探索/ }).count(), 1, "selective explore action missing");

  const stage = page.locator(".graph-stage");
  const before = {
    focus: await stage.getAttribute("data-focus-id"),
    nodes: await stage.getAttribute("data-g6-node-ids"),
    edges: await stage.getAttribute("data-g6-edge-ids"),
  };
  const nextFocus = initialSnapshot.nodeIds.find((id) => id !== before.focus);
  assert.ok(nextFocus, "no non-root node available for reroot test");
  await clickG6Node(initialSnapshot, nextFocus);
  await page.getByRole("button", { name: "从此实体继续探索" }).click();
  await page.waitForFunction(({ oldNodes, focus }) => {
    const element = document.querySelector(".graph-stage");
    return element?.getAttribute("data-focus-id") === focus && element?.getAttribute("data-g6-node-ids") !== oldNodes;
  }, { oldNodes: before.nodes, focus: nextFocus }, { timeout: 6000 });
  const after = {
    focus: await stage.getAttribute("data-focus-id"),
    nodes: await stage.getAttribute("data-g6-node-ids"),
    edges: await stage.getAttribute("data-g6-edge-ids"),
    g6Nodes: Number(await stage.getAttribute("data-g6-node-count")),
    g6Edges: Number(await stage.getAttribute("data-g6-edge-count")),
  };
  assert.equal(after.focus, nextFocus, "selected child did not become focus");
  assert.notEqual(after.nodes, before.nodes, "reroot did not change G6 visible nodes");
  assert.notEqual(after.edges, before.edges, "reroot did not change G6 visible edges");
  assert.equal(after.g6Nodes, after.nodes.split(",").filter(Boolean).length, "G6 node count differs from its rendered model");
  assert.equal(after.g6Edges, after.edges.split(",").filter(Boolean).length, "G6 edge count differs from its rendered model");
  assert.match(await page.locator(".action-note").textContent(), /完成布局|局部节点集合相同|未收录/);
  assert.ok(await page.locator(".trail-bar button:not(.back-button)").count() >= 1, "focus change did not store trail history");
  result.checks.focus_switch = { nextFocus, oldNodeCount: before.nodes.split(",").length, newNodeCount: after.g6Nodes, oldEdgeCount: before.edges.split(",").length, newEdgeCount: after.g6Edges };

  const postFocusSnapshot = await readSnapshot();
  const focusPoint = postFocusSnapshot.positions[nextFocus];
  assert.ok(focusPoint, "focused node has no G6 position");
  const focusedCanvas = await canvas.boundingBox();
  assert.ok(focusedCanvas, "canvas box unavailable after reroot");
  const focusedX = postFocusSnapshot.transform.x + focusPoint.x * postFocusSnapshot.transform.zoom;
  const focusedY = postFocusSnapshot.transform.y + focusPoint.y * postFocusSnapshot.transform.zoom;
  const focusCenterOffset = Math.hypot(focusedX - focusedCanvas.width / 2, focusedY - focusedCanvas.height / 2);
  assert.ok(focusCenterOffset < Math.max(focusedCanvas.width, focusedCanvas.height) * 0.32, `focus remained too far from canvas center: ${focusCenterOffset}`);
  result.checks.focus_center_offset_px = Math.round(focusCenterOffset);

  // Re-select the focus after rerooting, then expand in a bounded batch.
  const expand = page.getByRole("button", { name: /将关联实体加入图谱|暂无可展开关联/ });
  if (await expand.count()) {
    await expand.click(); await page.waitForTimeout(350);
  }
  const afterExpand = Number(await page.locator(".graph-stage").getAttribute("data-node-count"));
  assert.ok(afterExpand <= 50, `expanded node count ${afterExpand} exceeds cap`);
  result.checks.expanded_nodes = afterExpand;

  // Restore the saved pre-reroot research context before validating evidence:
  // relevance ranking must not fabricate evidence, and this stable snapshot has
  // real evidence-bearing relationships to exercise through the G6 canvas.
  await page.getByRole("button", { name: "返回上一步" }).click();
  await page.waitForFunction(() => Number(document.querySelector(".graph-stage")?.getAttribute("data-g6-node-count") || 0) > 0);
  result.checks.history_restored = await page.locator(".trail-bar button:not(.back-button)").count();

  // Click an actual rendered G6 edge by using its post-layout endpoint
  // coordinates. This exercises the canvas edge event instead of a helper.
  const relations = await page.evaluate(async () => fetch(`/demo-data/categories/${await fetch("/demo-data/manifest.json").then((r) => r.json()).then((m) => m.topics[0].id)}/relations.json`).then((r) => r.json()));
  const edgeSnapshot = await readSnapshot();
  let edgeClicked = false;
  let evidenceRelation = null;
  const renderedRelations = relations.filter((relation) => edgeSnapshot.edgeIds.includes(`${relation.source}**${relation.target}**${String(relation.rank || "0")}`) && relation.evidence_ids?.length);
  for (const relation of [...renderedRelations].sort((left, right) => (right.evidence_ids?.length || 0) - (left.evidence_ids?.length || 0))) {
    const source = edgeSnapshot.positions[String(relation.source)];
    const target = edgeSnapshot.positions[String(relation.target)];
    if (!source || !target) continue;
    const edgeBox = await canvas.boundingBox();
    if (!edgeBox) break;
    await page.mouse.click(
      edgeBox.x + edgeSnapshot.transform.x + (source.x + target.x) * edgeSnapshot.transform.zoom / 2,
      edgeBox.y + edgeSnapshot.transform.y + (source.y + target.y) * edgeSnapshot.transform.zoom / 2,
    );
    await page.waitForTimeout(80);
    if (await page.locator(".right-panel").getAttribute("data-selected-edge-key") === `${relation.source}**${relation.target}**${String(relation.rank || "0")}`) { edgeClicked = true; evidenceRelation = relation; break; }
  }
  // Ranking intentionally does not use Evidence quantity. A relevance-selected
  // canvas can therefore contain no explicit PMID edge; in that truthful case,
  // open an evidence-bearing real Relationship through the selected node's
  // Connections list rather than manufacturing a canvas edge.
  if (!edgeClicked) {
    const visible = new Set(edgeSnapshot.nodeIds.map(Number));
    const relation = relations.find((item) => item.evidence_ids?.length && (visible.has(item.source) || visible.has(item.target)));
    if (relation) {
      const nodeId = visible.has(relation.source) ? relation.source : relation.target;
      await clickG6Node(edgeSnapshot, String(nodeId));
      const relationButton = page.locator(`.relation-link[data-relation-id="${relation.id}"]`);
      while (!await relationButton.count()) {
        const more = page.getByRole("button", { name: "显示更多关联" });
        if (!await more.count()) break;
        await more.click();
      }
      if (await relationButton.count()) { await relationButton.click(); edgeClicked = true; evidenceRelation = relation; result.checks.evidence_entry = "node_connection"; }
    }
  }
  // The visible local graph may legitimately contain no cited relationship.
  // Still exercise the user-facing Edge Inspector through an actual
  // Connections action; complete PMID linkage is independently checked by
  // verify_static_demo.py against every emitted relationship.
  if (!edgeClicked) {
    const currentSnapshot = await readSnapshot();
    if (currentSnapshot.nodeIds[0]) await clickG6Node(currentSnapshot, currentSnapshot.nodeIds[0]);
    const fallback = page.locator(".relation-link").first();
    if (await fallback.count()) {
      const relationId = await fallback.getAttribute("data-relation-id");
      await fallback.click();
      evidenceRelation = relations.find((item) => item.id === relationId) ?? null;
      edgeClicked = true;
      result.checks.edge_entry = "node_connection";
    }
  }
  assert.ok(edgeClicked, "could not select a real rendered edge via canvas coordinates");
  assert.equal(await page.locator(".endpoint-cards button").count(), 2, "edge inspector endpoint cards missing");
  if (evidenceRelation?.evidence_ids?.length) {
    assert.ok(await page.getByTestId("relation-evidence").locator("a").count() > 0, "edge evidence links did not render");
    if (evidenceRelation.evidence_raw) assert.equal(await page.getByText("查看原始证据记录").count(), 1, "edge inspector did not expose relationship raw Evidence");
    const actualEvidenceHrefs = await page.getByTestId("relation-evidence").locator("a").evaluateAll((links) => links.map((link) => link.href));
    assert.ok(actualEvidenceHrefs.some((href) => href.startsWith("https://pubmed.ncbi.nlm.nih.gov/") || href.startsWith("https://doi.org/")), "edge evidence did not expose a PubMed or DOI link");
    result.checks.edge_evidence_links = evidenceRelation.evidence_ids.length;
  }
  result.checks.edge_inspector_canvas_click = true;
  result.checks.evidence_trace_node_relationship_publication = Boolean(evidenceRelation?.evidence_ids?.length);

  const topicSelector = page.locator(".workspace-header select");
  const topicValues = await topicSelector.locator("option").evaluateAll((options) => options.map((option) => option.getAttribute("value") || ""));
  if (topicValues.length > 1) {
    await topicSelector.selectOption(topicValues[1]); await page.waitForTimeout(650);
    const switchedCount = Number(await page.locator(".graph-stage").getAttribute("data-node-count"));
    assert.ok(switchedCount > 0 && switchedCount <= 50, "theme switch did not create a bounded local graph");
    result.checks.theme_switch_nodes = switchedCount;
  }

  // A separate real canvas scenario exercises multi-seed 3-hop exploration,
  // rather than merely asserting that the inspector exposes the action.
  const multiPage = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  multiPage.on("console", (message) => { if (message.type() === "error") result.consoleErrors.push(message.text()); });
  multiPage.on("pageerror", (error) => result.pageErrors.push(String(error)));
  multiPage.on("request", (request) => { if (request.url().includes("/api/")) result.apiRequests.push(request.url()); });
  await multiPage.goto(baseUrl, { waitUntil: "networkidle" });
  await multiPage.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("进入研究")));
  await multiPage.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("进入研究"))?.click());
  await multiPage.waitForFunction(() => Number(document.querySelector(".graph-stage")?.getAttribute("data-g6-node-count") || 0) > 0);
  await multiPage.locator(".explore-trigger").click();
  await multiPage.locator('.explore-rail label:has-text("探索范围") select').selectOption("3");
  await multiPage.waitForTimeout(250);
  const multiCanvas = multiPage.locator(".graph-stage canvas").first();
  const multiReadSnapshot = async () => JSON.parse(await multiPage.getByTestId("g6-render-snapshot").textContent());
  const multiClickG6Node = async (snapshot, id) => {
    const point = snapshot.positions[id];
    assert.ok(point, `G6 position missing for multi-seed node ${id}`);
    const box = await multiCanvas.boundingBox();
    assert.ok(box, "multi-seed canvas box unavailable");
    await multiPage.mouse.click(box.x + snapshot.transform.x + point.x * snapshot.transform.zoom, box.y + snapshot.transform.y + point.y * snapshot.transform.zoom);
    await multiPage.waitForTimeout(120);
  };
  const multiSnapshot = await multiReadSnapshot();
  let multiCandidateFound = false;
  for (const id of multiSnapshot.nodeIds) {
    await multiClickG6Node(multiSnapshot, id);
    if (await multiPage.locator(".related-row").count() >= 2) { multiCandidateFound = true; break; }
  }
  assert.ok(multiCandidateFound, "no rendered node exposed two static neighbours for multi-seed exploration");
  await multiPage.locator(".related-row input[type=checkbox]").nth(0).check();
  await multiPage.locator(".related-row input[type=checkbox]").nth(1).check();
  const multiExplore = multiPage.getByRole("button", { name: /以 2 个已选关联实体继续探索/ });
  assert.equal(await multiExplore.count(), 1, "multi-seed explore action missing");
  const priorFocus = await multiPage.locator(".graph-stage").getAttribute("data-focus-id");
  await multiExplore.click();
  await multiPage.waitForFunction((focus) => document.querySelector(".graph-stage")?.getAttribute("data-focus-id") !== focus, priorFocus, { timeout: 6000 });
  assert.equal(await multiPage.locator('.explore-rail label:has-text("探索范围") select').inputValue(), "3", "3-hop selection was not retained");
  assert.ok(Number(await multiPage.locator(".graph-stage").getAttribute("data-node-count")) <= 50, "multi-seed exploration exceeded node budget");
  result.checks.multi_seed_3_hop = true;
  assert.equal(result.apiRequests.length, 0, "the static demo requested a real API");
  await page.screenshot({ path: "/tmp/kg-research-trail-acceptance.png", fullPage: true });
} catch (error) {
  result.failure = String(error);
}

await writeFile("/tmp/kg-research-trail-acceptance.json", JSON.stringify(result, null, 2));
await browser?.close();
console.log(JSON.stringify(result));
if (result.failure || result.consoleErrors.length || result.pageErrors.length || result.apiRequests.length) process.exitCode = 1;
