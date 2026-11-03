import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import playwright from "../frontend/node_modules/@playwright/test/index.js";

const { chromium } = playwright;
const baseUrl = process.env.DEMO_URL ?? "http://127.0.0.1:4175";
const result = { baseUrl, checks: {}, screenshots: [], consoleErrors: [], pageErrors: [], apiRequests: [] };
let browser;

async function screenshot(page, name) {
  const path = `/tmp/kg-ui-refinement/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  result.screenshots.push(path);
}

try {
  await mkdir("/tmp/kg-ui-refinement", { recursive: true });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });
  page.on("console", (message) => { if (message.type() === "error") result.consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => result.pageErrors.push(String(error)));
  page.on("request", (request) => { if (request.url().includes("/api/")) result.apiRequests.push(request.url()); });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  result.checks.topic_cards = await page.locator(".topic-card").count();
  assert.equal(result.checks.topic_cards, 5, "expected five research topics");
  await screenshot(page, "01-home");

  await page.getByRole("button", { name: /进入研究/ }).first().click();
  await page.waitForFunction(() => Number(document.querySelector(".graph-stage")?.getAttribute("data-g6-node-count") || 0) > 0);
  result.checks.initial_graph_nodes = Number(await page.locator(".graph-stage").getAttribute("data-g6-node-count"));
  assert.ok(result.checks.initial_graph_nodes > 0);
  await screenshot(page, "02-workspace");

  await page.locator(".explore-trigger").click();
  await page.locator(".explore-rail").waitFor({ state: "visible" });
  await screenshot(page, "03-explore");
  await page.locator(".rail-close").click();

  const canvas = page.locator(".graph-stage canvas").first();
  const clickNode = async () => {
    const snapshot = JSON.parse(await page.getByTestId("g6-render-snapshot").textContent());
    const id = snapshot.nodeIds[0];
    const position = snapshot.positions[id];
    const box = await canvas.boundingBox();
    assert.ok(position && box, "G6 node position or canvas unavailable");
    await page.mouse.click(box.x + snapshot.transform.x + position.x * snapshot.transform.zoom, box.y + snapshot.transform.y + position.y * snapshot.transform.zoom);
    await page.locator(".right-panel[data-selected-node-id]").waitFor({ state: "visible" });
  };
  await clickNode();
  result.checks.node_inspector = await page.getByText("实体", { exact: true }).count();
  assert.equal(result.checks.node_inspector, 1);
  await screenshot(page, "04-node-inspector");

  result.checks.literature_sections = await page.locator(".right-panel .inspector-section h4").filter({ hasText: "支持文献" }).count();
  assert.ok(result.checks.literature_sections >= 1);
  await screenshot(page, "05-supporting-literature");

  const relationButton = page.locator(".relation-link").first();
  if (await relationButton.count()) {
    await relationButton.click();
    await page.locator(".right-panel[data-selected-edge-key]").waitFor({ state: "visible" });
    result.checks.edge_inspector = await page.locator(".endpoint-cards button").count();
    assert.equal(result.checks.edge_inspector, 2);
    await screenshot(page, "06-edge-inspector");
  }

  await page.setViewportSize({ width: 1024, height: 820 });
  await page.waitForTimeout(300);
  await screenshot(page, "07-1024px");
  result.checks.visible_prohibited_text = await page.locator("body").evaluate((body) => {
    const text = body.innerText;
    return ["Layered Multi-Seed", "Priority score", "Hub Penalty", "Golden Fixture", "Static Demo", "/home/ray/", "uploaded_by", "本地原始文件", "导入记录者"].filter((term) => text.includes(term));
  });
  assert.deepEqual(result.checks.visible_prohibited_text, []);
  assert.equal(result.apiRequests.length, 0, "static explorer must not request /api/");
} catch (error) {
  result.failure = String(error);
}

await writeFile("/tmp/kg-ui-refinement-acceptance.json", JSON.stringify(result, null, 2));
await browser?.close();
console.log(JSON.stringify(result));
if (result.failure || result.consoleErrors.length || result.pageErrors.length || result.apiRequests.length) process.exitCode = 1;
