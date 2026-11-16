import { Field } from "@base-ui/react/field";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "../lib/cx";

/**
 * The edge, fill and states every form control shares. The edge uses
 * `--tg-border-input` (≥ 3:1, review §2 #1), never the decorative borders.
 */
export const INPUT_SURFACE =
  "w-full rounded-tg-sm border border-tg-border-input bg-tg-surface text-tg-sm text-tg-foreground placeholder:text-tg-subtle " +
  "transition-colors duration-(--tg-duration-fast) " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-tg-ring " +
  "data-invalid:border-tg-destructive aria-invalid:border-tg-destructive " +
  "disabled:cursor-not-allowed disabled:opacity-45";

interface FieldFrameProps {
  label?: ReactNode;
  description?: ReactNode;
  /** A validation message; marks the control invalid and is announced with it. */
  error?: ReactNode;
  className?: string;
  disabled?: boolean | undefined;
  children: ReactNode;
}

function FieldFrame({ label, description, error, className, disabled, children }: FieldFrameProps) {
  return (
    <Field.Root invalid={Boolean(error)} disabled={disabled} className={cx("flex flex-col gap-1.5", className)}>
      {label && <Field.Label className="text-tg-sm font-medium text-tg-foreground">{label}</Field.Label>}
      {children}
      {description && <Field.Description className="m-0 text-tg-xs text-tg-muted">{description}</Field.Description>}
      {error && (
        <Field.Error match className="m-0 text-tg-xs text-tg-destructive">
          {error}
        </Field.Error>
      )}
    </Field.Root>
  );
}

export interface TextFieldProps extends Omit<ComponentPropsWithRef<"input">, "className"> {
  label?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  className?: string;
  inputClassName?: string;
}

/** A labelled single-line input (Base UI Field + Input): label, description and error are wired by id. */
export function TextField({ label, description, error, className, inputClassName, disabled, ...rest }: TextFieldProps) {
  return (
    <FieldFrame label={label} description={description} error={error} className={className} disabled={disabled}>
      <Field.Control {...rest} className={cx(INPUT_SURFACE, "h-(--tg-control-height) px-2.5", inputClassName)} />
    </FieldFrame>
  );
}

export interface TextAreaProps extends Omit<ComponentPropsWithRef<"textarea">, "className"> {
  label?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  className?: string;
  inputClassName?: string;
}

/** A labelled multi-line input; same wiring as TextField. */
export function TextArea({ label, description, error, className, inputClassName, disabled, rows = 3, ...rest }: TextAreaProps) {
  return (
    <FieldFrame label={label} description={description} error={error} className={className} disabled={disabled}>
      <Field.Control render={<textarea rows={rows} {...rest} />} className={cx(INPUT_SURFACE, "resize-y px-2.5 py-2 leading-normal", inputClassName)} />
    </FieldFrame>
  );
}
