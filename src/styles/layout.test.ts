import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guards the app-scroll regression: the page must grow with its content
// (e.g. a long download queue) instead of clipping it. These assert
// stylesheet rules rather than computed pixels, which jsdom cannot lay out.
const globalsCss = readFileSync(
  new URL("./globals.css", import.meta.url),
  "utf-8",
);

function ruleBody(selector: string, contains?: string): string {
  const pattern = new RegExp(`^${selector}\\s*\\{([^}]*)\\}`, "gm");
  for (const match of globalsCss.matchAll(pattern)) {
    // Ignore comments so documentation mentioning a property cannot
    // satisfy (or break) an assertion about the actual declarations.
    const body = match[1].replace(/\/\*[\s\S]*?\*\//g, "");
    if (!contains || body.includes(contains)) {
      return body;
    }
  }
  throw new Error(`no ${selector} rule found in globals.css`);
}

describe("app scroll layout", () => {
  it("does not clip vertical overflow on body", () => {
    const body = ruleBody("body", "background-color");
    expect(body).not.toMatch(/overflow\s*:\s*hidden/);
    expect(body).toMatch(/overflow-y\s*:\s*auto/);
  });

  it("does not fix #root to the viewport height", () => {
    const root = ruleBody("#root");
    expect(root).not.toMatch(/(?<!min-)height\s*:\s*100vh/);
    expect(root).toMatch(/min-height\s*:\s*100vh/);
  });

  it("never introduces horizontal scrolling", () => {
    expect(ruleBody("body", "background-color")).toMatch(
      /overflow-x\s*:\s*hidden/,
    );
  });
});
