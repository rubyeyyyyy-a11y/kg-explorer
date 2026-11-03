import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import playwright from "../frontend/node_modules/@playwright/test/index.js";

const baseUrl = process.env.DEMO_URL ?? "http://127.0.0.1:4175";
const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
const { chromium } = playwright;
const output = { baseUrl, runs: [], consoleErrors: [], pageErrors: [], apiRequests: [] };
const viewports = [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }];
let browser;

function positionDelta(first, second) {
  return Math.max(0, ...Object.keys(first.positions).map((id) => {
    const next = second.positions[id];
    return next ? Math.hypot(first.positions[id].x - next.x, first.positions[id].y - next.y) : Infinity;
  }));
}

try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    page.on("console", (message) => { if (message.type() === "error") output.consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => output.pageErrors.push(String(error)));
    page.on("request", (request) => { if (request.url().includes("/api/")) output.apiRequests.push(request.url()); });
    const started = performance.now();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("进入研究")));
    await page.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("进入研究"))?.click());
    await page.waitForFunction(() => Number(document.querySelector(".graph-stage")?.getAttribute("data-g6-node-count") || 0) > 0, { timeout: 12_000 });
    const visibleMs = Math.round(performance.now() - started);
    const initial = JSON.parse(await page.getByTestId("g6-render-snapshot").textContent());
    await page.waitForTimeout(600);
    const settled = JSON.parse(await page.getByTestId("g6-render-snapshot").textContent());
    const stableMs = Math.round(performance.now() - started);
    const delta = positionDelta(initial, settled);
    assert.equal(initial.nodeIds.length, settled.nodeIds.length, "node count changed after first graph render");
    assert.ok(delta < 0.5, `graph coordinates were still moving after initial render: ${delta}px`);
    const resources = await page.evaluate(() => performance.getEntriesByType("resource")
      .filter((entry) => entry.name.includes("/demo-data/"))
      .map((entry) => ({ name: entry.name.replace(location.origin, ""), duration_ms: Math.round(entry.duration) })));
    output.runs.push({ viewport, visible_ms: visibleMs, stable_ms: stableMs, node_count: initial.nodeIds.length, edge_count: initial.edgeIds.length, coordinate_delta_px_after_600ms: delta, static_resources: resources });
    if (viewport.width === 1440) await page.screenshot({ path: "/tmp/kg-explorer-render-stability-1440.png", fullPage: true });
    await page.close();
  }
} catch (error) {
  output.failure = String(error);
}

await writeFile("/tmp/kg-explorer-render-stability.json", JSON.stringify(output, null, 2));
await browser?.close();
console.log(JSON.stringify(output));
if (output.failure || output.consoleErrors.length || output.pageErrors.length || output.apiRequests.length) process.exitCode = 1;
