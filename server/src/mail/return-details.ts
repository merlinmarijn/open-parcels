import { findCarrier, parseArrival, type Rules } from "open-parcels-rules";
import type { DropOffKind, DropOffOption, ReturnStatus } from "../domain/return.js";
import { unescapeHtml } from "../provider/kit/html.js";

/**
 * Readers for the details of return and refund mails that the shared mail rules do not extract
 * yet: the return-by day, drop-off options, cost, refund, label link, the shop's return id. They
 * read labelled lines ("Drop off by:", "Rückgabe bis:") in English and German, the languages of
 * the mails they were modelled on.
 */

/** The mail as trimmed, non-empty lines; HTML block ends become line breaks. */
export function mailLines(text: string | null, html: string | null): string[] {
  const source =
    text ??
    unescapeHtml(
      (html ?? "")
        .replace(/<(?:script|style)\b[^>]*>[^<]*<\/(?:script|style)>/gi, " ")
        .replace(/<(?:br|\/p|\/div|\/tr|\/li|\/h\d|\/td)\b[^>]*>/gi, "\n")
        .replace(/<[^>]*>/g, " "),
    );
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
}

/** What follows a label: the rest of its line, else the next line. */
function after(lines: readonly string[], label: RegExp): string | null {
  for (const [index, line] of lines.entries()) {
    const match = label.exec(line);
    if (match === null) continue;
    const rest = line
      .slice(match.index + match[0].length)
      .replace(/^\s*[:#*^]?\s*/, "")
      .trim();
    if (rest !== "") return rest;
    const next = lines[index + 1];
    if (next !== undefined) return next;
  }
  return null;
}

const RETURN_BY_LABEL =
  /\b(?:send by|drop off by|return by|ship by|rückgabe bis|abgabe bis|zurücksenden bis|rücksendung bis(?: zum)?)\b/i;
const RETURN_BY_INLINE =
  /\b(?:drop off your return by|return (?:it|the items?) by|rücksendung bis zum|bis zum)\s+([^.;]{3,40})/i;

/** The last day to hand the return in, as a local `YYYY-MM-DD` day. */
export function readReturnBy(
  rules: Rules,
  lines: readonly string[],
  received: Date,
  timeZone: string,
): string | null {
  const labelled = after(lines, RETURN_BY_LABEL);
  const inline = lines.map((line) => RETURN_BY_INLINE.exec(line)?.[1]).find((v) => v !== undefined);
  for (const text of [labelled, inline]) {
    if (text === null || text === undefined) continue;
    const window = parseArrival(rules, text, { now: received, timeZone });
    if (window !== null) return window.from.slice(0, 10);
  }
  return null;
}

const DROP_OFF_LABELS = [
  /\b(?:location|ort)\s*:/i,
  /\b(?:drop-off location|abgabestandort|abgabeort|return (?:dispatch|shipping) method|rücksendemethode|rücksendeoption)\b/i,
];

function dropOffKind(text: string): DropOffKind {
  if (/\b(?:any|beliebige[rn]?|jede[rn]?)\b/i.test(text)) return "any";
  if (/packstation|locker|paketautomat|parcel ?box|paketbox/i.test(text)) return "parcel_locker";
  if (/post ?office|postfiliale|filiale|postamt/i.test(text)) return "post_office";
  if (/pick ?up|abholung/i.test(text)) return "pickup";
  return "shop";
}

/** The carrier a drop-off text names: one or two words looked up in the shared carrier list. */
function namedCarrier(rules: Rules, text: string): string | null {
  const words = text.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3);
  for (const [index, word] of words.entries()) {
    const pair = words[index + 1];
    const found =
      (pair === undefined ? undefined : findCarrier(rules, `${word} ${pair}`)) ??
      findCarrier(rules, word);
    if (found !== undefined) return found.id;
  }
  return null;
}

/** Where the return may be handed in, one option per distinct description. */
export function readDropOff(rules: Rules, lines: readonly string[]): DropOffOption[] {
  const options: DropOffOption[] = [];
  for (const label of DROP_OFF_LABELS) {
    // An inline "Location: Any DHL Drop Off. Your refund …" ends at its sentence.
    const text = after(lines, label)
      ?.split(/\.(?:\s|$)/)[0]
      ?.trim()
      .slice(0, 200);
    if (text === undefined || text === "") continue;
    if (options.some((option) => option.description?.toLowerCase() === text.toLowerCase())) {
      continue;
    }
    options.push({
      carrier: namedCarrier(rules, text),
      kind: dropOffKind(text),
      description: text,
    });
  }
  return options;
}

const CURRENCY: Readonly<Record<string, string>> = { "€": "EUR", $: "USD", "£": "GBP" };
const MONEY_BEFORE = /(EUR|USD|GBP|PLN|CHF|€|\$|£)\s*(\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{2})?)/;
const MONEY_AFTER = /(\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{2})?)\s*(EUR|USD|GBP|PLN|CHF|€|£)/;

/** "1.234,56", "1,234.56" or "12,50" as a number: the last separator before two digits is decimal. */
function amountOf(text: string): number | null {
  const digits = text.replace(/\s/g, "");
  const decimal = /[.,](\d{2})$/.exec(digits);
  const whole = (decimal === null ? digits : digits.slice(0, decimal.index)).replace(/[.,]/g, "");
  const value = Number(decimal === null ? whole : `${whole}.${decimal[1] ?? "00"}`);
  return Number.isFinite(value) ? value : null;
}

