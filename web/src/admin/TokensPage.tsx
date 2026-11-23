import { useRef, useState, type SyntheticEvent, type ReactNode } from "react";
import { useCreateToken, useRevokeToken, useTokens } from "../api/queries";
import type { ApiToken } from "../api/types";
import { useIsAdmin } from "../auth/session";
import { ErrorNotice, Field, ReadOnlyHint, Spinner } from "../components/ui";
import { formatDateTime, formatRelative } from "../lib/format";

type Scope = ApiToken["scopes"][number];
const SCOPES: readonly Scope[] = ["read", "write", "admin"];

function CreateToken(): ReactNode {
  const create = useCreateToken();
  const tokenRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [name, setName] = useState("");

  /**
   * The clipboard exists only in secure contexts (HTTPS or localhost); over plain HTTP on the LAN
   * the token is selected for a manual copy instead. Either way the user is told what happened.
   */
  async function copyToken(token: string): Promise<void> {
    if (window.isSecureContext && "clipboard" in navigator) {
      try {
        await navigator.clipboard.writeText(token);
        setCopied("Copied.");
        return;
      } catch {
        // Refused by the browser: fall through to selecting it for a manual copy.
      }
    }
    const code = tokenRef.current;
    if (code !== null) {
      window.getSelection()?.selectAllChildren(code);
    }
    setCopied("Copying is not available here: the token is selected, copy it by hand.");
  }
  const [scopes, setScopes] = useState<Scope[]>(["read"]);

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    create.mutate(
      { name: name.trim(), scopes },
      {
        onSuccess: () => {
          setName("");
        },
      },
    );
  };

  const toggle = (scope: Scope, on: boolean): void => {
    setScopes((current) => (on ? [...current, scope] : current.filter((s) => s !== scope)));
  };

  return (
    <section className="card" aria-labelledby="new-token-title">
      <h2 id="new-token-title">New token</h2>
      <form onSubmit={submit} className="stack">
        <Field label="Name" hint="What uses it, for example “Home Assistant”.">
          {(id, hint) => (
            <input
              id={id}
              aria-describedby={hint}
              required
              maxLength={80}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          )}
        </Field>
        <fieldset className="inline">
          <legend>Scopes</legend>
          {SCOPES.map((scope) => (
            <label key={scope} className="checkbox">
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={(e) => {
                  toggle(scope, e.target.checked);
                }}
              />
              {scope}
            </label>
          ))}
        </fieldset>
        <ErrorNotice error={create.error} />
        <div className="actions">
          <button
            type="submit"
            className="button primary"
            disabled={create.isPending || scopes.length === 0}
          >
            Create token
          </button>
        </div>
      </form>
      {create.data === undefined ? null : (
        <div className="notice token-value" role="status">
          <p>
            Copy the token now. It is shown <strong>only once</strong>.
          </p>
          {copied === null ? null : <p>{copied}</p>}
          <code className="mono" ref={tokenRef}>
            {create.data.token}
          </code>
          <div className="actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                void copyToken(create.data.token);
              }}
            >
              Copy
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                create.reset();
                setCopied(null);
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** API tokens are the admin's: readers see only a hint, and nothing is fetched. */
export function TokensPage(): ReactNode {
  const admin = useIsAdmin();
  return (
    <section aria-labelledby="tokens-title">
      <div className="page-header">
        <h1 id="tokens-title">API tokens</h1>
      </div>
      {admin ? <TokenList /> : <ReadOnlyHint>API tokens are for the admin only.</ReadOnlyHint>}
    </section>
  );
}

function TokenList(): ReactNode {
  const tokens = useTokens();
  const revoke = useRevokeToken();

  return (
    <>
      <CreateToken />
      <ErrorNotice error={tokens.error ?? revoke.error} />
      {tokens.data === undefined ? (
        <Spinner />
      ) : (
        <div className="table-scroll card">
          <table>
            <caption className="visually-hidden">API tokens</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Scopes</th>
                <th scope="col">Created</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tokens.data.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted empty">
                    No tokens yet.
                  </td>
                </tr>
              ) : null}
              {tokens.data.map((token) => (
                <tr key={token.id}>
                  <td>{token.name}</td>
                  <td>{token.scopes.join(", ")}</td>
                  <td>{formatDateTime(token.created_at)}</td>
                  <td>{formatRelative(token.last_used_at)}</td>
                  <td>
                    <button
                      type="button"
                      className="button danger"
                      onClick={() => {
                        if (window.confirm(`Revoke the token “${token.name}”?`)) {
                          revoke.mutate(token.id);
                        }
                      }}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
