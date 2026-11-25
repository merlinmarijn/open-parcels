import { useState, type SyntheticEvent, type ReactNode } from "react";
import type { SignInStep } from "../api/types";
import { Field } from "../components/ui";
import { OpenUrlStep } from "./OpenUrlStep";
import { t } from "../i18n";

export type StepInput = Record<string, string>;

interface StepProps<K extends SignInStep["kind"]> {
  readonly step: Extract<SignInStep, { kind: K }>;
  readonly busy: boolean;
  readonly onSubmit: (input: StepInput) => void;
}

function Message({ text }: { readonly text: string | undefined }): ReactNode {
  return text === undefined ? null : <p className="step-message">{text}</p>;
}

function Submit({
  busy,
  label = t.connections.continue,
}: {
  readonly busy: boolean;
  readonly label?: string;
}): ReactNode {
  return (
    <div className="actions">
      <button type="submit" className="button primary" disabled={busy}>
        {busy ? t.connections.working : label}
      </button>
    </div>
  );
}

/** Values live only in this component's state and are dropped once the step is answered. */
function FormStep({ step, busy, onSubmit }: StepProps<"form">): ReactNode {
  const [values, setValues] = useState<StepInput>({});
  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    onSubmit(values);
    setValues({});
  };
  return (
    <form onSubmit={submit} className="stack">
      <Message text={step.message} />
      {step.fields.map((field) => (
        <Field key={field.name} label={field.label}>
          {(id) => (
            <input
              id={id}
              type={field.type}
              required
              autoComplete={
                field.type === "password"
                  ? "current-password"
                  : field.type === "email"
                    ? "email"
                    : "off"
              }
              value={values[field.name] ?? ""}
              onChange={(e) => {
                setValues((current) => ({ ...current, [field.name]: e.target.value }));
              }}
            />
          )}
        </Field>
      ))}
      <Submit busy={busy} />
    </form>
  );
}

function CodeStep(props: {
  readonly intro: string;
  readonly label: string;
  readonly message: string | undefined;
  readonly busy: boolean;
  readonly onSubmit: (input: StepInput) => void;
  readonly otp: boolean;
}): ReactNode {
  const [code, setCode] = useState("");
  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    props.onSubmit({ code: code.trim() });
    setCode("");
  };
  return (
    <form onSubmit={submit} className="stack">
      <p>{props.intro}</p>
      <Message text={props.message} />
      <Field label={props.label}>
        {(id) => (
          <input
            id={id}
            required
            autoFocus
            autoComplete={props.otp ? "one-time-code" : "off"}
            inputMode={props.otp ? "numeric" : undefined}
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
            }}
          />
        )}
      </Field>
      <Submit busy={props.busy} />
    </form>
  );
}

function ChooseStep({ step, busy, onSubmit }: StepProps<"choose_method">): ReactNode {
  const [choice, setChoice] = useState(step.options[0]?.id ?? "");
  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    onSubmit({ choice });
  };
  return (
    <form onSubmit={submit} className="stack">
      <fieldset>
        <legend>{step.message ?? t.connections.howToSignIn}</legend>
        {step.options.map((option) => (
          <label key={option.id} className="checkbox">
            <input
              type="radio"
              name="sign-in-method"
              value={option.id}
              checked={choice === option.id}
              onChange={() => {
                setChoice(option.id);
              }}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <Submit busy={busy} />
    </form>
  );
}

function ApprovalStep({
  step,
}: {
  readonly step: Extract<SignInStep, { kind: "await_approval" }>;
}): ReactNode {
  return (
    <div className="stack" role="status" aria-live="polite">
      <p className="step-message">{step.message}</p>
      <p className="muted">
        <span className="pulse" aria-hidden="true" />{" "}
        {t.connections.waitingApproval(step.poll_interval_seconds)}
      </p>
    </div>
  );
}

/** Renders one step of an interactive sign-in. Input keys follow the API contract. */
export function StepRenderer(props: {
  readonly step: SignInStep;
  readonly busy: boolean;
  readonly onSubmit: (input: StepInput) => void;
}): ReactNode {
  const { step, busy, onSubmit } = props;
  switch (step.kind) {
    case "form":
      return <FormStep step={step} busy={busy} onSubmit={onSubmit} />;
    case "open_url":
      return <OpenUrlStep step={step} busy={busy} onSubmit={onSubmit} />;
    case "email_link":
      return (
        <CodeStep
          intro={t.connections.emailLinkIntro(step.destination)}
          label={t.connections.emailLinkLabel}
          message={step.message}
          busy={busy}
          onSubmit={onSubmit}
          otp={false}
        />
      );
    case "otp_code":
      return (
        <CodeStep
          intro={t.connections.otpIntro(step.channel, step.destination)}
          label={t.connections.code}
          message={step.message}
          busy={busy}
          onSubmit={onSubmit}
          otp
        />
      );
    case "choose_method":
      return <ChooseStep step={step} busy={busy} onSubmit={onSubmit} />;
    case "await_approval":
      return <ApprovalStep step={step} />;
  }
}
