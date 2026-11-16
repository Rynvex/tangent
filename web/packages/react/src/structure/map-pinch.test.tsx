import { normalizeBranchView } from "@tangent/client";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchMap, MAP_ZOOM_MAX, MAP_ZOOM_MIN } from "./branch-map";
import { pinchDistance, pinchMidpoint, pinchStep } from "./use-map-pinch";

afterEach(cleanup);

const BRANCHES = ["alpha", "beta"].map((id, n) => normalizeBranchView({ lineId: id, parentLineId: "root", rootLineId: "root", purpose: id, status: "open", createdAt: `2026-01-01T00:00:0${n}Z` }));
const clamp = (zoom: number) => Math.round(Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, zoom)) * 100) / 100;

/** A pointer event with the fields jsdom's MouseEvent lacks. */
function pointer(type: string, id: number, x: number, y: number, extra: { pointerType?: string; isPrimary?: boolean } = {}): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, {
    pointerId: { value: id },
    pointerType: { value: extra.pointerType ?? "touch" },
    isPrimary: { value: extra.isPrimary ?? id === 1 },
  });
  return event;
}

function setup() {
  const onManualMove = vi.fn();
  render(<BranchMap branches={BRANCHES} rootLineId="root" currentLineId="root" mainCount={3} onEnter={vi.fn()} onManualMove={onManualMove} />);
  const map = screen.getByRole("group", { name: "Branch map" });
  const zoom = () => screen.getByRole("status", { name: /Zoom/ }).textContent;
  const fire = (event: Event) => act(() => void map.dispatchEvent(event));
  return { map, zoom, fire, onManualMove };
}

describe("pinchStep (F9 B.3)", () => {
  it("scales the start zoom by the spread, clamped, and keeps the start's map point under the midpoint", () => {
    const start = { zoom: 1, distance: 100, anchor: { x: 300, y: 120 } };
    const origin = { x: 10, y: 20 };
    const step = pinchStep(start, { x: 210, y: 140 }, 150, origin, clamp);
    expect(step.zoom).toBe(1.5);
    // The anchor, scaled and scrolled, lands back under the midpoint.
    expect(start.anchor.x * step.zoom - step.left + origin.x).toBe(210);
    expect(start.anchor.y * step.zoom - step.top + origin.y).toBe(140);
    expect(pinchStep(start, { x: 210, y: 140 }, 1000, origin, clamp).zoom).toBe(MAP_ZOOM_MAX);
    expect(pinchStep(start, { x: 210, y: 140 }, 10, origin, clamp).zoom).toBe(MAP_ZOOM_MIN);
    expect(pinchDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(pinchMidpoint({ x: 0, y: 0 }, { x: 4, y: 2 })).toEqual({ x: 2, y: 1 });
  });
});

describe("BranchMap pinch (F9 B.3)", () => {
  it("a third finger and its lift keep the pinch on the fingers still down", () => {
    const { zoom, fire } = setup();
    fire(pointer("pointerdown", 1, 100, 100));
    fire(pointer("pointerdown", 2, 200, 100));
    fire(pointer("pointerdown", 3, 300, 300));
    fire(pointer("pointerup", 3, 300, 300));
    // Re-anchored on fingers 1 and 2 (100 px apart): spreading them to 150 px is 150 %.
    fire(pointer("pointermove", 2, 250, 100));
    expect(zoom()).toBe("150%");
    fire(pointer("pointerup", 2, 250, 100));
    fire(pointer("pointerup", 1, 100, 100));
  });

  it("two fingers spreading zoom in, pinching zoom out, within 50–160 %; it is a move by hand", () => {
    const { zoom, fire, onManualMove } = setup();
    expect(zoom()).toBe("100%");
    fire(pointer("pointerdown", 1, 100, 100));
    fire(pointer("pointerdown", 2, 200, 100));
    expect(onManualMove).toHaveBeenCalled();
    fire(pointer("pointermove", 2, 250, 100));
    expect(zoom()).toBe("150%");
    fire(pointer("pointermove", 2, 400, 100));
    expect(zoom()).toBe("160%");
    fire(pointer("pointermove", 2, 120, 100));
    expect(zoom()).toBe("50%");
    fire(pointer("pointerup", 2, 120, 100));
    fire(pointer("pointerup", 1, 100, 100));
    // After the pinch, one finger alone does not zoom.
    fire(pointer("pointerdown", 1, 100, 100));
    fire(pointer("pointermove", 1, 300, 100));
    expect(zoom()).toBe("50%");
  });

  it("a mouse never pinches, and a cancelled finger ends the pinch", () => {
    const { zoom, fire } = setup();
    fire(pointer("pointerdown", 1, 100, 100, { pointerType: "mouse" }));
    fire(pointer("pointerdown", 2, 200, 100, { pointerType: "mouse" }));
    fire(pointer("pointermove", 2, 300, 100, { pointerType: "mouse" }));
    expect(zoom()).toBe("100%");
    fire(pointer("pointerdown", 3, 100, 100, { isPrimary: true }));
    fire(pointer("pointerdown", 4, 200, 100, { isPrimary: false }));
    fire(pointer("pointercancel", 4, 200, 100));
    fire(pointer("pointermove", 3, 0, 100));
    expect(zoom()).toBe("100%");
  });
});
