import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { formatTokens, UsageMeter } from "./usage-meter";

describe("UsageMeter (LineView.usage, DESIGN §12 F0)", () => {
  it("formats token counts compactly", () => {
    expect([formatTokens(950), formatTokens(1234), formatTokens(9_960), formatTokens(38_300)]).toEqual(["950", "1.2k", "10k", "38k"]);
    expect(formatTokens(2000)).toBe("2k");
  });

  it("shows input + output tokens only, never the cost", () => {
    render(<UsageMeter usage={{ inputTokens: 33_100, outputTokens: 5_200, costUsd: 0.21 }} />);
    expect(screen.getByText("38k tokens")).toBeInTheDocument();
    expect(screen.queryByText(/0\.21|US\$/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("opens the preview when the host passes onClick", async () => {
    const onClick = vi.fn();
    render(<UsageMeter usage={{ inputTokens: 900, outputTokens: 50, costUsd: 0 }} onClick={onClick} />);
    await userEvent.click(screen.getByRole("button", { name: /950 tokens/ }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
