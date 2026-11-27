import { fourPx } from "../carriers/4px/index.js";
import { acsCourier } from "../carriers/acs_courier/index.js";
import { airmee } from "../carriers/airmee/index.js";
import { amazonCarrier } from "../carriers/amazon/index.js";
import { amazonShipping } from "../carriers/amazon_shipping/index.js";
import { ampere } from "../carriers/ampere/index.js";
import { anPost } from "../carriers/an_post/index.js";
import { appleExpress } from "../carriers/apple_express/index.js";
import { aramex } from "../carriers/aramex/index.js";
import { betterTrucks } from "../carriers/better_trucks/index.js";
import { boxNow } from "../carriers/box_now/index.js";
import { bol } from "../carriers/bol/index.js";
import { bpost } from "../carriers/bpost/index.js";
import { brt } from "../carriers/brt/index.js";
import { budbee } from "../carriers/budbee/index.js";
import { cainiao } from "../carriers/cainiao/index.js";
import { canadapost } from "../carriers/canadapost/index.js";
import { canpar } from "../carriers/canpar/index.js";
import { cargus } from "../carriers/cargus/index.js";
import { cdl } from "../carriers/cdl/index.js";
import { ceskaPosta } from "../carriers/ceska_posta/index.js";
import { colisPrive } from "../carriers/colis_prive/index.js";
import { colisweb } from "../carriers/colisweb/index.js";
import { correos } from "../carriers/correos/index.js";
import { ctt } from "../carriers/ctt/index.js";
import { dao } from "../carriers/dao/index.js";
import { delhivery } from "../carriers/delhivery/index.js";
import { demoCarrier } from "../carriers/demo/index.js";
import { demoShop } from "../carriers/demo_shop/index.js";
import { dhl } from "../carriers/dhl/index.js";
import { dpd } from "../carriers/dpd/index.js";
import { dragonfly } from "../carriers/dragonfly/index.js";
import { dynalogic } from "../carriers/dynalogic/index.js";
import { earlyBird } from "../carriers/early_bird/index.js";
import { econt } from "../carriers/econt/index.js";
import { ecoscooting } from "../carriers/ecoscooting/index.js";
import { eltaCourier } from "../carriers/elta_courier/index.js";
import { evri } from "../carriers/evri/index.js";
import { fanCourier } from "../carriers/fan_courier/index.js";
import { fedex } from "../carriers/fedex/index.js";
import { genikiTaxydromiki } from "../carriers/geniki_taxydromiki/index.js";
import { gls } from "../carriers/gls/index.js";
import { gobolt } from "../carriers/gobolt/index.js";
import { gofo } from "../carriers/gofo/index.js";
import { helthjem } from "../carriers/helthjem/index.js";
import { hermes } from "../carriers/hermes/index.js";
import { hrvatskaPosta } from "../carriers/hrvatska_posta/index.js";
import { icsCourier } from "../carriers/ics_courier/index.js";
import { inpost } from "../carriers/inpost/index.js";
import { laposte } from "../carriers/la_poste/index.js";
import { magyarPosta } from "../carriers/magyar_posta/index.js";
import { matkahuolto } from "../carriers/matkahuolto/index.js";
import { mondialRelay } from "../carriers/mondial_relay/index.js";
import { novaPost } from "../carriers/nova_post/index.js";
import { nzPost } from "../carriers/nz_post/index.js";
import { oesterreichischePost } from "../carriers/oesterreichische_post/index.js";
import { ontrac } from "../carriers/ontrac/index.js";
import { orlenPaczka } from "../carriers/orlen_paczka/index.js";
import { paack } from "../carriers/paack/index.js";
import { packeta } from "../carriers/packeta/index.js";
import { pdnExpress } from "../carriers/pdn_express/index.js";
import { planzer } from "../carriers/planzer/index.js";
import { pocztaPolska } from "../carriers/poczta_polska/index.js";
import { postaSlovenije } from "../carriers/posta_slovenije/index.js";
import { postaSrbije } from "../carriers/posta_srbije/index.js";
import { posteItaliane } from "../carriers/poste_italiane/index.js";
import { postenBring } from "../carriers/posten_bring/index.js";
import { posti } from "../carriers/posti/index.js";
import { postnl } from "../carriers/postnl/index.js";
import { postnord } from "../carriers/postnord/index.js";
import { pplCz } from "../carriers/ppl_cz/index.js";
import { purolator } from "../carriers/purolator/index.js";
import { quickpac } from "../carriers/quickpac/index.js";
import { sameday } from "../carriers/sameday/index.js";
import { seur } from "../carriers/seur/index.js";
import { seventeenTrack } from "../carriers/seventeen_track/index.js";
import { shopeeXpress } from "../carriers/shopee_xpress/index.js";
import { slovakParcelService } from "../carriers/slovak_parcel_service/index.js";
import { slovenskaPosta } from "../carriers/slovenska_posta/index.js";
import { speeDee } from "../carriers/speedee/index.js";
import { speedx } from "../carriers/speedx/index.js";
import { straightship } from "../carriers/straightship/index.js";
import { sunyou } from "../carriers/sunyou/index.js";
import { swissPost } from "../carriers/swiss_post/index.js";
import { tipsa } from "../carriers/tipsa/index.js";
import { trunkrs } from "../carriers/trunkrs/index.js";
import { ukrposhta } from "../carriers/ukrposhta/index.js";
import { uniuni } from "../carriers/uniuni/index.js";
import { universalLookup } from "../carriers/universal_lookup/index.js";
import { ups } from "../carriers/ups/index.js";
import { usps } from "../carriers/usps/index.js";
import { vintedGo } from "../carriers/vinted_go/index.js";
import m4px from "../carriers/4px/open-parcels-provider.json" with { type: "json" };
import mAcsCourier from "../carriers/acs_courier/open-parcels-provider.json" with { type: "json" };
import mAirmee from "../carriers/airmee/open-parcels-provider.json" with { type: "json" };
import mAmazon from "../carriers/amazon/open-parcels-provider.json" with { type: "json" };
import mAmazonShipping from "../carriers/amazon_shipping/open-parcels-provider.json" with { type: "json" };
import mAmpere from "../carriers/ampere/open-parcels-provider.json" with { type: "json" };
import mAnPost from "../carriers/an_post/open-parcels-provider.json" with { type: "json" };
import mAppleExpress from "../carriers/apple_express/open-parcels-provider.json" with { type: "json" };
import mAramex from "../carriers/aramex/open-parcels-provider.json" with { type: "json" };
import mBetterTrucks from "../carriers/better_trucks/open-parcels-provider.json" with { type: "json" };
import mBoxNow from "../carriers/box_now/open-parcels-provider.json" with { type: "json" };
import mBpost from "../carriers/bpost/open-parcels-provider.json" with { type: "json" };
import mBol from "../carriers/bol/open-parcels-provider.json" with { type: "json" };
import mBrt from "../carriers/brt/open-parcels-provider.json" with { type: "json" };
import mBudbee from "../carriers/budbee/open-parcels-provider.json" with { type: "json" };
import mCainiao from "../carriers/cainiao/open-parcels-provider.json" with { type: "json" };
import mCanadapost from "../carriers/canadapost/open-parcels-provider.json" with { type: "json" };
import mCanpar from "../carriers/canpar/open-parcels-provider.json" with { type: "json" };
import mCargus from "../carriers/cargus/open-parcels-provider.json" with { type: "json" };
import mCdl from "../carriers/cdl/open-parcels-provider.json" with { type: "json" };
import mCeskaPosta from "../carriers/ceska_posta/open-parcels-provider.json" with { type: "json" };
import mColisPrive from "../carriers/colis_prive/open-parcels-provider.json" with { type: "json" };
import mColisweb from "../carriers/colisweb/open-parcels-provider.json" with { type: "json" };
import mCorreos from "../carriers/correos/open-parcels-provider.json" with { type: "json" };
import mCtt from "../carriers/ctt/open-parcels-provider.json" with { type: "json" };
import mDao from "../carriers/dao/open-parcels-provider.json" with { type: "json" };
import mDelhivery from "../carriers/delhivery/open-parcels-provider.json" with { type: "json" };
import mDemo from "../carriers/demo/open-parcels-provider.json" with { type: "json" };
import mDemoShop from "../carriers/demo_shop/open-parcels-provider.json" with { type: "json" };
import mDhl from "../carriers/dhl/open-parcels-provider.json" with { type: "json" };
import mDpd from "../carriers/dpd/open-parcels-provider.json" with { type: "json" };
import mDragonfly from "../carriers/dragonfly/open-parcels-provider.json" with { type: "json" };
import mDynalogic from "../carriers/dynalogic/open-parcels-provider.json" with { type: "json" };
import mEarlyBird from "../carriers/early_bird/open-parcels-provider.json" with { type: "json" };
import mEcont from "../carriers/econt/open-parcels-provider.json" with { type: "json" };
import mEcoscooting from "../carriers/ecoscooting/open-parcels-provider.json" with { type: "json" };
import mEltaCourier from "../carriers/elta_courier/open-parcels-provider.json" with { type: "json" };
import mEvri from "../carriers/evri/open-parcels-provider.json" with { type: "json" };
import mFanCourier from "../carriers/fan_courier/open-parcels-provider.json" with { type: "json" };
import mFedex from "../carriers/fedex/open-parcels-provider.json" with { type: "json" };
import mGenikiTaxydromiki from "../carriers/geniki_taxydromiki/open-parcels-provider.json" with { type: "json" };
import mGls from "../carriers/gls/open-parcels-provider.json" with { type: "json" };
import mGobolt from "../carriers/gobolt/open-parcels-provider.json" with { type: "json" };
import mGofo from "../carriers/gofo/open-parcels-provider.json" with { type: "json" };
import mHelthjem from "../carriers/helthjem/open-parcels-provider.json" with { type: "json" };
import mHermes from "../carriers/hermes/open-parcels-provider.json" with { type: "json" };
import mHrvatskaPosta from "../carriers/hrvatska_posta/open-parcels-provider.json" with { type: "json" };
import mIcsCourier from "../carriers/ics_courier/open-parcels-provider.json" with { type: "json" };
import mInpost from "../carriers/inpost/open-parcels-provider.json" with { type: "json" };
import mLaPoste from "../carriers/la_poste/open-parcels-provider.json" with { type: "json" };
import mMagyarPosta from "../carriers/magyar_posta/open-parcels-provider.json" with { type: "json" };
import mMatkahuolto from "../carriers/matkahuolto/open-parcels-provider.json" with { type: "json" };
import mMondialRelay from "../carriers/mondial_relay/open-parcels-provider.json" with { type: "json" };
import mNovaPost from "../carriers/nova_post/open-parcels-provider.json" with { type: "json" };
import mNzPost from "../carriers/nz_post/open-parcels-provider.json" with { type: "json" };
import mOesterreichischePost from "../carriers/oesterreichische_post/open-parcels-provider.json" with { type: "json" };
import mOntrac from "../carriers/ontrac/open-parcels-provider.json" with { type: "json" };
import mOrlenPaczka from "../carriers/orlen_paczka/open-parcels-provider.json" with { type: "json" };
import mPaack from "../carriers/paack/open-parcels-provider.json" with { type: "json" };
import mPacketa from "../carriers/packeta/open-parcels-provider.json" with { type: "json" };
import mPdnExpress from "../carriers/pdn_express/open-parcels-provider.json" with { type: "json" };
import mPlanzer from "../carriers/planzer/open-parcels-provider.json" with { type: "json" };
import mPocztaPolska from "../carriers/poczta_polska/open-parcels-provider.json" with { type: "json" };
import mPostaSlovenije from "../carriers/posta_slovenije/open-parcels-provider.json" with { type: "json" };
import mPostaSrbije from "../carriers/posta_srbije/open-parcels-provider.json" with { type: "json" };
import mPosteItaliane from "../carriers/poste_italiane/open-parcels-provider.json" with { type: "json" };
import mPostenBring from "../carriers/posten_bring/open-parcels-provider.json" with { type: "json" };
import mPosti from "../carriers/posti/open-parcels-provider.json" with { type: "json" };
import mPostnl from "../carriers/postnl/open-parcels-provider.json" with { type: "json" };
import mPostnord from "../carriers/postnord/open-parcels-provider.json" with { type: "json" };
import mPplCz from "../carriers/ppl_cz/open-parcels-provider.json" with { type: "json" };
import mPurolator from "../carriers/purolator/open-parcels-provider.json" with { type: "json" };
import mQuickpac from "../carriers/quickpac/open-parcels-provider.json" with { type: "json" };
import mSameday from "../carriers/sameday/open-parcels-provider.json" with { type: "json" };
import mSeur from "../carriers/seur/open-parcels-provider.json" with { type: "json" };
import mSeventeenTrack from "../carriers/seventeen_track/open-parcels-provider.json" with { type: "json" };
import mShopeeXpress from "../carriers/shopee_xpress/open-parcels-provider.json" with { type: "json" };
import mSlovakParcelService from "../carriers/slovak_parcel_service/open-parcels-provider.json" with { type: "json" };
import mSlovenskaPosta from "../carriers/slovenska_posta/open-parcels-provider.json" with { type: "json" };
import mSpeedee from "../carriers/speedee/open-parcels-provider.json" with { type: "json" };
import mSpeedx from "../carriers/speedx/open-parcels-provider.json" with { type: "json" };
import mStraightship from "../carriers/straightship/open-parcels-provider.json" with { type: "json" };
import mSunyou from "../carriers/sunyou/open-parcels-provider.json" with { type: "json" };
import mSwissPost from "../carriers/swiss_post/open-parcels-provider.json" with { type: "json" };
import mTipsa from "../carriers/tipsa/open-parcels-provider.json" with { type: "json" };
import mTrunkrs from "../carriers/trunkrs/open-parcels-provider.json" with { type: "json" };
import mUkrposhta from "../carriers/ukrposhta/open-parcels-provider.json" with { type: "json" };
import mUniuni from "../carriers/uniuni/open-parcels-provider.json" with { type: "json" };
import mUniversalLookup from "../carriers/universal_lookup/open-parcels-provider.json" with { type: "json" };
import mUps from "../carriers/ups/open-parcels-provider.json" with { type: "json" };
import mUsps from "../carriers/usps/open-parcels-provider.json" with { type: "json" };
import mVintedGo from "../carriers/vinted_go/open-parcels-provider.json" with { type: "json" };
import { parseManifest } from "../provider/manifest.js";
import type { CarrierProvider } from "../provider/api.js";
import { register, type RegisteredProvider } from "./registry.js";

