import { normalizeLine, type TangentEvent } from "@tangent/client";
import { NAS_ROOT_ID } from "@tangent/client/testing";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEvent } from "../data/event-sync";
import { createLiveStore } from "../data/live-store";
import { tangentKeys } from "../query-keys";
import { mockClient, tangentWrapper } from "../test-utils";
import { useTangent } from "../provider";
import { SummaryDueHint } from "./summary-due";

afterEach(cleanup);
const event = (type: string, data: unknown, lineId = "l1") => ({ type, tenant: "", lineId, rootLineId: lineId, data }) as TangentEvent;

describe("summary.due (B8.2): a transient signal in the live store", () => {
  it("marks the line due and clears it when a newer summary arrives", () => {
    const keys = tangentKeys({ baseUrl: "/api" });
    const target = { queryClient: new QueryClient(), keys, live: createLiveStore() };
    target.queryClient.setQueryData(keys.lineView("l1"), normalizeLine({ id: "l1", summary: { updatedAt: "t0" } }));
    applyEvent(target, event("summary.due", { lineId: "l1", rootLineId: "l1" }));
    expect(target.live.getState().summaryDue.l1).toBe(true);
    applyEvent(target, event("line.updated", normalizeLine({ id: "l1", summary: { updatedAt: "t0" } })));
    expect(target.live.getState().summaryDue.l1).toBe(true);
    applyEvent(target, event("line.updated", normalizeLine({ id: "l1", summary: { updatedAt: "t1" } })));
    expect(target.live.getState().summaryDue.l1).toBeUndefined();
  });
});

describe("SummaryDueHint", () => {
  function Due({ lineId }: { lineId: string }) {
    const { live } = useTangent();
    return <button type="button" onClick={() => live.setSummaryDue(lineId, true)}>due</button>;
  }

  it("offers 整理摘要 (POST /compact) and 稍後 once the line is due; nothing before", async () => {
    const client = mockClient();
    const compact = vi.spyOn(client, "compact");
    render(
      <>
        <Due lineId={NAS_ROOT_ID} />
        <SummaryDueHint lineId={NAS_ROOT_ID} />
      </>,
      { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) },
    );
    expect(screen.queryByRole("group", { name: "建議整理摘要" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "due" }));
    const hint = screen.getByRole("group", { name: "建議整理摘要" });
    expect(hint.className).toContain("border-dashed");
    expect(screen.getByRole("button", { name: "due" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "整理摘要" }));
    await waitFor(() => expect(compact).toHaveBeenCalledWith(NAS_ROOT_ID));
    await waitFor(() => expect(screen.queryByRole("group", { name: "建議整理摘要" })).toBeNull());
    await act(async () => screen.getByRole("button", { name: "due" }).click());
    await userEvent.click(screen.getByRole("button", { name: "稍後" }));
    expect(screen.queryByRole("group", { name: "建議整理摘要" })).toBeNull();
    client.mock.dispose();
  });
});
