import { ExternalLink } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useJobControl, useStartAction } from "../api/queries";
import type { CarrierAction, Connection, Job, JobState } from "../api/types";
import { Dialog, ErrorNotice } from "../components/ui";
import { t } from "../i18n";
import { formatRelative } from "../lib/format";
import { formatNumber } from "../lib/locale";
import { SchemaFields } from "./SchemaForm";
import { asSchema, cleanValues, initialValues, type FormValues } from "./schema";

/**
 * A connection card's actions and its newest job (`docs/connection-actions-and-jobs.md` §5):
 * tasks as buttons, links as outbound links, and the job's state, progress and controls.
 */

const ACTIVE: readonly JobState[] = ["queued", "running", "paused"];
const RESUMABLE: readonly JobState[] = ["paused", "failed", "partial", "cancelled"];

/** Asks what the action's `confirm` says, and the label for a destructive one. */
function confirmed(action: CarrierAction, connection: Connection): boolean {
  if (action.confirm !== null && !window.confirm(action.confirm)) return false;
  if (!action.destructive) return true;
  return window.prompt(t.jobs.confirmDestructive(connection.label)) === connection.label;
}

/** The input form of a task that takes input; starts it on submit. */
function InputDialog(props: {
  readonly action: CarrierAction;
  readonly pending: boolean;
  readonly onStart: (input: FormValues) => void;
  readonly onClose: () => void;
}): ReactNode {
  const schema = asSchema(props.action.input_schema);
  const [values, setValues] = useState<FormValues>(() => initialValues(schema, undefined));
  return (
    <Dialog title={t.jobs.inputTitle(props.action.label)} open onClose={props.onClose}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          props.onStart(cleanValues(schema, values));
        }}
      >
        {props.action.description === null ? null : (
          <p className="muted">{props.action.description}</p>
        )}
        <SchemaFields schema={schema} values={values} onChange={setValues} />
        {props.action.confirm === null ? null : <p>{props.action.confirm}</p>}
        <div className="actions">
          <button type="button" className="button" onClick={props.onClose}>
            {t.jobs.close}
          </button>
          <button type="submit" className="button primary" disabled={props.pending}>
            {t.jobs.startButton}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function JobPanel(props: {
  readonly job: Job;
  readonly label: string;
  readonly admin: boolean;
}): ReactNode {
  const { job } = props;
  const control = useJobControl();
  const { done, total, phase } = job.progress;
  const reason = job.reason === null ? undefined : t.jobs.reasons[job.reason];
  return (
    <div className="connection-job" aria-live="polite">
      <div className="connection-job-head">
        <strong>{props.label}</strong>
        <span className="badge">{t.jobs.state[job.state]}</span>
      </div>
      {total !== null && total > 0 ? (
        <progress value={done ?? 0} max={total} aria-label={t.jobs.state[job.state]} />
      ) : null}
      <p className="muted">
        {[
          total !== null && done !== null
            ? t.jobs.progress(formatNumber(done), formatNumber(total))
            : done === null
              ? null
              : t.jobs.progressDone(formatNumber(done)),
          phase,
          job.summary,
          reason,
          job.resume_at === null ? null : t.jobs.resumesAt(formatRelative(job.resume_at)),
        ]
          .filter((part) => part !== null && part !== undefined && part !== "")
          .join(" · ")}
      </p>
      <ErrorNotice error={control.error} />
      {props.admin ? (
        <div className="actions">
          {ACTIVE.includes(job.state) ? (
            <button
              type="button"
              className="button small"
              disabled={control.isPending}
              onClick={() => {
                control.mutate({ id: job.id, control: "cancel" });
              }}
            >
              {t.jobs.cancel}
            </button>
          ) : null}
          {RESUMABLE.includes(job.state) ? (
            <button
              type="button"
              className="button small"
              disabled={control.isPending}
              onClick={() => {
                control.mutate({ id: job.id, control: "resume" });
              }}
            >
              {t.jobs.resume}
            </button>
          ) : null}
          {ACTIVE.includes(job.state) && job.state !== "paused" ? null : (
            <button
              type="button"
              className="button small"
              disabled={control.isPending}
              onClick={() => {
                if (window.confirm(t.jobs.restartQuestion)) {
                  control.mutate({ id: job.id, control: "restart" });
                }
              }}
            >
              {t.jobs.restart}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ConnectionJobs(props: {
  readonly connection: Connection;
  readonly actions: readonly CarrierAction[];
  /** The connection's newest job, if it has one. */
  readonly job: Job | undefined;
  readonly admin: boolean;
}): ReactNode {
  const { connection, job } = props;
  const start = useStartAction();
  const [asking, setAsking] = useState<CarrierAction | null>(null);
  const actions = props.actions.filter((action) =>
    (action.connection_kinds as readonly string[]).includes(connection.kind),
  );
  const busy = job !== undefined && ACTIVE.includes(job.state);
  const run = (action: CarrierAction, input?: FormValues): void => {
    start.mutate(
      { connectionId: connection.id, action: action.id, ...(input === undefined ? {} : { input }) },
      {
        onSuccess: (answer) => {
          setAsking(null);
          if ("url" in answer) window.open(answer.url, "_blank", "noopener,noreferrer");
        },
      },
    );
  };
  if (actions.length === 0 && job === undefined) return null;
  return (
    <section className="connection-jobs" aria-label={t.jobs.actions}>
      {job === undefined ? null : (
        <JobPanel
          job={job}
          label={props.actions.find((action) => action.id === job.action)?.label ?? job.action}
          admin={props.admin}
        />
      )}
      {props.admin && actions.length > 0 ? (
        <>
          <ErrorNotice error={start.error} />
          <div className="actions">
            {actions.map((action) => {
              const allowed =
                connection.state !== "disabled" &&
                (action.when_state as readonly string[]).includes(connection.state);
              return (
                <button
                  key={action.id}
                  type="button"
                  className="button small"
                  title={action.description ?? undefined}
                  disabled={start.isPending || !allowed || (action.kind === "task" && busy)}
                  onClick={() => {
                    if (action.kind === "link") {
                      run(action);
                    } else if (action.input_schema !== null) {
                      setAsking(action);
                    } else if (confirmed(action, connection)) {
                      run(action);
                    }
                  }}
                >
                  {action.kind === "link" ? (
                    <>
                      {action.label} <ExternalLink size={14} aria-hidden="true" />
                    </>
                  ) : (
                    t.jobs.start(action.label)
                  )}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
      {asking === null ? null : (
        <InputDialog
          action={asking}
          pending={start.isPending}
          onClose={() => {
            setAsking(null);
          }}
          onStart={(input) => {
            if (!asking.destructive || confirmed({ ...asking, confirm: null }, connection)) {
              run(asking, input);
            }
          }}
        />
      )}
    </section>
  );
}
