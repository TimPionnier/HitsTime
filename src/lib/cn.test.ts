import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("drops falsy values", () => {
    expect(cn("a", false, undefined, "b")).toBe("a b");
  });

  it("lets later Tailwind classes override earlier conflicting ones", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
});
