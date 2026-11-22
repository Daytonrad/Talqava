// Optional real browser, used only if Playwright is installed (npm install playwright).
let playwright;
let page;

export async function browserAvailable() {
  if (playwright === undefined) {
    try {
      playwright = await import("playwright");
    } catch {
      playwright = null;
    }
  }
  return Boolean(playwright);
}

async function getPage() {
  if (page && !page.isClosed()) return page;
  const browser = await playwright.chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  return page;
}

async function describe(p) {
  const text = await p.evaluate(() => document.body?.innerText || "");
  return `${await p.title()}\n${p.url()}\n\n${text.slice(0, 15_000)}`;
}

// A target is a CSS selector if it matches something, otherwise visible text.
async function locate(p, target) {
  try {
    const bySelector = p.locator(target);
    if (await bySelector.count()) return bySelector.first();
  } catch {}
  return p.getByText(target, { exact: false }).first();
}

export async function browserAction(input) {
  if (!(await browserAvailable())) throw new Error("The browser is not installed.");
  const p = await getPage();
  switch (input.action) {
    case "goto": {
      const url = new URL(input.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http and https pages can be opened.");
      await p.goto(url.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
      return describe(p);
    }
    case "read":
      return describe(p);
    case "click":
      await (await locate(p, input.target)).click({ timeout: 15_000 });
      await p.waitForLoadState("domcontentloaded").catch(() => {});
      return describe(p);
    case "type": {
      const field = await locate(p, input.target);
      await field.fill(input.text ?? "", { timeout: 15_000 });
      if (input.submit) {
        await field.press("Enter");
        await p.waitForLoadState("domcontentloaded").catch(() => {});
      }
      return describe(p);
    }
    case "screenshot": {
      const data = (await p.screenshot({ type: "png" })).toString("base64");
      return [{ type: "image", source: { type: "base64", media_type: "image/png", data } }];
    }
    default:
      throw new Error(`Unknown browser action "${input.action}".`);
  }
}
