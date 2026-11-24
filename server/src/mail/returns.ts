import { parseMail, type MailParseResult, type Rules } from "open-parcels-rules";
import { returnSnapshot, type ReturnSnapshot } from "../plugin/snapshot.js";
import { carrierFor, orderOf, senderDomain } from "./interpret.js";
import {
  mailLines,
  mentionsReturn,
  readCost,
  readDropOff,
  readItems,
  readLabelUrl,
  readReason,
  readRefundAmount,
  readReturnBy,
  readReturnRef,
  readStatus,
} from "./return-details.js";
import type { MailInput, MailReturnInterpreter } from "./types.js";

function tracking(
  rules: Rules,
  result: MailParseResult,
  domain: string | undefined,
): { carrier: string; barcode: string } | null {
  for (const barcode of result.trackingNumbers) {
    const carrier = carrierFor(rules, result, barcode, domain);
    if (carrier !== null) return { carrier, barcode };
  }
  return null;
}

/**
 * Turns return and refund mails (the shared rules' `return` kind) into return reports. A mail
 * needs an order number the order can be found by; one without is skipped.
 */
export function createReturnInterpreter(rules: Rules, timeZone: string): MailReturnInterpreter {
  return (mail: MailInput): readonly ReturnSnapshot[] => {
    const results = parseMail(rules, {
      from: mail.from,
      subject: mail.subject,
      ...(mail.text === null ? {} : { text: mail.text }),
      ...(mail.html === null ? {} : { html: mail.html }),
      ...(mail.date === null ? {} : { date: mail.date }),
      timeZone,
    });
    const domain = senderDomain(mail.from);
    const reports: ReturnSnapshot[] = [];
    for (const result of results) {
      if (result.kind !== "return") continue;
      const order = orderOf(result.ruleId, result.orderNumbers[0], domain);
      if (order === null) continue;
      const lines = mailLines(mail.text, mail.html);
      const status = readStatus(result.event, mail.subject, lines);
      const refunded = result.event === "refund_issued";
      const money = readRefundAmount(lines);
      reports.push(
        returnSnapshot({
          order: { shop: order.shop, orderNumber: order.orderNumber },
          externalRef: readReturnRef(lines),
          status,
          reason: readReason(lines),
          returnBy: readReturnBy(rules, lines, mail.date ?? new Date(), timeZone),
          dropOff: readDropOff(rules, lines),
          cost: readCost(lines),
          labelUrl: readLabelUrl(lines),
          tracking: tracking(rules, result, domain),
          refund:
            money === null && !refunded
              ? null
              : {
                  amount: money?.amount ?? null,
                  currency: money?.currency ?? null,
                  status: refunded ? "issued" : "pending",
                },
          items:
            result.items !== undefined && result.items.length > 0
              ? result.items
              : readItems(mail.subject, lines),
          mayCreate: !refunded || mentionsReturn(mail.subject, lines),
        }),
      );
    }
    return reports;
  };
}
