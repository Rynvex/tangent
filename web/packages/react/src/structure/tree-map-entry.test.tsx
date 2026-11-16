import { NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { en } from "../i18n/en";
import { TREE_MAP_MESSAGES } from "../i18n/tree-map-messages";
import { mockClient, tangentWrapper } from "../test-utils";
import { StructurePanel } from "./structure-panel";

afterEach(cleanup);

function setup(onOpenTreeMap?: () => void) {
  const client = mockClient({ scenario: nasScenario() });
  render(
    <StructurePanel
      rootLineId={NAS_ROOT_ID}
      currentLineId={NAS_ROOT_ID}
      title="家用 NAS"
      view="outline"
      onViewChange={() => undefined}
      allowMap={false}
      onEnter={() => undefined}
      onJump={() => undefined}
      {...(onOpenTreeMap ? { onOpenTreeMap } : {})}
    />,
    { wrapper: tangentWrapper(client) },
  );
  return client;
}

describe("StructurePanel: the narrow screens' tree map entry (F9 B.3)", () => {
  it("shows 「樹狀地圖」 only when the host gives a way there, and calls it", async () => {
    const onOpenTreeMap = vi.fn();
    const client = setup(onOpenTreeMap);
    await userEvent.click(await screen.findByRole("button", { name: "Tree map" }));
    expect(onOpenTreeMap).toHaveBeenCalledTimes(1);
    client.mock.dispose();
    cleanup();
    const without = setup();
    await screen.findByRole("radiogroup", { name: "View" });
    expect(screen.queryByRole("button", { name: "Tree map" })).toBeNull();
    without.mock.dispose();
  });

  it("its bundle has the same keys in all languages and none of the main dictionary's", () => {
    expect(Object.keys(TREE_MAP_MESSAGES["zh-TW"]).sort()).toEqual(Object.keys(TREE_MAP_MESSAGES.en).sort());
    expect(Object.keys(TREE_MAP_MESSAGES.ja).sort()).toEqual(Object.keys(TREE_MAP_MESSAGES.en).sort());
    for (const key of Object.keys(TREE_MAP_MESSAGES.en)) expect(Object.hasOwn(en, key), key).toBe(false);
  });
});
