import path from "node:path";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { AccessControl } from "./auth/access.js";
import { AuthStore } from "./auth/store.js";
import { CalendarService } from "./calendar/service.js";
import { BUILTIN_CARRIERS } from "./engine/builtin-carriers.js";
import type { Clock } from "./clock.js";
import type { AppConfig } from "./config.js";
import type { SecretBox } from "./crypto/secrets.js";
import type { Database } from "./db/schema.js";
import { LiveTracker } from "./engine/live.js";
import { repairTrackingNumbers } from "./engine/tracking-number-repair.js";
import { scrubStoredRaw } from "./engine/raw-scrub.js";
import { trackingConnectionIn } from "./engine/linking.js";
import { Reconciler } from "./engine/reconciler.js";
import { ProviderRegistry, type RegisteredProvider } from "./engine/registry.js";
import { ConnectionRunner } from "./engine/runner.js";
import { SignInService } from "./engine/sign-in.js";
import { Scheduler } from "./engine/scheduler.js";
import { repairOrderShops } from "./engine/order-repair.js";
import { mergeDuplicateTrackingConnections } from "./engine/connection-dedup.js";
import { ConnectionService } from "./engine/connections.js";
import { reviveTrackingRemovals } from "./engine/tracking-removal-repair.js";
import { rewriteOffsetTimes } from "./engine/utc-repair.js";
import { EventBus } from "./events/bus.js";
import { ImageProxy } from "./images/proxy.js";
import { loadRules } from "open-parcels-rules";
import { imapClientFactory } from "./mail/imap-client.js";
import { createMailInterpreter, createOrderInterpreter } from "./mail/interpret.js";
import { createReturnInterpreter } from "./mail/returns.js";
import { ReturnService } from "./returns/service.js";
import type { MailboxClientFactory, MailInterpreter } from "./mail/types.js";
import { MailWatcher } from "./mail/watcher.js";
import type { Presentation } from "./parcels/repository.js";
import { ParcelService } from "./parcels/service.js";
import { OrderService } from "./orders/service.js";
import { HostLimiter, realSleep, type FetchLike, type Sleep } from "./provider/http.js";
import { availableLayers } from "./tiles/layers.js";
import { TileProxy } from "./tiles/proxy.js";
import { Geocoder } from "./geo/geocoder.js";
import { PlaceResolver } from "./geo/resolver.js";
import { ConfigSettings } from "./settings/config-settings.js";
import { SettingsStore } from "./settings/store.js";
import { CollageMaker } from "./images/collage.js";

/** How this server identifies itself to OpenStreetMap's services. */
const USER_AGENT =
  "open-parcels/2.0 (self-hosted parcel tracker; +https://github.com/open-parcels/open-parcels)";

export interface Services {
  readonly config: AppConfig;
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly secrets: SecretBox;
  readonly installId: string;
  readonly auth: AuthStore;
  readonly bus: EventBus;
  readonly registry: ProviderRegistry;
  readonly connections: ConnectionService;
  readonly images: ImageProxy;
  readonly tiles: TileProxy;
  readonly geocoder: Geocoder;
  /** Background job placing scans that only name a place; started by main. */
  readonly places: PlaceResolver;
  readonly settings: SettingsStore;
  readonly configSettings: ConfigSettings;
  readonly collages: CollageMaker;
  readonly mail: MailWatcher;
  readonly reconciler: Reconciler;
  readonly runner: ConnectionRunner;
  readonly scheduler: Scheduler;
  readonly live: LiveTracker;
  readonly calendar: CalendarService;
  readonly signIn: SignInService;
  readonly parcels: ParcelService;
  readonly orders: OrderService;
  readonly returns: ReturnService;
  readonly access: AccessControl;
}

export interface ServiceDeps {
  readonly config: AppConfig;
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly secrets: SecretBox;
  /** Overrides for tests: providers, the network and waiting. */
  readonly providers?: readonly RegisteredProvider[];
  readonly fetchImpl?: FetchLike;
  readonly sleep?: Sleep;
  readonly mailClientFactory?: MailboxClientFactory;
  readonly mailInterpreter?: MailInterpreter;
}

