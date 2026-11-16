import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * How a conversation is shown, as the reader set it (a host's settings
 * page). The defaults are the components' long-standing behaviour.
 */
export interface ConversationOptions {
  /** Message times with AM / PM instead of the 24-hour clock. */
  hour12: boolean;
  /** Off: a reply shows only its progress until it is finished, never its words as they arrive. */
  streamText: boolean;
  /** Conclusion cards start with their details open. */
  expandCards: boolean;
}

export const DEFAULT_CONVERSATION_OPTIONS: ConversationOptions = Object.freeze({ hour12: false, streamText: true, expandCards: false });

const ConversationOptionsContext = createContext<ConversationOptions>(DEFAULT_CONVERSATION_OPTIONS);

export interface ConversationOptionsProviderProps extends Partial<ConversationOptions> {
  children: ReactNode;
}

/** Sets the conversation options for everything below; anything left out keeps the default. */
export function ConversationOptionsProvider({ hour12 = false, streamText = true, expandCards = false, children }: ConversationOptionsProviderProps) {
  const value = useMemo(() => ({ hour12, streamText, expandCards }), [hour12, streamText, expandCards]);
  return <ConversationOptionsContext.Provider value={value}>{children}</ConversationOptionsContext.Provider>;
}

export function useConversationOptions(): ConversationOptions {
  return useContext(ConversationOptionsContext);
}
