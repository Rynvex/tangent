// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { ExportPreview } from "./export-preview";

afterEach(cleanup);

describe("ExportPreview", () => {
  it("shows the file's text in a focusable, named region", () => {
    const client = mockClient();
    render(<ExportPreview mode="text" text={"# Title\n\nbody"} />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
    const region = screen.getByLabelText("檔案預覽");
    expect(region.tagName).toBe("PRE");
    expect(region.tabIndex).toBe(0);
    expect(region.textContent).toBe("# Title\n\nbody");
    client.mock.dispose();
  });

  it("shows flashcards with their front, back and source", () => {
    const client = mockClient();
    render(
      <ExportPreview
        mode="cards"
        cards={[
          { front: "What is N+1?", back: "One query per row", source: "aside", lineId: "b1" },
          { front: "REST", back: "Clients cache by URL", source: "fact", lineId: "" },
        ]}
      />,
      { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) },
    );
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("順口問");
    expect(items[0]!.textContent).toContain("What is N+1?");
    expect(items[1]!.textContent).toContain("已確認的事實");
    expect(screen.getByLabelText("檔案預覽").tabIndex).toBe(0);
    client.mock.dispose();
  });
});
