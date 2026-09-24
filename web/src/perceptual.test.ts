import { describe, expect, it } from "vitest";
import { chroma, deltaE, hexToLab } from "./perceptual";

describe("hexToLab", () => {
  it("maps black, white and grey onto the neutral axis", () => {
    expect(hexToLab("#000000")).toEqual([0, 0, 0]);
    const [L, a, b] = hexToLab("#ffffff");
    expect(L).toBeCloseTo(100, 3);
    expect(a).toBeCloseTo(0, 3);
    expect(b).toBeCloseTo(0, 3);
    expect(chroma("#808080")).toBeCloseTo(0, 3);
  });

  it("matches reference CIELAB (D65) values", () => {
    const [L, a, b] = hexToLab("#ff0000");
    expect(L).toBeCloseTo(53.24, 1);
    expect(a).toBeCloseTo(80.09, 1);
    expect(b).toBeCloseTo(67.2, 1);
  });
});

describe("deltaE", () => {
  it("is the Euclidean CIE76 distance in Lab", () => {
    expect(deltaE("#123456", "#123456")).toBe(0);
    expect(deltaE("#000000", "#ffffff")).toBeCloseTo(100, 3);
  });
});

describe("chroma", () => {
  it("is high for saturated colours and near zero for greys", () => {
    expect(chroma("#ff0000")).toBeCloseTo(104.55, 1);
    expect(chroma("#3a3a44")).toBeLessThan(8);
  });
});