/**
 * Links active parcels that no carrier connection follows (found in mail, imported, or left over from
 * an older version) to their carrier's tracking connection and makes those connections due. Returns true
 * when anything was linked.
 */
async function followUntracked(
  connections: ConnectionService,
  registry: ProviderRegistry,
  logger: Logger,
  viaConnection?: string,
): Promise<boolean> {
  const linked = await connections.linkUntracked(
    viaConnection === undefined ? {} : { viaConnection },
  );
  // What no carrier follows goes to a fallback tracking service, when the user added one.
  const handedOver = await connections.linkFallbacks();
  for (const connectionId of linked.connections) {
    await connections.requestRun(connectionId);
  }
  const needSettings = [...linked.unlinkedCarriers].filter(
    (carrier) => registry.get(carrier)?.canTrack === true,
  );
  if (needSettings.length > 0) {
    logger.warn(
      { carriers: needSettings },
      "Parcels wait for a tracking connection: these carriers need settings, add the connection by hand.",
    );
  }
  return linked.parcels > 0 || handedOver > 0;
}

/** The inbox interpreters, all reading one copy of the rules. */
function mailInterpreters(timeZone: string, interpret: MailInterpreter | undefined) {
  const rules = loadRules();
  return {
    interpret: interpret ?? createMailInterpreter(rules, timeZone),
    interpretReturns: createReturnInterpreter(rules, timeZone),
    interpretOrders: createOrderInterpreter(rules, timeZone),
  };
}

/**
 * Repairs of stored data, run by `main` on every start before the server listens (not by tools
 * such as the OpenAPI export). Duplicate keyless tracking connections are merged first, so parcels
 * imported or added before they could be linked are then followed by the surviving one.
 */
export async function repairOnStart(services: Services): Promise<void> {
  const { db, clock, logger, bus, connections, registry } = services;
  const mergedConnections = await mergeDuplicateTrackingConnections(db, clock);
  if (mergedConnections > 0) {
    await bus.notify();
    logger.info({ merged: mergedConnections }, "Merged duplicate tracking connections.");
  }
  const repairedOrders = await repairOrderShops(db, clock);
  if (repairedOrders > 0) {
    await bus.notify();
    logger.info({ repaired: repairedOrders }, "Moved orders filed under the wrong shop.");
  }
  const rewrittenTimes = await rewriteOffsetTimes(db);
  if (rewrittenTimes > 0) {
    logger.info({ rewritten: rewrittenTimes }, "Rewrote stored times with an offset as UTC.");
  }
  const trackingNumbers = await repairTrackingNumbers(db, clock);
  if (trackingNumbers.respelled > 0 || trackingNumbers.folded > 0) {
    await bus.notify();
    logger.info(
      trackingNumbers,
      "Stored codes in their carrier's spelling and merged case or space twins.",
    );
  }
  const scrubbed = await scrubStoredRaw(db);
  if (scrubbed > 0) {
    logger.info({ scrubbed }, "Removed codes and personal data from stored raw payloads.");
  }
  const revived = await reviveTrackingRemovals(db, clock);
  if (revived > 0) {
    await bus.notify();
    logger.info({ revived }, "Revived parcels removed only because a lookup did not find them.");
  }
  if (await followUntracked(connections, registry, logger)) {
    logger.info("Linked parcels without a tracking connection to their carrier.");
  }
}

