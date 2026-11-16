import { render, screen } from "@testing-library/react";
import { Dialog, DialogContent } from "../components/dialog";
import { describe, expect, it } from "vitest";
import { TangentRoot, useTangentPortalContainer } from "./tangent-root";

function PortalProbe() {
  const container = useTangentPortalContainer();
  return <span>{container ? "has portal" : "no portal"}</span>;
}

describe("TangentRoot", () => {
  it("scopes theme and density with data attributes and keeps the caller's props", () => {
    render(
      <TangentRoot theme="host" density="compact" className="h-full" aria-label="Tangent">
        child
      </TangentRoot>,
    );
    const root = screen.getByLabelText("Tangent");
    expect(root).toHaveAttribute("data-tg-root");
    expect(root).toHaveAttribute("data-tg-theme", "host");
    expect(root).toHaveAttribute("data-tg-density", "compact");
    expect(root.className).toContain("h-full");
  });

  it("follows the OS with theme=system (no data-tg-theme)", () => {
    render(<TangentRoot aria-label="Tangent">child</TangentRoot>);
    expect(screen.getByLabelText("Tangent")).not.toHaveAttribute("data-tg-theme");
  });

  it("provides a popup container inside itself so overlays inherit the theme", async () => {
    render(
      <TangentRoot theme="dark">
        <PortalProbe />
      </TangentRoot>,
    );
    expect(await screen.findByText("has portal")).toBeInTheDocument();
    expect(document.querySelector("[data-tg-portal]")?.closest("[data-tg-theme]")).toHaveAttribute("data-tg-theme", "dark");
  });

  it("isolates its stacking context so popups stay above the host's content inside it", () => {
    render(<TangentRoot aria-label="Tangent">child</TangentRoot>);
    expect(screen.getByLabelText("Tangent").className).toContain("isolate");
  });

  it("portals a popup that is open on the very first commit into the root, not <body> (F0 review M9)", () => {
    render(
      <TangentRoot theme="host">
        <Dialog defaultOpen>
          <DialogContent title="First">body</DialogContent>
        </Dialog>
      </TangentRoot>,
    );
    const dialog = screen.getByRole("dialog", { name: "First" });
    expect(dialog.closest("[data-tg-portal]")).not.toBeNull();
    expect(dialog.closest("[data-tg-theme]")).toHaveAttribute("data-tg-theme", "host");
  });

  it("returns no container outside a root", () => {
    render(<PortalProbe />);
    expect(screen.getByText("no portal")).toBeInTheDocument();
  });
});
