import type { Kysely, Selectable } from "kysely";
import { addMs, isoNow, type Clock } from "../clock.js";
import type { Database, LoginTable } from "../db/schema.js";
import { randomSecret, sha256Hex } from "./crypto.js";
import { parseRole, type Role } from "./store.js";

/** Access tokens are short-lived: a leaked one is useless within minutes. */
export const ACCESS_TTL_MS = 15 * 60 * 1000;
/** A login ends when it is not refreshed for this long; every refresh extends it. */
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** "Last used" is written at most once a minute, not on every request. */
const TOUCH_MS = 60 * 1000;
export const ACCESS_PREFIX = "opa_";
const REFRESH_PREFIX = "opr_";

export interface LoginInfo {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
}

export interface IssuedTokens {
  readonly accessToken: string;
  readonly accessExpiresAt: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: string;
  readonly login: LoginInfo;
}

function toInfo(row: Selectable<LoginTable>): LoginInfo {
  return {
    id: row.id,
    name: row.name,
    role: parseRole(row.role),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.refresh_expires_at,
  };
}

/**
 * Token logins of clients without cookies (decision record 0003 §6): logging in with a password
 * gives a short-lived access token and a refresh token. Refreshing replaces both (rotation); the
 * replaced refresh token presented again means a copy is in other hands, so the login ends. Only
 * SHA-256 hashes are stored.
 */
export class LoginStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
  ) {}

  async create(name: string, role: Role): Promise<IssuedTokens> {
    const now = isoNow(this.clock);
    const id = crypto.randomUUID();
    const tokens = this.#newTokens();
    await this.db
      .insertInto("logins")
      .values({
        id,
        name,
        role,
        access_hash: sha256Hex(tokens.accessToken),
        access_expires_at: tokens.accessExpiresAt,
        refresh_hash: sha256Hex(tokens.refreshToken),
        previous_refresh_hash: null,
        refresh_expires_at: tokens.refreshExpiresAt,
        created_at: now,
        last_used_at: now,
      })
      .execute();
    return {
      ...tokens,
      login: {
        id,
        name,
        role,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: tokens.refreshExpiresAt,
      },
    };
  }

  /**
   * New tokens for a refresh token; undefined when it is unknown or expired. A refresh token
   * already replaced ends its login and is refused.
   */
  async refresh(refreshToken: string): Promise<IssuedTokens | undefined> {
    if (!refreshToken.startsWith(REFRESH_PREFIX)) return undefined;
    const hash = sha256Hex(refreshToken);
    const reused = await this.db
      .deleteFrom("logins")
      .where("previous_refresh_hash", "=", hash)
      .executeTakeFirst();
    if (reused.numDeletedRows > 0n) return undefined;
    const row = await this.db
      .selectFrom("logins")
      .selectAll()
      .where("refresh_hash", "=", hash)
      .executeTakeFirst();
    if (row === undefined || row.refresh_expires_at <= isoNow(this.clock)) return undefined;
    const tokens = this.#newTokens();
    const now = isoNow(this.clock);
    await this.db
      .updateTable("logins")
      .set({
        access_hash: sha256Hex(tokens.accessToken),
        access_expires_at: tokens.accessExpiresAt,
        refresh_hash: sha256Hex(tokens.refreshToken),
        previous_refresh_hash: hash,
        refresh_expires_at: tokens.refreshExpiresAt,
        last_used_at: now,
      })
      .where("id", "=", row.id)
      .execute();
    return {
      ...tokens,
      login: toInfo({
        ...row,
        last_used_at: now,
        refresh_expires_at: tokens.refreshExpiresAt,
      }),
    };
  }

  /** The login an access token belongs to while the token is valid, recording the use. */
  async findByAccess(accessToken: string): Promise<LoginInfo | undefined> {
    const row = await this.#rowByAccess(accessToken);
    if (row === undefined || row.access_expires_at <= isoNow(this.clock)) return undefined;
    const now = this.clock.now();
    if (now.getTime() - Date.parse(row.last_used_at) >= TOUCH_MS) {
      await this.db
        .updateTable("logins")
        .set({ last_used_at: now.toISOString() })
        .where("id", "=", row.id)
        .execute();
    }
    return toInfo(row);
  }

  /** Whether a login still exists and has not run out (the event stream's check). */
  async alive(id: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("logins")
      .select("refresh_expires_at")
      .where("id", "=", id)
      .executeTakeFirst();
    return row !== undefined && row.refresh_expires_at > isoNow(this.clock);
  }

  async #rowByAccess(accessToken: string): Promise<Selectable<LoginTable> | undefined> {
    if (!accessToken.startsWith(ACCESS_PREFIX)) return undefined;
    return this.db
      .selectFrom("logins")
      .selectAll()
      .where("access_hash", "=", sha256Hex(accessToken))
      .executeTakeFirst();
  }

  /** Ends the login of a refresh token (log out); false when it is unknown. */
  async endByRefresh(refreshToken: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("logins")
      .where("refresh_hash", "=", sha256Hex(refreshToken))
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async list(): Promise<LoginInfo[]> {
    const rows = await this.db
      .selectFrom("logins")
      .selectAll()
      .where("refresh_expires_at", ">", isoNow(this.clock))
      .orderBy("created_at")
      .execute();
    return rows.map(toInfo);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom("logins").where("id", "=", id).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** After a password change: every login (or only the reader's) logs in again. */
  async deleteAll(role?: Role): Promise<void> {
    let query = this.db.deleteFrom("logins");
    if (role !== undefined) query = query.where("role", "=", role);
    await query.execute();
  }

  async pruneExpired(): Promise<number> {
    const result = await this.db
      .deleteFrom("logins")
      .where("refresh_expires_at", "<=", isoNow(this.clock))
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  #newTokens(): Omit<IssuedTokens, "login"> {
    const now = this.clock.now();
    return {
      accessToken: `${ACCESS_PREFIX}${randomSecret()}`,
      accessExpiresAt: addMs(now, ACCESS_TTL_MS).toISOString(),
      refreshToken: `${REFRESH_PREFIX}${randomSecret()}`,
      refreshExpiresAt: addMs(now, REFRESH_TTL_MS).toISOString(),
    };
  }
}
