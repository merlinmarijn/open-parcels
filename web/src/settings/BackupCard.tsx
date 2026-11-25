import type { ReactNode } from "react";
import { useBackupNow, useBackups } from "../api/queries";
import { ErrorNotice, Spinner } from "../components/ui";
import { formatBytes, formatDateTime, formatRelative } from "../lib/format";

/** How many kept backups the card lists; the rest are only counted. */
const LISTED = 5;

/**
 * Database backups: the schedule (changed with the Backups settings), the newest result, the
 * files kept and "Back up now". Restoring is a command-line step, described in the README.
 */
export function BackupCard(): ReactNode {
  const backups = useBackups();
  const backUp = useBackupNow();
  const data = backups.data;
  const last = data?.last ?? null;

  return (
    <section className="card stack" aria-labelledby="settings-backups">
      <h2 id="settings-backups">Backups</h2>
      <ErrorNotice error={backups.error ?? backUp.error} />
      {data === undefined ? (
        <Spinner />
      ) : (
        <>
          <p className="muted">
            {data.interval_hours === 0
              ? "Automatic backups are off."
              : `A backup every ${String(data.interval_hours)} hours, next ${formatRelative(data.next_at)}.`}{" "}
            The newest {String(data.keep)} are kept in <code>{data.directory}</code>. The encryption
            key is not part of a backup; keep a copy of it as well.
          </p>
          {last === null ? (
            <p>No backup yet.</p>
          ) : (
            <div role="status">
              <span className={`badge ${last.ok ? "check-ok" : "check-unavailable"}`}>
                {last.ok ? "Last backup succeeded" : "Last backup failed"}
              </span>{" "}
              <span className="muted">
                {formatDateTime(last.at)}
                {last.ok && last.bytes !== null ? `, ${formatBytes(last.bytes)}` : ""}
              </span>
              {last.error === null ? null : <div className="muted">{last.error}</div>}
            </div>
          )}
          {data.files.length === 0 ? null : (
            <table className="data-table">
              <tbody>
                {data.files.slice(0, LISTED).map((file) => (
                  <tr key={file.name}>
                    <th scope="row">
                      <code>{file.name}</code>
                    </th>
                    <td>{formatDateTime(file.created_at)}</td>
                    <td>{formatBytes(file.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.files.length > LISTED ? (
            <p className="muted">and {String(data.files.length - LISTED)} older.</p>
          ) : null}
        </>
      )}
      <div className="actions">
        <button
          type="button"
          className="button small"
          disabled={backUp.isPending}
          onClick={() => {
            backUp.mutate();
          }}
        >
          {backUp.isPending ? "Backing up…" : "Back up now"}
        </button>
      </div>
    </section>
  );
}
