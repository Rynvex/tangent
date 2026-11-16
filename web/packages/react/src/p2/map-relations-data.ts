import { isFeatureOn, type Link } from "@tangent/client";
import { useMemo } from "react";
import { describeError } from "../conversation/error-text";
import { useReadOnly } from "../data/live-hooks";
import { useAcceptSuggestion, useDismissSuggestion, useSuggestions } from "../data/p1-hooks";
import { useCreateRelation, useDeleteRelation, useRelations, useUpdateRelation } from "../data/p2-hooks";
import { useCapabilities } from "../data/queries";
import { useP2T } from "../i18n/p2-messages";
import { useTangent } from "../provider";
import type { MapRelationsProps } from "../structure/relation-layer";
import { farEnd, useLineNames } from "./line-names";

/**
 * The branch map's relation layer fed from the server (C3): the tree's
 * relations, AI's open relation suggestions, and the writes. Undefined while
 * the relations feature is off (the map then has no layer at all).
 */
export function useMapRelationsData(rootLineId: string): MapRelationsProps | undefined {
  const t = useP2T();
  const { hostErrorText } = useTangent();
  const capabilities = useCapabilities();
  const readOnly = useReadOnly();
  const on = isFeatureOn(capabilities.data, "relations");
  const relations = useRelations(rootLineId, on);
  const suggestions = useSuggestions(rootLineId, on && isFeatureOn(capabilities.data, "suggestions"));
  const create = useCreateRelation(rootLineId);
  const remove = useDeleteRelation(rootLineId);
  const { inTree } = useLineNames(rootLineId);
  const update = useUpdateRelation(rootLineId);
  const accept = useAcceptSuggestion(rootLineId);
  const dismiss = useDismissSuggestion(rootLineId);
  const list = relations.data?.relations;
  const open = suggestions.data?.suggestions;
  return useMemo(() => {
    if (!on) return undefined;
    const recreate = (link: Link) =>
      create.mutateAsync({
        fromLineId: link.fromLineId,
        ...(link.fromMessageId ? { fromMessageId: link.fromMessageId } : {}),
        toLineId: link.toLineId,
        ...(link.toMessageId ? { toMessageId: link.toMessageId } : {}),
        ...(link.label ? { label: link.label } : {}),
      });
    return {
      relations: list ?? [],
      suggestions: open ?? [],
      readOnly,
      onCreate: async (fromLineId, toLineId) => (await create.mutateAsync({ fromLineId, toLineId })).relation,
      onUpdateLabel: (relation, label) => update.mutateAsync({ relationId: relation.id, label }),
      onDelete: (link) => {
        const far = farEnd(link, inTree);
        return remove.mutateAsync({ relationId: link.id, ...(far ? { otherLineId: far } : {}) });
      },
      onUndoDelete: recreate,
      onAccept: (suggestion) => accept.mutateAsync({ suggestionId: suggestion.id }),
      onDismiss: (suggestion) => dismiss.mutateAsync({ suggestionId: suggestion.id }),
      describeFailure: (error) => t("relation.failed", { reason: describeError(error, t, hostErrorText) }),
    } satisfies MapRelationsProps;
    // The mutations' functions are stable; only the data and the switches change what the map shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, list, open, readOnly, t, hostErrorText, inTree]);
}