export function readMoney(text: string): { amount: number; currency: string } | null {
  const before = MONEY_BEFORE.exec(text);
  const afterMatch = MONEY_AFTER.exec(text);
  const symbol = before?.[1] ?? afterMatch?.[2];
  const number = before?.[2] ?? afterMatch?.[1];
  if (symbol === undefined || number === undefined) return null;
  const amount = amountOf(number);
  return amount === null ? null : { amount, currency: CURRENCY[symbol] ?? symbol };
}

const FREE_RE =
  /\bfree return\b|\breturn is free\b|kostenlose? (?:rücksendung|rückgabe)|kostenlos zurück|free of charge/i;
const COST_LABEL =
  /\b(?:return (?:shipping )?(?:cost|fee|charge)|rücksendekosten|rücksendegebühr|kosten für die rücksendung)\b/i;

/** Whether sending it back is free, or what it costs. */
export function readCost(
  lines: readonly string[],
): { free: boolean; amount: number | null; currency: string | null } | null {
  if (lines.some((line) => FREE_RE.test(line))) return { free: true, amount: null, currency: null };
  const text = after(lines, COST_LABEL);
  const money = text === null ? null : readMoney(text);
  if (money === null) return null;
  return { free: money.amount === 0, amount: money.amount, currency: money.currency };
}

const REFUND_LABEL =
  /\b(?:total estimated refund|estimated refund|total refund|refund total|summe der rückerstattung|betrag in höhe von|refund amount|refund in the amount of|gesamtbetrag erstattung|geschätzte erstattung|erstattungsbetrag|erstattung in höhe von|rückerstattung in höhe von)\b/i;

export function readRefundAmount(
  lines: readonly string[],
): { amount: number; currency: string } | null {
  const text = after(lines, REFUND_LABEL);
  return text === null ? null : readMoney(text);
}

const URL_RE = /https?:\/\/[^\s)<>"\]]+/i;
const LABEL_LINK = /return label|return code|rückgabecode|rücksendeetikett|etikett|qr[ -]?code/i;

/** The label or QR-code page: the first link on, or right after, a line that names one. */
export function readLabelUrl(lines: readonly string[]): string | null {
  for (const [index, line] of lines.entries()) {
    if (!LABEL_LINK.test(line)) continue;
    const url = URL_RE.exec(line)?.[0] ?? URL_RE.exec(lines[index + 1] ?? "")?.[0];
    if (url !== undefined) return url;
  }
  return null;
}

/** The shop's own id of the return: a link parameter or a labelled number. */
export function readReturnRef(lines: readonly string[]): string | null {
  for (const line of lines) {
    const ref =
      /[?&]rmaId=([A-Za-z0-9]{6,40})/.exec(line)?.[1] ??
      /\b(?:return (?:id|number)|rücksendenummer|rma)\s*[:#]\s*([A-Z0-9-]{5,40})\b/i.exec(
        line,
      )?.[1];
    if (ref !== undefined) return ref;
  }
  return null;
}

export function readReason(lines: readonly string[]): string | null {
  const text = after(
    lines,
    /\b(?:reason for (?:return|refund)|rückgabegrund|grund der rücksendung)\b/i,
  );
  return text === null ? null : text.slice(0, 200);
}

/** Item titles a return mail names, from "Item: …" lines or the subject. */
export function readItems(subject: string, lines: readonly string[]): string[] {
  const listed = lines
    .map((line) => /^(?:item|artikel)\s*:\s*(.{2,200})$/i.exec(line)?.[1]?.trim())
    .filter((title): title is string => title !== undefined);
  if (listed.length > 0) return listed;
  const fromSubject =
    /\b(?:return of|refund for|rücksendung von|erstattung für)\s+(.{2,200})$/i.exec(subject)?.[1];
  return fromSubject === undefined ? [] : [fromSubject.replace(/\s+/g, " ").trim()];
}

/**
 * Where the return stands by the mail's wording, else by the rule's event. A mail can say more
 * than its rule's keyword: a drop-off confirmation reads `return_started` by its subject.
 */
export function readStatus(
  event: string | undefined,
  subject: string,
  lines: readonly string[],
): ReturnStatus | null {
  const body = lines.join("\n");
  if (/\byour return (?:was|has been) cancell?ed\b|rücksendung (?:wurde )?storniert/i.test(body)) {
    return "cancelled";
  }
  if (event === "refund_issued") return "refunded";
  if (event === "return_rejected") return "rejected";
  if (event === "return_received") return "received";
  if (/\bis in[- ]transit\b|ist (?:jetzt )?unterwegs/i.test(body)) return "in_transit";
  if (
    /\bwas dropped off\b|wurde abgegeben|drop-off confirmation|abgabebestätigung/i.test(
      `${subject}\n${body}`,
    )
  ) {
    return "dropped_off";
  }
  if (/return label|rücksendeetikett/i.test(subject)) return "label_created";
  return event === "return_started" ? "requested" : null;
}

/** A refund mail that says it is about a return (not a cancelled order) may start one. */
export function mentionsReturn(subject: string, lines: readonly string[]): boolean {
  return /\breturn|rücksend|rückgabe/i.test(`${subject}\n${lines.join("\n")}`);
}
