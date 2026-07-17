// Deterministic mock `service` for e2e tests — same shape/contract as
// webapp/service.mjs (searchHotels/rankOffers/priceHotel), fed straight into
// createApp({ service }) so the whole stack (validation, auth, rate-limit,
// error mapping) is real EXCEPT the outbound network, which never happens.

const NOW = () => new Date().toISOString();

export function defaultHotel(overrides = {}) {
  return {
    slug: "tn/la-cigale-tabarka",
    displayName: "La Cigale Tabarka Hôtel Thalasso, Spa & Golf",
    city: "Tabarka",
    country: "TN",
    hotelId: 354,
    channels: ["tunisiebooking"],
    childPolicy: null,
    resolution: "resolved",
    ...overrides,
  };
}

export function defaultFx(overrides = {}) {
  return { pair: "EUR/TND", rate: 3.37, stale: false, asOf: NOW(), source: "open.er-api.com", ...overrides };
}

export function defaultChannelPlan(overrides = {}) {
  return {
    country: "TN",
    region: "North Africa",
    matched: true,
    countrySource: "cache",
    pricedNow: ["TunisieBooking", "Google Hotels"],
    alsoCheck: [{ channel: "Booking.com", tier: 3, note: "navigateur, à corroborer" }],
    globalApi: null,
    note: null,
    ...overrides,
  };
}

export function verifiedOffer(overrides = {}) {
  return {
    channel: "TunisieBooking",
    hotel: "hotel_354",
    room: "Chambre Double Vue Jardin",
    board: "breakfast",
    checkin: "2026-07-14",
    checkout: "2026-07-16",
    nights: 2,
    window: "2026-07-14→2026-07-16",
    total: 812,
    currency: "TND",
    totalTND: 812,
    totalEUR: 241,
    eur: 241,
    baseBeforeFee: 796,
    feePct: 2,
    cancellation: "unknown",
    status: "verified",
    confidence: 0.9,
    occupancyVerified: true,
    occupancyNote: null,
    priceRange: null,
    candidates: [],
    sourceUrl: "https://tn.tunisiebooking.com/detail_hotel_354/",
    verifiedAt: NOW(),
    ...overrides,
  };
}

export function defaultRankResponse(overrides = {}) {
  return {
    query: { hotel: "La Cigale Tabarka", window: null, nights: 2, adults: 2, childrenAges: [10], childPolicy: null },
    generatedAt: NOW(),
    status: "verified",
    fx: defaultFx(),
    geo: null,
    channelPlan: defaultChannelPlan(),
    tiersRun: ["tier1:tunisiebooking"],
    shortCircuited: false,
    best: {
      channel: "TunisieBooking",
      room: "Chambre Double Vue Jardin",
      board: "breakfast",
      window: "2026-07-14→2026-07-16",
      totalEUR: 241,
      totalTND: 812,
      sourceUrl: "https://tn.tunisiebooking.com/detail_hotel_354/",
      corroborated: false,
      corroboratedBy: null,
    },
    ranking: [verifiedOffer()],
    unverifiedOccupancy: [],
    browserObserved: [],
    channels: ["TunisieBooking"],
    escalation: [],
    ...overrides,
  };
}

export function makeService(overrides = {}) {
  const calls = { searchHotels: 0, rankOffers: 0, priceHotel: 0 };
  return {
    calls,
    searchHotels: async (q) => {
      calls.searchHotels += 1;
      if (overrides.searchHotels) return overrides.searchHotels(q);
      return {
        query: { name: q.name ?? null, city: q.city ?? null, country: q.country ?? null },
        geo: null,
        hotels: [defaultHotel()],
        generatedAt: NOW(),
      };
    },
    rankOffers: async (q) => {
      calls.rankOffers += 1;
      if (overrides.rankOffers) return overrides.rankOffers(q);
      return defaultRankResponse();
    },
    priceHotel: async (q) => {
      calls.priceHotel += 1;
      if (overrides.priceHotel) return overrides.priceHotel(q);
      return {
        query: { hotelId: q.hotelId, checkin: q.checkin, checkout: q.checkout, nights: 2, adults: q.adults, childrenAges: q.childrenAges, currency: q.currency ?? "EUR" },
        generatedAt: NOW(),
        status: "verified",
        source: "TunisieBooking (browserless)",
        fx: defaultFx(),
        note: null,
        offers: [verifiedOffer()],
      };
    },
  };
}
