import { describe, expect, it } from "vitest";
import { modelChoices, normalizeCapabilities } from "./capabilities";
import { effectiveEffort, isReasoningEffort, modelInfo, modelInfos, REASONING_EFFORTS } from "./model-catalog";

/** A G1 server's catalog: a ready CLI with details, a CLI that is missing, an API provider without details. */
const G1_BODY = {
  features: [],
  models: [
    {
      provider: "claude-cli",
      models: ["claude-opus-5-5", "claude-haiku-5-5"],
      ready: true,
      details: [
        { model: "claude-opus-5-5", displayName: "Claude Opus 5.5", status: "current", effortLevels: ["low", "medium", "high", "max", "high", ""] },
        { model: "claude-haiku-5-5", displayName: "Claude Haiku 5.5", status: "ancient" },
        { model: "claude-opus-5-5", displayName: "again" },
        { model: "not-listed", displayName: "x" },
        "junk",
      ],
    },
    { provider: "codex-cli", models: ["gpt-6.1-sol"], ready: false, reason: "binary not found", details: null },
    { provider: "anthropic", models: ["claude-haiku-4-5"], ready: "yes", reason: 3 },
  ],
};

describe("capabilities models (G1)", () => {
  it("keeps readiness and the details of listed models, dropping what it cannot read", () => {
    const caps = normalizeCapabilities(G1_BODY);
    expect(caps.models).toStrictEqual([
      {
        provider: "claude-cli",
        models: ["claude-opus-5-5", "claude-haiku-5-5"],
        ready: true,
        details: [
          { model: "claude-opus-5-5", displayName: "Claude Opus 5.5", status: "current", effortLevels: ["low", "medium", "high", "max"] },
          { model: "claude-haiku-5-5", displayName: "Claude Haiku 5.5" },
        ],
      },
      { provider: "codex-cli", models: ["gpt-6.1-sol"], ready: false, reason: "binary not found" },
      { provider: "anthropic", models: ["claude-haiku-4-5"] },
    ]);
  });

  it("still reads a B5 server's catalog exactly as before", () => {
    const caps = normalizeCapabilities({ features: [], models: [{ provider: "fake", models: ["fake-1"] }] });
    expect(caps.models).toStrictEqual([{ provider: "fake", models: ["fake-1"] }]);
    expect(modelChoices(caps)).toStrictEqual([{ provider: "fake", model: "fake-1" }]);
    expect(modelInfo(caps, "fake", "fake-1")).toStrictEqual({ provider: "fake", model: "fake-1", label: "fake-1", status: null, effortLevels: [], ready: null, reason: null });
  });

  it("modelChoices lists the pairs of the extended catalog too", () => {
    expect(modelChoices(normalizeCapabilities(G1_BODY))).toStrictEqual([
      { provider: "claude-cli", model: "claude-opus-5-5" },
      { provider: "claude-cli", model: "claude-haiku-5-5" },
      { provider: "codex-cli", model: "gpt-6.1-sol" },
      { provider: "anthropic", model: "claude-haiku-4-5" },
    ]);
  });
});

describe("modelInfo / modelInfos", () => {
  const caps = normalizeCapabilities(G1_BODY);
  it("names a model, its status, efforts and its provider's readiness", () => {
    expect(modelInfo(caps, "claude-cli", "claude-opus-5-5")).toStrictEqual({
      provider: "claude-cli",
      model: "claude-opus-5-5",
      label: "Claude Opus 5.5",
      status: "current",
      effortLevels: ["low", "medium", "high", "max"],
      ready: true,
      reason: null,
    });
    expect(modelInfo(caps, "codex-cli", "gpt-6.1-sol")).toMatchObject({ label: "gpt-6.1-sol", ready: false, reason: "binary not found", effortLevels: [] });
    expect(modelInfo(caps, "nowhere", "m")).toMatchObject({ label: "m", ready: null });
    expect(modelInfo(null, "p", "m").label).toBe("m");
  });

  it("lists every model in the server's order, or null without a list", () => {
    expect(modelInfos(caps)?.map((info) => `${info.provider}/${info.label}`)).toEqual(["claude-cli/Claude Opus 5.5", "claude-cli/Claude Haiku 5.5", "codex-cli/gpt-6.1-sol", "anthropic/claude-haiku-4-5"]);
    expect(modelInfos(normalizeCapabilities({ features: [] }))).toBeNull();
  });

  it("shows an effort only when the model takes it", () => {
    const opus = modelInfo(caps, "claude-cli", "claude-opus-5-5");
    expect(effectiveEffort(opus, "high")).toBe("high");
    expect(effectiveEffort(opus, "xhigh")).toBeNull();
    expect(effectiveEffort(modelInfo(caps, "claude-cli", "claude-haiku-5-5"), "high")).toBeNull();
    expect(effectiveEffort(opus, null)).toBeNull();
  });

  it("knows the effort names", () => {
    expect(REASONING_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(isReasoningEffort("max")).toBe(true);
    expect(isReasoningEffort("ultra")).toBe(false);
    expect(isReasoningEffort(3)).toBe(false);
  });
});
