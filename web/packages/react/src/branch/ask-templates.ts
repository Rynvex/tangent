import { askSubject, classifyExcerpt, prefillPurpose, askPurposeHead, type AskTemplateGroup, type AskTemplateId } from "@tangent/client";
import type { MessageKey, Translate } from "../i18n/types";

interface AskKeys {
  label: MessageKey;
  question: MessageKey;
  /** None for `general`: its purpose is the question's start. */
  purpose?: MessageKey;
}

const ASK_KEYS: { readonly [G in AskTemplateGroup]: Readonly<Record<string, AskKeys>> } = {
  term: {
    explain: { label: "ask.term.explain", question: "ask.term.explain.q", purpose: "ask.term.explain.p" },
    use: { label: "ask.term.use", question: "ask.term.use.q", purpose: "ask.term.use.p" },
    principle: { label: "ask.term.principle", question: "ask.term.principle.q", purpose: "ask.term.principle.p" },
    compare: { label: "ask.term.compare", question: "ask.term.compare.q", purpose: "ask.term.compare.p" },
  },
  sentence: {
    why: { label: "ask.sentence.why", question: "ask.sentence.why.q", purpose: "ask.sentence.why.p" },
    example: { label: "ask.sentence.example", question: "ask.sentence.example.q", purpose: "ask.sentence.example.p" },
    challenge: { label: "ask.sentence.challenge", question: "ask.sentence.challenge.q", purpose: "ask.sentence.challenge.p" },
    apply: { label: "ask.sentence.apply", question: "ask.sentence.apply.q", purpose: "ask.sentence.apply.p" },
  },
  general: {
    detail: { label: "ask.general.detail", question: "ask.general.detail.q" },
    example: { label: "ask.general.example", question: "ask.general.example.q" },
    challenge: { label: "ask.general.challenge", question: "ask.general.challenge.q" },
    alternatives: { label: "ask.general.alternatives", question: "ask.general.alternatives.q" },
  },
};

export interface AskDraft {
  question: string;
  purpose: string;
}

/** A template's chip label. */
export function askLabel(t: Translate, group: AskTemplateGroup, id: AskTemplateId): string {
  const keys = ASK_KEYS[group][id];
  return keys ? t(keys.label) : id;
}

/** The first question and the branch purpose a template makes of the selected text (F10 §2). */
export function askDraft(t: Translate, group: AskTemplateGroup, id: AskTemplateId, text: string): AskDraft {
  const keys = ASK_KEYS[group][id];
  if (!keys) return { question: "", purpose: "" };
  const subject = askSubject(text);
  const question = t(keys.question, { subject });
  return { question, purpose: keys.purpose ? t(keys.purpose, { subject, head: askPurposeHead(subject) }) : prefillPurpose(question) };
}

/** ⚡ 秒問解釋: the default question for a selection, no dialog. */
export function quickAskDraft(t: Translate, text: string): AskDraft {
  const group = classifyExcerpt(text);
  return askDraft(t, group, group === "term" ? "explain" : "why", text);
}