export async function createServices(deps: ServiceDeps): Promise<Services> {
  const { db, clock, logger } = deps;
  // First: values saved in the UI change `deps.config` in place before anything reads it.
  const configSettings = new ConfigSettings(db, clock, logger, deps.config, (key, config) => {
    if (key === "OPENPARCELS_LOG_LEVEL") logger.level = config.logLevel;
  });
  await configSettings.load();
  const auth = new AuthStore(db, clock);
  const bus = new EventBus(db, clock, logger);
  await bus.start();
  const settings = new SettingsStore(db, clock, bus);
  await settings.load();
  const installId = await settings.installId();
  const registry = new ProviderRegistry(deps.providers ?? BUILTIN_CARRIERS);
  const connections = new ConnectionService(db, registry, deps.secrets, bus, clock);
  const images = new ImageProxy({
    secretKey: deps.secrets.derive("image proxy"),
    cacheDir: path.join(deps.config.dataDir, "images"),
    logger,
    allowedHosts: () => registry.list().flatMap((provider) => provider.info.imageHosts),
  });
  const tiles = new TileProxy({
    cacheDir: path.join(deps.config.dataDir, "tiles"),
    userAgent: USER_AGENT,
    // Read per request: a custom provider saved in the UI applies at once.
    layers: () => availableLayers(deps.config.map.custom, deps.config.map.cartoKey),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });
  const geocoder = new Geocoder({
    userAgent: USER_AGENT,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });
  // Filled in once the live tracker exists; reads before that see no positions.
  const presentation: Presentation = {
    position: (parcelId) => live.position(parcelId),
    imagePath: (remote) => images.pathFor(remote),
    labelMode: () => settings.labelMode,
    timeZone: deps.config.timeZone,
  };
  const { timeZone } = presentation;
  const reconciler = new Reconciler(db, bus, clock, logger, { presentation, timeZone });
  const runner = new ConnectionRunner({
    db,
    registry,
    secrets: deps.secrets,
    reconciler,
    limiter: new HostLimiter(clock, deps.sleep ?? realSleep),
    bus,
    clock,
    logger,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });
  // The scheduler hands live targets to the tracker after each poll, and the tracker asks the
  // scheduler for an immediate poll when a session ends; the closures break the cycle.
  const scheduler: Scheduler = new Scheduler({
    db,
    runner,
    connections,
    reconciler,
    clock,
    logger,
    timeZone: deps.config.timeZone,
    // Read on every run, so a change on the Settings page applies at once.
    get quietWindow() {
      return deps.config.quietWindow;
    },
    installId,
    pollIntervalOf: (provider) => registry.get(provider)?.info.pollIntervalMs ?? null,
    onRunSucceeded: (connectionId, liveTargets) => {
      live.setTargets(connectionId, liveTargets);
    },
  });
  const live: LiveTracker = new LiveTracker({
    db,
    runner,
    bus,
    clock,
    logger,
    refreshConnection: async (connectionId) => {
      await connections.requestRun(connectionId);
      scheduler.wake();
    },
    presentation,
  });
  const parcels = new ParcelService(
    db,
    bus,
    clock,
    async (carrier) => {
      // Undefined when no provider tracks the carrier, or its provider needs settings first.
      const connectionId = await trackingConnectionIn(db, registry, clock)(carrier);
      if (connectionId === undefined) {
        return undefined;
      }
      await connections.requestRun(connectionId);
      scheduler.wake();
      return connectionId;
    },
    presentation,
  );
  const places = new PlaceResolver({
    db,
    geocoder,
    bus,
    clock,
    logger,
    presentation,
    enabled: () => deps.config.geocoding,
  });
  const mail = new MailWatcher({
    db,
    secrets: deps.secrets,
    connections,
    reconciler,
    clock,
    logger,
    clientFactory: deps.mailClientFactory ?? imapClientFactory,
    ...mailInterpreters(deps.config.timeZone, deps.mailInterpreter),
    followUp: async (connectionId) => {
      if (await followUntracked(connections, registry, logger, connectionId)) {
        scheduler.wake();
      }
    },
  });
  const access = await AccessControl.create(auth, deps.config, configSettings, logger);
  const returns = new ReturnService(db, clock, deps.config.timeZone);
  return {
    ...deps,
    installId,
    auth,
    bus,
    registry,
    connections,
    images,
    tiles,
    geocoder,
    places,
    settings,
    configSettings,
    collages: new CollageMaker(path.join(deps.config.dataDir, "collages")),
    mail,
    reconciler,
    runner,
    scheduler,
    live,
    calendar: new CalendarService(db, clock, deps.config.timeZone, presentation, returns),
    signIn: new SignInService({
      db,
      registry,
      connections,
      secrets: deps.secrets,
      clock,
      logger,
      httpFor: (policy) => runner.httpFor(policy),
      exclusive: (connectionId, work) => runner.exclusive(connectionId, work),
    }),
    parcels,
    orders: new OrderService(db, bus, clock, presentation, returns),
    returns,
    access,
  };
}
