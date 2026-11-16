// @vitest-environment jsdom
import type { TangentEvent } from "@tangent/client";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldNotify, useThreadNotifications, type ThreadNotifyOptions } from "./thread-notify";
import { notificationPermission, notifyReply, requestNotificationPermission } from "./thread-notify-browser";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reply = (status: string, lineId = "nas-b2", meta: Record<string, unknown> = {}, id = "m9"): TangentEvent =>
  ({ type: "message.updated", tenant: "", lineId, rootLineId: "nas", data: { id, lineId, role: "assistant", kind: "chat", status, content: "", meta } }) as unknown as TangentEvent;

function setup(initial: Partial<ThreadNotifyOptions> = {}) {
  const notify = vi.fn();
  const onOpen = vi.fn();
  const options: ThreadNotifyOptions = {
    mode: "silent",
    selected: "nas",
    describe: (lineId, failed) => ({ title: "Tangent", body: `${lineId} ${failed ? "failed" : "answered"}` }),
    onOpen,
    notify,
    tabAway: () => false,
    ...initial,
  };
  const hook = renderHook((props: ThreadNotifyOptions) => useThreadNotifications(props), { initialProps: options });
  const finish = (lineId?: string, status = "done", meta: Record<string, unknown> = {}) => {
    act(() => hook.result.current(reply("pending", lineId)));
    act(() => hook.result.current(reply(status, lineId, meta)));
  };
  return { hook, options, notify, onOpen, finish };
}

describe("thread notifications (G2, Settings → General)", () => {
  it("decides: never when off; otherwise for a line that is not on screen, or any line while the tab is away", () => {
    expect(shouldNotify("off", true, false)).toBe(false);
    expect(shouldNotify("silent", false, true)).toBe(false);
    expect(shouldNotify("silent", false, false)).toBe(true);
    expect(shouldNotify("silent", true, true)).toBe(true);
    expect(shouldNotify("sound", true, true)).toBe(true);
  });

  it("notifies when a reply finishes on a line that is not on screen; pressing it shows that line", () => {
    const { notify, onOpen, finish } = setup();
    finish("nas-b2");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({ title: "Tangent", body: "nas-b2 answered", sound: false });
    notify.mock.calls[0]![0].onClick();
    expect(onOpen).toHaveBeenCalledWith("nas-b2");
  });

  it("stays quiet for the line on screen while the tab is in front, and speaks up once the tab is away", () => {
    const { hook, options, notify, finish } = setup();
    finish("nas");
    expect(notify).not.toHaveBeenCalled();
    hook.rerender({ ...options, tabAway: () => true });
    finish("nas");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does nothing when off, plays the chime with `sound`, and says when a reply failed", () => {
    const off = setup({ mode: "off" });
    off.finish("nas-b2");
    expect(off.notify).not.toHaveBeenCalled();
    const sound = setup({ mode: "sound" });
    sound.finish("nas-b2", "error");
    expect(sound.notify.mock.calls[0]![0]).toMatchObject({ body: "nas-b2 failed", sound: true });
  });

  it("counts only a reply it saw start, never a stopped one, and each reply once", () => {
    const { hook, notify, finish } = setup();
    // A finished message that changes later (a tag) was never pending here.
    act(() => hook.result.current(reply("done")));
    expect(notify).not.toHaveBeenCalled();
    finish("nas-b2", "done", { cancelled: true });
    expect(notify).not.toHaveBeenCalled();
    finish("nas-b2");
    act(() => hook.result.current(reply("done")));
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("the browser side", () => {
  it("shows one replaceable notification when allowed, and focuses the page when it is pressed", () => {
    const shown: Array<{ title: string; options: NotificationOptions; onclick: (() => void) | null; close: () => void }> = [];
    class FakeNotification {
      static permission = "granted";
      onclick: (() => void) | null = null;
      close = vi.fn();
      constructor(
        public title: string,
        public options: NotificationOptions,
      ) {
        shown.push(this);
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    const onClick = vi.fn();
    notifyReply({ title: "Tangent", body: "“UPS” has an answer", sound: false, onClick });
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ title: "Tangent", options: { body: "“UPS” has an answer", tag: "tangent-reply", silent: true } });
    shown[0]!.onclick?.();
    expect(focus).toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(shown[0]!.close).toHaveBeenCalled();
  });

  it("shows nothing without permission, and plays the chime only when asked", () => {
    const created = vi.fn();
    vi.stubGlobal("Notification", Object.assign(created, { permission: "denied" }));
    const start = vi.fn();
    const node = () => ({ connect: (next: unknown) => next, start, stop: vi.fn(), type: "", frequency: { value: 0 }, gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } });
    vi.stubGlobal("AudioContext", class {
      currentTime = 0;
      destination = {};
      resume = () => Promise.resolve();
      createOscillator = node;
      createGain = node;
    });
    notifyReply({ title: "Tangent", body: "x", sound: false, onClick: () => {} });
    expect(created).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    notifyReply({ title: "Tangent", body: "x", sound: true, onClick: () => {} });
    // Two notes.
    expect(start).toHaveBeenCalledTimes(2);
    expect(created).not.toHaveBeenCalled();
  });

  it("reports and asks for the permission; a browser without notifications says so", async () => {
    vi.stubGlobal("Notification", undefined);
    expect(notificationPermission()).toBe("unsupported");
    expect(await requestNotificationPermission()).toBe("unsupported");
    const requestPermission = vi.fn(() => Promise.resolve("granted"));
    vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "default", requestPermission }));
    expect(notificationPermission()).toBe("default");
    expect(await requestNotificationPermission()).toBe("granted");
    // Already answered: the browser is not asked again.
    vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "denied", requestPermission }));
    expect(await requestNotificationPermission()).toBe("denied");
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });
});
