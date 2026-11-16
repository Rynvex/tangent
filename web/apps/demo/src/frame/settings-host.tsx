import type { TangentClient } from "@tangent/client";
import type { MockControls } from "@tangent/client/testing";
import { useLine, useTangent } from "@tangent/react";
import type { DemoParams } from "./params";
import { SettingsDialog } from "./settings-dialog";
import { featureSetSearch } from "./settings-model";

function mockControls(client: TangentClient): MockControls | null {
  return "mock" in client ? (client as TangentClient & { mock: MockControls }).mock : null;
}

export interface SettingsHostProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  params: DemoParams;
  lineId: string | null;
  /** Shows a conversation (Settings → Archive). */
  onSelect: (lineId: string) => void;
}

/**
 * The settings dialog wired to the demo (G2). The preferences live in their
 * stores (prefs.ts, model-prefs.ts), which the dialog writes and the frame
 * reads. Modes are the host's and only shown (DESIGN §12 F3); the mock can
 * switch between its feature sets and the settings' presets (F9 B.4), a
 * server only shows the line to restart with.
 */
export function SettingsHost({ open, onOpenChange, params, lineId, onSelect }: SettingsHostProps) {
  const { client } = useTangent();
  const line = useLine(lineId);
  const mock = mockControls(client);
  return (
    <SettingsDialog
      open={open}
      onOpenChange={onOpenChange}
      embedded={params.frame === "embed"}
      themeFromUrl={params.themeFromUrl}
      langFromUrl={new URLSearchParams(window.location.search).has("lang")}
      line={line.data ?? null}
      onOpenConversation={(id) => {
        onOpenChange(false);
        onSelect(id);
      }}
      {...(mock ? { featureSet: { value: params.features, onChange: (set) => window.location.assign(featureSetSearch(window.location.search, set)) } } : {})}
    />
  );
}
