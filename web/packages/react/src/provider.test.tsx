import { createTangentClient } from "@tangent/client";
import { render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { HostMessages } from "./i18n";
import { TangentProvider, useTangent, useTangentClient, useTangentKeys, useTangentT, type TangentProviderProps } from "./provider";

const client = createTangentClient({ baseUrl: "/api", fetch: async () => new Response("{}") });

type WrapperProps = Partial<Pick<TangentProviderProps, "locale" | "tenant" | "scopeKey">> & { messages?: HostMessages };

function wrapper(props: WrapperProps) {
  return ({ children }: { children: ReactNode }) => (
    <TangentProvider client={client} locale={props.locale} tenant={props.tenant} scopeKey={props.scopeKey} messages={props.messages}>
      {children}
    </TangentProvider>
  );
}

describe("TangentProvider", () => {
  it("exposes the client, the tenant and query keys scoped to both", () => {
    const { result } = renderHook(() => ({ value: useTangent(), client: useTangentClient(), keys: useTangentKeys() }), {
      wrapper: wrapper({ tenant: "t1", scopeKey: "u1" }),
    });
    expect(result.current.client).toBe(client);
    expect(result.current.value.tenant).toBe("t1");
    expect(result.current.keys.all).toEqual(["tangent", "/api", "t1", "u1"]);
  });

  it("translates with the locale and the host's overrides", () => {
    function Probe() {
      const t = useTangentT();
      return (
        <p>
          {t("branch.errorTreeLimit", { limit: 9 })}|{t("branch.errorUnknown")}
        </p>
      );
    }
    render(<Probe />, { wrapper: wrapper({ locale: "zh-TW", messages: { "branch.errorUnknown": "host text" } }) });
    expect(screen.getByText("這個對話的支線已達 9 條。|host text")).toBeInTheDocument();
  });

  it("exposes the host's text for its own error codes (DESIGN §12)", () => {
    const { result } = renderHook(() => useTangent(), { wrapper: wrapper({ messages: { "error.daemon_offline": "offline" } }) });
    expect(result.current.hostErrorText("daemon_offline")).toBe("offline");
    expect(result.current.hostErrorText("unknown")).toBeUndefined();
  });

  it("keeps the context value when the host passes an equal inline messages object (review M4)", () => {
    const seen: unknown[] = [];
    function Probe() {
      seen.push(useTangent());
      return null;
    }
    const tree = (messages: HostMessages) => (
      <TangentProvider client={client} messages={messages}>
        <Probe />
      </TangentProvider>
    );
    const { rerender } = render(tree({ "branch.errorUnknown": "a" }));
    rerender(tree({ "branch.errorUnknown": "a" }));
    rerender(tree({ "branch.errorUnknown": "b" }));
    expect(seen).toHaveLength(3);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).not.toBe(seen[1]);
  });

  it("defaults to English, an empty tenant and an empty scope key", () => {
    const { result } = renderHook(() => useTangent(), { wrapper: wrapper({}) });
    expect(result.current.locale).toBe("en");
    expect(result.current.tenant).toBe("");
    expect(result.current.scopeKey).toBe("");
  });

  it("fails loudly when used outside the provider", () => {
    expect(() => renderHook(() => useTangentClient())).toThrow(/TangentProvider/);
  });
});
