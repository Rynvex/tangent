import { termInputProblem, type TermInputProblem, type TermLimits } from "@tangent/client";
import { TextArea, TextField } from "../components/text-field";
import { useGlossaryT } from "../i18n/glossary-messages";

export interface TermDraft {
  term: string;
  explanation: string;
}

export interface TermFieldsProps {
  value: TermDraft;
  onChange: (value: TermDraft) => void;
  limits: TermLimits;
  /** Empty fields are only said once a save was tried; a text over its limit is said at once. */
  tried: boolean;
  /** The term is fixed (an overwrite keeps the stored spelling). */
  termReadOnly?: boolean;
  rows?: number;
}

/** What `problem` says under `field`, or null. */
function fieldError(problem: TermInputProblem | null, field: "term" | "explanation", tried: boolean, t: ReturnType<typeof useGlossaryT>): string | null {
  if (!problem || problem.field !== field) return null;
  if (problem.kind === "tooLong") return t("glossary.tooLong", { max: problem.max });
  return tried ? t(field === "term" ? "glossary.termEmpty" : "glossary.explanationEmpty") : null;
}

/** 名詞 and 解釋, with the server's limits checked as they are typed. */
export function TermFields({ value, onChange, limits, tried, termReadOnly = false, rows = 6 }: TermFieldsProps) {
  const t = useGlossaryT();
  const problem = termInputProblem(value, limits);
  return (
    <>
      <TextField label={t("glossary.term")} value={value.term} readOnly={termReadOnly} error={fieldError(problem, "term", tried, t)} onChange={(event) => onChange({ ...value, term: event.target.value })} />
      <TextArea label={t("glossary.explanation")} rows={rows} value={value.explanation} error={fieldError(problem, "explanation", tried, t)} onChange={(event) => onChange({ ...value, explanation: event.target.value })} />
    </>
  );
}
