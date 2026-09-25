import { describe, expect, it } from "vitest";
import { servedBuildChanged } from "./build";

const docWithEntry = (src: string): Document => {
  const doc = document.implementation.createHTMLDocument("");
  const script = doc.createElement("script");
  script.type = "module";
  script.src = src;
  doc.body.appendChild(script);
  return doc;
};

const fakeFetch = (html: string, ok = true): typeof fetch =>
  (async () =>
    ({
      ok,
      text: async () => html,
    }) as Response) as typeof fetch;

describe("servedBuildChanged", () => {
  it("reports false when the served bundle matches the running one", async () => {
    const doc = docWithEntry("/assets/index-abc123.js");
    const fetchFn = fakeFetch('<script type="module" src="/assets/index-abc123.js"></script>');
    await expect(servedBuildChanged(doc, fetchFn)).resolves.toBe(false);
  });

  it("reports true when the server is now serving a different hashed bundle", async () => {
    const doc = docWithEntry("/assets/index-abc123.js");
    const fetchFn = fakeFetch('<script type="module" src="/assets/index-def456.js"></script>');
    await expect(servedBuildChanged(doc, fetchFn)).resolves.toBe(true);
  });

  it("reports false in dev mode, where both entries are /src/main.ts", async () => {
    const doc = docWithEntry("/src/main.ts");
    const fetchFn = fakeFetch('<script type="module" src="/src/main.ts"></script>');
    await expect(servedBuildChanged(doc, fetchFn)).resolves.toBe(false);
  });

  it("reports false on a non-OK response", async () => {
    const doc = docWithEntry("/assets/index-abc123.js");
    const fetchFn = fakeFetch("", false);
    await expect(servedBuildChanged(doc, fetchFn)).resolves.toBe(false);
  });

  it("reports false when the fetch rejects", async () => {
    const doc = docWithEntry("/assets/index-abc123.js");
    const fetchFn = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    await expect(servedBuildChanged(doc, fetchFn)).resolves.toBe(false);
  });

  it("reports false when the served HTML has no module entry script", async () => {
    const doc = docWithEntry("/assets/index-abc123.js");
    const fetchFn = fakeFetch("<p>no script here</p>");
    await expect(servedBuildChanged(doc, fetchFn)).resolves.toBe(false);
  });

  it("reports false when the running document has no module entry script", async () => {
    const doc = document.implementation.createHTMLDocument("");
    const fetchFn = fakeFetch('<script type="module" src="/assets/index-abc123.js"></script>');
    await expect(servedBuildChanged(doc, fetchFn)).resolves.toBe(false);
  });
});
