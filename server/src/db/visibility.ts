import type { ExpressionBuilder, SqlBool, Expression } from "kysely";
import type { ConnectionTable, Database } from "./schema.js";

/**
 * A parcel shows unless every connection it came from is disabled. One without any connection (an old
 * import, or added by hand before tracking ran) always shows. Disabling a connection hides its data
 * everywhere the owner looks; enabling it again brings everything back unchanged.
 */
export function parcelVisible(eb: ExpressionBuilder<Database, "parcels">): Expression<SqlBool> {
  return eb.or([
    eb.not(
      eb.exists(
        eb
          .selectFrom("parcel_connections as vis_ps")
          .select("vis_ps.parcel_id")
          .whereRef("vis_ps.parcel_id", "=", "parcels.id"),
      ),
    ),
    eb.exists(
      eb
        .selectFrom("parcel_connections as vis_ps")
        .innerJoin("connections as vis_s", "vis_s.id", "vis_ps.connection_id")
        .select("vis_ps.parcel_id")
        .whereRef("vis_ps.parcel_id", "=", "parcels.id")
        .where("vis_s.state", "!=", "disabled"),
    ),
  ]);
}

/** The same rule for orders, over `order_connections`. */
export function orderVisible(eb: ExpressionBuilder<Database, "orders">): Expression<SqlBool> {
  return eb.or([
    eb.not(
      eb.exists(
        eb
          .selectFrom("order_connections as vis_os")
          .select("vis_os.order_id")
          .whereRef("vis_os.order_id", "=", "orders.id"),
      ),
    ),
    eb.exists(
      eb
        .selectFrom("order_connections as vis_os")
        .innerJoin("connections as vis_s", "vis_s.id", "vis_os.connection_id")
        .select("vis_os.order_id")
        .whereRef("vis_os.order_id", "=", "orders.id")
        .where("vis_s.state", "!=", "disabled"),
    ),
  ]);
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
