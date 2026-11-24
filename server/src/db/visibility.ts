import type { ExpressionBuilder, SqlBool, Expression } from "kysely";
import type { Database } from "./schema.js";

/**
 * A parcel shows unless every source it came from is disabled. One without any source (an old
 * import, or added by hand before tracking ran) always shows. Disabling a source hides its data
 * everywhere the owner looks; enabling it again brings everything back unchanged.
 */
export function parcelVisible(eb: ExpressionBuilder<Database, "parcels">): Expression<SqlBool> {
  return eb.or([
    eb.not(
      eb.exists(
        eb
          .selectFrom("parcel_sources as vis_ps")
          .select("vis_ps.parcel_id")
          .whereRef("vis_ps.parcel_id", "=", "parcels.id"),
      ),
    ),
    eb.exists(
      eb
        .selectFrom("parcel_sources as vis_ps")
        .innerJoin("sources as vis_s", "vis_s.id", "vis_ps.source_id")
        .select("vis_ps.parcel_id")
        .whereRef("vis_ps.parcel_id", "=", "parcels.id")
        .where("vis_s.state", "!=", "disabled"),
    ),
  ]);
}

/** The same rule for orders, over `order_sources`. */
export function orderVisible(eb: ExpressionBuilder<Database, "orders">): Expression<SqlBool> {
  return eb.or([
    eb.not(
      eb.exists(
        eb
          .selectFrom("order_sources as vis_os")
          .select("vis_os.order_id")
          .whereRef("vis_os.order_id", "=", "orders.id"),
      ),
    ),
    eb.exists(
      eb
        .selectFrom("order_sources as vis_os")
        .innerJoin("sources as vis_s", "vis_s.id", "vis_os.source_id")
        .select("vis_os.order_id")
        .whereRef("vis_os.order_id", "=", "orders.id")
        .where("vis_s.state", "!=", "disabled"),
    ),
  ]);
}

/** The same rule for returns, over `return_sources`; the order must show too. */
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
            .selectFrom("return_sources as vis_rs")
            .select("vis_rs.return_id")
            .whereRef("vis_rs.return_id", "=", "returns.id"),
        ),
      ),
      eb.exists(
        eb
          .selectFrom("return_sources as vis_rs")
          .innerJoin("sources as vis_s", "vis_s.id", "vis_rs.source_id")
          .select("vis_rs.return_id")
          .whereRef("vis_rs.return_id", "=", "returns.id")
          .where("vis_s.state", "!=", "disabled"),
      ),
    ]),
  ]);
}
