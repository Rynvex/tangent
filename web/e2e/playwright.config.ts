import { defineConfig, devices } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

/**
 * Three projects:
 * - `mock`: the demo in mock mode on a free port of its own (never a stale dev server).
 * - `api`: the reference server (fake runner, fresh `tangent_e2e` database,
 *   random tokens, a free port) behind the demo in HTTP mode on another free
 *   port. `E2E_ONLY=mock` or `E2E_ONLY=api` starts only that side.
 * - `api-core` (F3): a second server with TANGENT_FEATURES=none and its own
 *   demo, for the "only the core" feature set; it runs with `api`.
 *
 * Ports and tokens are chosen once and kept in the environment, so the test
 * workers (which load this file again) see the same values.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no free port"))));
    });
  });
}

async function once(name: string, make: () => Promise<string> | string): Promise<string> {
  const value = process.env[name] ?? (await make());
  process.env[name] = value;
  return value;
}

const token = () => randomBytes(24).toString("hex");
const apiPort = await once("TANGENT_E2E_API_PORT", async () => String(await freePort()));
const demoPort = await once("TANGENT_E2E_DEMO_PORT", async () => String(await freePort()));
const mockPort = await once("TANGENT_E2E_MOCK_PORT", async () => String(await freePort()));
const coreApiPort = await once("TANGENT_E2E_CORE_API_PORT", async () => String(await freePort()));
const coreDemoPort = await once("TANGENT_E2E_CORE_DEMO_PORT", async () => String(await freePort()));
const operatorToken = await once("TANGENT_E2E_TOKEN", token);
const viewerToken = await once("TANGENT_E2E_VIEWER_TOKEN", token);
const only = process.env.E2E_ONLY;

interface WebServer {
  command: string;
  url: string;
  reuseExistingServer: boolean;
  env: Record<string, string>;
  timeout: number;
}

const mockServer: WebServer = {
  command: `pnpm --filter @tangent/demo exec vite --port ${mockPort} --strictPort`,
  url: `http://localhost:${mockPort}`,
  reuseExistingServer: false,
  env: { VITE_TANGENT_API: "mock" },
  timeout: 60_000,
};

/** A reference server and the demo in HTTP mode in front of it; both runs' databases are kept by either cleanup. */
function serverPair(port: string, demo: string, extra: Record<string, string> = {}): WebServer[] {
  return [
    {
      command: "bash scripts/start-api.sh",
      url: `http://127.0.0.1:${port}/health`,
      reuseExistingServer: false,
      // The viewer token takes effect once the server reads TANGENT_VIEWER_TOKEN (B4.1).
      env: { TANGENT_E2E_API_PORT: port, TANGENT_E2E_KEEP_PORTS: `${apiPort} ${coreApiPort}`, TANGENT_TOKEN: operatorToken, TANGENT_VIEWER_TOKEN: viewerToken, ...extra },
      timeout: 180_000,
    },
    {
      command: `pnpm --filter @tangent/demo exec vite --port ${demo} --strictPort`,
      url: `http://localhost:${demo}`,
      reuseExistingServer: false,
      env: {
        VITE_TANGENT_API: "http",
        TANGENT_API_PROXY: `http://127.0.0.1:${port}`,
        TANGENT_API_TOKEN: operatorToken,
        TANGENT_API_VIEWER_TOKEN: viewerToken,
      },
      timeout: 60_000,
    },
  ];
}

/**
 * The reference server's default features (cmd/tangent-server defaultFeatures since B9 phase A: spinoff,
 * rebalance:suggest, goal:suggest, relations:suggest and open_loops included), plus fisheye (off by default
 * on the server; F5 phase 2 shows it), group:suggest (C2, F5 phase 3), ibis:suggest, fold:suggest, diverge and memory:suggest
 * (F6; memory with the fake Embedder) and the test-only suggestion probe,
 * for the inbox's generic accept / dismiss (F4).
 */
const API_FEATURES =
  "notes,chapters,aside,summary:suggest,card_draft,branch_suggest:suggest,glossary,search,leaf:suggest,parking,spinoff,rebalance:suggest,goal:suggest,relations:suggest,open_loops,fisheye,group:suggest,ibis:suggest,fold:suggest,diverge,memory:suggest,suggestion_probe";
const apiServers: WebServer[] = [...serverPair(apiPort, demoPort, { TANGENT_FEATURES: API_FEATURES, TANGENT_EMBEDDER: "fake" }), ...serverPair(coreApiPort, coreDemoPort, { TANGENT_FEATURES: "none" })];

export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    locale: "zh-TW",
    timezoneId: "Asia/Taipei",
    trace: "retain-on-failure",
  },
  projects: [
    ...(only === "api" ? [] : [{ name: "mock", use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${mockPort}` } }]),
    ...(only === "mock"
      ? []
      : [
          { name: "api", testMatch: /tests\/(conversation|branches|structure|notes|settings|features|embed|search|p1|p2|f5|f5-c2|f6|f7)\.spec\.ts$/, use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${demoPort}` } },
          { name: "api-core", testMatch: /tests\/(features|search|p1|p2|f5|f5-c2|f6|f7)\.spec\.ts$/, use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${coreDemoPort}` } },
        ]),
  ],
  webServer: [...(only === "api" ? [] : [mockServer]), ...(only === "mock" ? [] : apiServers)],
});
