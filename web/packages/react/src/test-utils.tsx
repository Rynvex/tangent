/** Test helper (not exported): a provider tree around a client, usually the mock one. */
import type { TangentClient } from "@tangent/client";
import { createMockTangentClient, type MockTangentClientOptions } from "@tangent/client/testing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { TangentProvider, type TangentProviderProps } from "./provider";

export function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
}

/** Instant mock with fast streaming, unless the test says otherwise. */
export function mockClient(options: MockTangentClientOptions = {}) {
  return createMockTangentClient({ latencyMs: 0, chunkMs: 5, ...options });
}

export function tangentWrapper(
  client: TangentClient,
  queryClient = testQueryClient(),
  props: Partial<Omit<TangentProviderProps, "client" | "children">> = {},
): (props: { children: ReactNode }) => ReactNode {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TangentProvider client={client} {...props}>
          {children}
        </TangentProvider>
      </QueryClientProvider>
    );
  };
}
