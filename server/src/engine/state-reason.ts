/**
 * Why a connection is in its state, as a code: clients show their own text for each (the web UI in
 * English and German). Words a provider or carrier wrote travel separately as `carrier_message`.
 */
export const STATE_REASONS = [
  /** Added or re-enabled; no run has judged it yet. */
  "not_run_yet",
  /** A run found no stored sign-in. */
  "not_signed_in_yet",
  /** The carrier refused the stored sign-in. */
  "sign_in_rejected",
  /** The stored sign-in could not be decrypted (the encryption key changed). */
  "sign_in_unreadable",
  /** Imported from Home Assistant without a sign-in that can be carried over. */
  "imported_without_sign_in",
  /** The carrier asked for a pause. */
  "rate_limited",
  /** The carrier showed a captcha; paused for six hours. */
  "captcha",
  /** The connection's settings are invalid; `carrier_message` says what the provider found. */
  "invalid_config",
  /** The connection's provider is not installed. */
  "provider_missing",
  /** The last update failed and is retried; `carrier_message` may say what broke. */
  "update_failed",
  /** The provider chose to do nothing (state `idle`); `carrier_message` says why. */
  "provider_idle",
  /** An inbox's mail server refused the password. */
  "inbox_sign_in_rejected",
  /** An inbox's stored settings could not be read. */
  "inbox_settings_invalid",
  /** An inbox's mail server could not be reached; retried. */
  "inbox_unreachable",
] as const;
export type StateReason = (typeof STATE_REASONS)[number];

/** A connection's state reason and the provider's or carrier's own words, when it sent some. */
export interface StateCause {
  readonly reason: StateReason | null;
  readonly carrierMessage: string | null;
}

export const NO_CAUSE: StateCause = { reason: null, carrierMessage: null };

export const cause = (reason: StateReason, carrierMessage: string | null = null): StateCause => ({
  reason,
  carrierMessage,
});