/** Registers a built-in carrier with the manifest in its folder (`open-parcels-provider.json`). */
function builtin<Config, Secret>(
  code: CarrierProvider<Config, Secret>,
  manifest: unknown,
  folder: string,
): RegisteredProvider {
  return register(code, parseManifest(manifest, `carriers/${folder}`));
}

/**
 * Every carrier provider shipped with the server. Each carrier lives in its own folder under
 * `src/carriers/`, imports only the provider API, and says what it is and may reach in its
 * manifest; it is registered here with `builtin()`.
 */
export const BUILTIN_CARRIERS: readonly RegisteredProvider[] = [
  builtin(acsCourier, mAcsCourier, "acs_courier"),
  builtin(airmee, mAirmee, "airmee"),
  builtin(amazonCarrier(), mAmazon, "amazon"),
  builtin(amazonShipping, mAmazonShipping, "amazon_shipping"),
  builtin(ampere, mAmpere, "ampere"),
  builtin(anPost, mAnPost, "an_post"),
  builtin(appleExpress, mAppleExpress, "apple_express"),
  builtin(aramex, mAramex, "aramex"),
  builtin(betterTrucks, mBetterTrucks, "better_trucks"),
  builtin(boxNow, mBoxNow, "box_now"),
  builtin(bol, mBol, "bol"),
  builtin(bpost, mBpost, "bpost"),
  builtin(brt, mBrt, "brt"),
  builtin(budbee, mBudbee, "budbee"),
  builtin(cainiao, mCainiao, "cainiao"),
  builtin(canadapost, mCanadapost, "canadapost"),
  builtin(canpar, mCanpar, "canpar"),
  builtin(cargus, mCargus, "cargus"),
  builtin(cdl, mCdl, "cdl"),
  builtin(ceskaPosta, mCeskaPosta, "ceska_posta"),
  builtin(colisPrive, mColisPrive, "colis_prive"),
  builtin(colisweb, mColisweb, "colisweb"),
  builtin(correos, mCorreos, "correos"),
  builtin(ctt, mCtt, "ctt"),
  builtin(dao, mDao, "dao"),
  builtin(delhivery, mDelhivery, "delhivery"),
  builtin(demoCarrier, mDemo, "demo"),
  builtin(demoShop, mDemoShop, "demo_shop"),
  builtin(dhl, mDhl, "dhl"),
  builtin(dpd, mDpd, "dpd"),
  builtin(dragonfly, mDragonfly, "dragonfly"),
  builtin(dynalogic, mDynalogic, "dynalogic"),
  builtin(earlyBird, mEarlyBird, "early_bird"),
  builtin(econt, mEcont, "econt"),
  builtin(ecoscooting, mEcoscooting, "ecoscooting"),
  builtin(eltaCourier, mEltaCourier, "elta_courier"),
  builtin(evri, mEvri, "evri"),
  builtin(fanCourier, mFanCourier, "fan_courier"),
  builtin(fedex, mFedex, "fedex"),
  builtin(fourPx, m4px, "4px"),
  builtin(genikiTaxydromiki, mGenikiTaxydromiki, "geniki_taxydromiki"),
  builtin(gls, mGls, "gls"),
  builtin(gobolt, mGobolt, "gobolt"),
  builtin(gofo, mGofo, "gofo"),
  builtin(helthjem, mHelthjem, "helthjem"),
  builtin(hermes, mHermes, "hermes"),
  builtin(hrvatskaPosta, mHrvatskaPosta, "hrvatska_posta"),
  builtin(icsCourier, mIcsCourier, "ics_courier"),
  builtin(inpost, mInpost, "inpost"),
  builtin(laposte, mLaPoste, "la_poste"),
  builtin(magyarPosta, mMagyarPosta, "magyar_posta"),
  builtin(matkahuolto, mMatkahuolto, "matkahuolto"),
  builtin(mondialRelay, mMondialRelay, "mondial_relay"),
  builtin(novaPost, mNovaPost, "nova_post"),
  builtin(nzPost, mNzPost, "nz_post"),
  builtin(oesterreichischePost, mOesterreichischePost, "oesterreichische_post"),
  builtin(ontrac, mOntrac, "ontrac"),
  builtin(orlenPaczka, mOrlenPaczka, "orlen_paczka"),
  builtin(paack, mPaack, "paack"),
  builtin(packeta, mPacketa, "packeta"),
  builtin(pdnExpress, mPdnExpress, "pdn_express"),
  builtin(planzer, mPlanzer, "planzer"),
  builtin(pocztaPolska, mPocztaPolska, "poczta_polska"),
  builtin(postaSlovenije, mPostaSlovenije, "posta_slovenije"),
  builtin(postaSrbije, mPostaSrbije, "posta_srbije"),
  builtin(posteItaliane, mPosteItaliane, "poste_italiane"),
  builtin(postenBring, mPostenBring, "posten_bring"),
  builtin(posti, mPosti, "posti"),
  builtin(postnl, mPostnl, "postnl"),
  builtin(postnord, mPostnord, "postnord"),
  builtin(pplCz, mPplCz, "ppl_cz"),
  builtin(purolator, mPurolator, "purolator"),
  builtin(quickpac, mQuickpac, "quickpac"),
  builtin(sameday, mSameday, "sameday"),
  builtin(seventeenTrack, mSeventeenTrack, "seventeen_track"),
  builtin(seur, mSeur, "seur"),
  builtin(shopeeXpress, mShopeeXpress, "shopee_xpress"),
  builtin(slovakParcelService, mSlovakParcelService, "slovak_parcel_service"),
  builtin(slovenskaPosta, mSlovenskaPosta, "slovenska_posta"),
  builtin(speeDee, mSpeedee, "speedee"),
  builtin(speedx, mSpeedx, "speedx"),
  builtin(straightship, mStraightship, "straightship"),
  builtin(sunyou, mSunyou, "sunyou"),
  builtin(swissPost, mSwissPost, "swiss_post"),
  builtin(tipsa, mTipsa, "tipsa"),
  builtin(trunkrs, mTrunkrs, "trunkrs"),
  builtin(ukrposhta, mUkrposhta, "ukrposhta"),
  builtin(uniuni, mUniuni, "uniuni"),
  builtin(universalLookup, mUniversalLookup, "universal_lookup"),
  builtin(ups, mUps, "ups"),
  builtin(usps, mUsps, "usps"),
  builtin(vintedGo, mVintedGo, "vinted_go"),
];
