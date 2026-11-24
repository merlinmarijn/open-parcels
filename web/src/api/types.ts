/** Friendly names for the generated API types. */
import type {
  GetApiV1Calendar200Item,
  GetApiV1Carriers200Item,
  GetApiV1Orders200Item,
  GetApiV1OrdersView,
  GetApiV1Parcels200Item,
  GetApiV1ParcelsId200,
  GetApiV1Returns200Item,
  GetApiV1ReturnsView,
  GetApiV1Session200,
  GetApiV1Connections200Item,
  GetApiV1ConnectionsIdSignInFlows200Item,
  GetApiV1Tokens200Item,
  PostApiV1ConnectionsIdSignInAttemptsAttemptContinue200,
} from "./generated";

export type Session = GetApiV1Session200;
export type Parcel = GetApiV1Parcels200Item;
export type ParcelDetail = GetApiV1ParcelsId200;
export type ParcelStatus = Parcel["status"];
export type LookupState = Parcel["lookup"]["state"];
export type Carrier = GetApiV1Carriers200Item;
export type Connection = GetApiV1Connections200Item;
export type ConnectionState = Connection["state"];
export type SignInFlow = GetApiV1ConnectionsIdSignInFlows200Item;
export type SignInResult = PostApiV1ConnectionsIdSignInAttemptsAttemptContinue200;
export type SignInStepResult = Extract<SignInResult, { status: "step" }>;
export type SignInStep = SignInStepResult["step"];
export type ApiToken = GetApiV1Tokens200Item;
export type CalendarEntry = GetApiV1Calendar200Item;
export type Order = GetApiV1Orders200Item;
export type OrderStatus = Order["status"];
export type OrderView = GetApiV1OrdersView;
export type Return = GetApiV1Returns200Item;
export type ReturnStatus = Return["status"];
export type ReturnView = GetApiV1ReturnsView;

export const PARCEL_STATUSES: readonly ParcelStatus[] = [
  "registered",
  "in_transit",
  "out_for_delivery",
  "at_pickup_point",
  "delivered",
  "returning",
  "problem",
  "unknown",
];
