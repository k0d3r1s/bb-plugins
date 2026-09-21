import { describe, expect, it } from "vitest";
import { ESSENTIALS, selectSkills, TIER_A } from "./select-skills.mjs";

describe("selectSkills", () => {
  it("surfaces Tier-A plus essentials for a normal thread", () => {
    const s = selectSkills({ origin: { kind: "user" } });
    expect(s).toEqual([...TIER_A, ...ESSENTIALS]);
  });

  it("surfaces only Tier-A for a side-chat fork", () => {
    expect(selectSkills({ origin: { kind: "fork" } })).toEqual([...TIER_A]);
  });

  it("defaults to Tier-A plus essentials when context is absent", () => {
    expect(selectSkills(undefined)).toEqual([...TIER_A, ...ESSENTIALS]);
  });

  it("keeps the essentials set small (locate, not autoload)", () => {
    expect(ESSENTIALS.length).toBeLessThanOrEqual(8);
  });
});
