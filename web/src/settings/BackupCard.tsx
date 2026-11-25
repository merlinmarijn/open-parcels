import type { ReactNode } from "react";
import { useBackupNow, useBackups } from "../api/queries";
import { ErrorNotice, Spinner } from "../components/ui";
import { t } from "../i18n";
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
      <h2 id="settings-backups">{t.settings.backups.title}</h2>
      <ErrorNotice error={backups.error ?? backUp.error} />
      {data === undefined ? (
        <Spinner />
      ) : (
        <>
          <p className="muted">
            {data.interval_hours === 0
              ? t.settings.backups.off
              : t.settings.backups.schedule(data.interval_hours, formatRelative(data.next_at))}{" "}
            {t.settings.backups.keptIn(data.keep)} <code>{data.directory}</code>
            {t.settings.backups.keyNote}
          </p>
          {last === null ? (
            <p>{t.settings.backups.none}</p>
          ) : (
            <div role="status">
              <span className={`badge ${last.ok ? "check-ok" : "check-unavailable"}`}>
                {last.ok ? t.settings.backups.lastOk : t.settings.backups.lastFailed}
              </span>{" "}
              <span className="muted">
                {formatDateTime(last.at)}
                {last.ok && last.bytes !== null ? `, ${formatBytes(last.bytes)}` : ""}
              </span>
              {last.error === null ? null : (
                <div className="muted">{t.admin.backupErrors[last.error]}</div>
              )}
            </div>
          )}
          {data.files.length === 0 ? null : (
            <div className="card-table-scroll">
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
            </div>
          )}
          {data.files.length > LISTED ? (
            <p className="muted">{t.settings.backups.older(data.files.length - LISTED)}</p>
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
          {backUp.isPending ? t.settings.backups.backingUp : t.settings.backups.backUpNow}
        </button>
      </div>
    </section>
  );
}
