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
