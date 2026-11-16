/**
 * F16.2: the analysis as the preview's nodes read it (threaded rounds, the
 * reason, moving a round, where a branch hangs); null before any analysis,
 * so the preview looks as it did in F16.1.
 */
import { createContext, useContext } from "react";
import type { AiTreeView } from "./use-ai-tree";

export const AiTreeContext = createContext<AiTreeView | null>(null);

export const useAiTreeView = (): AiTreeView | null => useContext(AiTreeContext);
