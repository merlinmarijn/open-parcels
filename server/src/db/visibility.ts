import type { ExpressionBuilder, SqlBool, Expression } from "kysely";
import type { ConnectionTable, Database } from "./schema.js";

/**
 * A parcel shows unless every connection it came from is disabled. One without any connection (an old
 * import, or added by hand before tracking ran) always shows. Disabling a connection hides its data
 * everywhere the owner looks; enabling it again brings everything back unchanged.
 *
 * Written as "not among the hidden ones": the hidden set starts from the disabled connections, is
 * computed once per query and is empty unless a connection is disabled, so a list of thousands of
 * parcels costs no per-row subqueries and can walk an index in its sort order (docs/performance.md).
 */
export function parcelVisible(eb: ExpressionBuilder<Database, "parcels">): Expression<SqlBool> {
  return eb(
    "parcels.id",
    "not in",
    eb
      .selectFrom("parcel_connections as hid_pc")
      .innerJoin("connections as hid_c", "hid_c.id", "hid_pc.connection_id")
      .select("hid_pc.parcel_id")
      .where("hid_c.state", "=", "disabled")
      .where((inner) =>
        inner.not(
          inner.exists(
            inner
              .selectFrom("parcel_connections as vis_pc")
              .innerJoin("connections as vis_c", "vis_c.id", "vis_pc.connection_id")
              .select("vis_pc.parcel_id")
              .whereRef("vis_pc.parcel_id", "=", "hid_pc.parcel_id")
              .where("vis_c.state", "!=", "disabled"),
          ),
        ),
      ),
  );
}

/** The same rule for orders, over `order_connections`. */
export function orderVisible(eb: ExpressionBuilder<Database, "orders">): Expression<SqlBool> {
  return eb(
    "orders.id",
    "not in",
    eb
      .selectFrom("order_connections as hid_oc")
      .innerJoin("connections as hid_c", "hid_c.id", "hid_oc.connection_id")
      .select("hid_oc.order_id")
      .where("hid_c.state", "=", "disabled")
      .where((inner) =>
        inner.not(
          inner.exists(
            inner
              .selectFrom("order_connections as vis_oc")
              .innerJoin("connections as vis_c", "vis_c.id", "vis_oc.connection_id")
              .select("vis_oc.order_id")
              .whereRef("vis_oc.order_id", "=", "hid_oc.order_id")
              .where("vis_c.state", "!=", "disabled"),
          ),
        ),
      ),
  );
}

/** The same rule for returns, over `return_connections`; the order must show too. */
export function returnVisible(eb: ExpressionBuilder<Database, "returns">): Expression<SqlBool> {
  return eb.and([
    eb.exists(
      eb
        .selectFrom("orders")
        .select("orders.id")
        .whereRef("orders.id", "=", "returns.order_id")
        .where("orders.deleted_at", "is", null)
        .where(orderVisible),
    ),
    eb.or([
      eb.not(
        eb.exists(
          eb
            .selectFrom("return_connections as vis_rs")
            .select("vis_rs.return_id")
            .whereRef("vis_rs.return_id", "=", "returns.id"),
        ),
      ),
      eb.exists(
        eb
          .selectFrom("return_connections as vis_rs")
          .innerJoin("connections as vis_s", "vis_s.id", "vis_rs.connection_id")
          .select("vis_rs.return_id")
          .whereRef("vis_rs.return_id", "=", "returns.id")
          .where("vis_s.state", "!=", "disabled"),
      ),
    ]),
  ]);
}

/** The parcel is linked to a connection of one of these kinds. */
export function linkedToKind(
  eb: ExpressionBuilder<Database, "parcels">,
  kinds: readonly ConnectionTable["kind"][],
): Expression<SqlBool> {
  return eb.exists(
    eb
      .selectFrom("parcel_connections as kind_pc")
      .innerJoin("connections as kind_c", "kind_c.id", "kind_pc.connection_id")
      .select("kind_pc.parcel_id")
      .whereRef("kind_pc.parcel_id", "=", "parcels.id")
      .where("kind_c.kind", "in", kinds),
  );
}
