import { BranchMap, Button, useBranches, useFocusT, useEscapeLayer, useGroupForm, useMapFisheye, useMainChapters, useMapGroups, useMapRelationsData, useMapTags, useMessages, useUiT } from "@tangent/react";
import type { Chapter } from "@tangent/client";
import { Columns2 } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Navigate } from "./branch-flows";

/** The map at full width, over the conversation column (A8 全幅); Esc or the toggle puts it back. */
export function MapOverlay({ rootLineId, lineId, navigate, onClose, onSideBySide }: { rootLineId: string; lineId: string; navigate: Navigate; onClose: () => void; onSideBySide?: () => void }) {
  const t = useUiT();
  const ft = useFocusT();
  const branches = useBranches(rootLineId, true);
  const main = useMessages(rootLineId);
  useEscapeLayer(true, onClose);
  const section = useRef<HTMLElement>(null);
  // The toggle that opened it is gone (the side panel only says the map is open): focus moves to the map.
  useEffect(() => section.current?.querySelector<HTMLElement>("[data-tg-map-canvas]")?.focus(), []);
  const mainCount = (main.data?.messages ?? []).filter((message) => message.kind === "chat" && message.role !== "system").length;
  // The relation layer (C3) while the relations feature is on.
  const relations = useMapRelationsData(rootLineId);
  // The 魚眼 layer (C1) while the fisheye feature is on.
  const fisheye = useMapFisheye(rootLineId, lineId);
  // The 群組 layer and multi-select (C2) while the group feature is on; a combined branch is entered.
  const form = useGroupForm(rootLineId, (result) => {
    if (!result.lineId) return;
    navigate(result.lineId);
    onClose();
  });
  const groups = useMapGroups(rootLineId, (mode, members) => form.open({ mode, members }));
  // The 論證類型 layer (D2) while the ibis feature is on.
  const tags = useMapTags();
  // F11 §3: the main line's stages under its node (the chapters feature); a stage goes there like a node does.
  const chapters = useMainChapters(rootLineId);
  return (
    <section ref={section} aria-label={t("map.label")} className="absolute inset-0 z-20 flex flex-col bg-tg-background p-3">
      <BranchMap
        // Selection, folds and layers belong to one conversation (R9 G1).
        key={rootLineId}
        branches={branches.data?.branches ?? []}
        rootLineId={rootLineId}
        currentLineId={lineId}
        mainCount={mainCount}
        onEnter={(target) => {
          navigate(target);
          onClose();
        }}
        onToggleFullscreen={onClose}
        fullscreen
        {...(relations ? { relations } : {})}
        {...(fisheye ? { fisheye } : {})}
        {...(groups ? { groups } : {})}
        {...(tags ? { tags } : {})}
        {...(chapters
          ? {
              chapters,
              onGoToChapter: (chapter: Chapter) => {
                navigate(rootLineId, chapter.startMessageId);
                onClose();
              },
            }
          : {})}
        // 和對話並排 (FOCUS_MODE.md §5): from here into focus mode.
        {...(onSideBySide
          ? {
              toolbar: (
                <Button size="sm" variant="ghost" icon={<Columns2 aria-hidden className="size-3.5" />} onClick={onSideBySide}>
                  {ft("map.sideBySide")}
                </Button>
              ),
            }
          : {})}
      />
      {form.dialog}
    </section>
  );
}
