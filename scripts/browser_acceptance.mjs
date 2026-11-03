import playwright from "../frontend/node_modules/@playwright/test/index.js";
import { writeFile } from "node:fs/promises";

const { chromium } = playwright;

const baseUrl = process.env.DEMO_URL ?? "http://127.0.0.1:4175";
const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
const consoleErrors = [];
const pageErrors = [];
const apiRequests = [];
const result = { baseUrl, checks: {}, consoleErrors, pageErrors, apiRequests };
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("request", (request) => { if (request.url().includes("/api/")) apiRequests.push(request.url()); });
  const start = performance.now();
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  result.checks.first_load_ms = Math.round(performance.now() - start);
  result.checks.title = await page.locator("h1").first().textContent();
  result.checks.theme_cards = await page.locator(".topic-card").count();
  result.checks.initial_budget_notice = await page.locator(".budget-note").count();
  await page.screenshot({ path: "/tmp/kg-demo-first-load.png", fullPage: true });

  await page.getByRole("button", { name: /进入研究/ }).first().click();
  await page.locator(".workspace-header select").selectOption("gastric-egfr-treatment");
  await page.locator(".graph-stage canvas").first().waitFor({ state: "visible" });
  result.checks.topic_switch = await page.locator(".research-context b").textContent();

  const search = page.locator('input[placeholder="搜索名称、类型或标识"]').first();
  await search.fill("Lovastatin");
  result.checks.search_result_count = await page.locator(".search-popover button").count();
  await page.locator(".search-popover button").first().click();

  await page.locator(".explore-trigger").click();
  result.checks.seed_count_after_search = await page.locator(".pill").count();
  await page.locator('.explore-rail label:has-text("探索范围") select').selectOption("3");
  result.checks.hop_3_selected = await page.locator('.explore-rail label:has-text("探索范围") select').inputValue();
  await page.locator(".filters-toggle").click();
  await page.getByRole("button", { name: /药物作用与靶点/ }).click();
  result.checks.category_filter_active = await page.locator(".facet.active").count();

  const typeSelect = page.locator(".explore-rail select[multiple]").first();
  await typeSelect.selectOption(["gene", "drug"]);
  result.checks.type_filter_selected = await typeSelect.inputValue();
  await typeSelect.selectOption([]);
  result.checks.expand_budget_text = await page.locator(".canvas-toolbar").textContent();

  const canvas = page.locator(".graph-stage canvas").first();
  const box = await canvas.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.56, box.y + box.height * 0.52, { steps: 8 }); await page.mouse.up();
    await page.mouse.wheel(0, -400);
    result.checks.canvas_drag_zoom = true;
  } else result.checks.canvas_drag_zoom = false;

  await page.locator('.explore-rail input[placeholder="搜索实体"]').fill("not-in-static-subset-zzzz");
  result.checks.empty_search_message = await page.locator(".empty-note").first().textContent();
  await page.reload({ waitUntil: "networkidle" });
  result.checks.refresh_theme_cards = await page.locator(".topic-card").count();
  await page.screenshot({ path: "/tmp/kg-demo-interactions.png", fullPage: true });
} catch (error) {
  result.failure = String(error);
}
await writeFile("/tmp/kg-demo-browser-acceptance.json", JSON.stringify(result, null, 2));
await browser?.close();
console.log(JSON.stringify(result));
if (result.failure || consoleErrors.length || pageErrors.length || apiRequests.length) process.exitCode = 1;
