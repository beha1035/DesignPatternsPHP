// Deep-link builders — prefill dates + occupants so a booking engine lands
// directly on a dated quote instead of an empty search form.
//
// Occupancy rule for La Cigale Tabarka: a child aged 2+ is billed as an adult.
// We still pass the real child age where the channel supports it (Booking.com),
// because the engine applies its own child pricing; elsewhere we fold the child
// into the adult count so the quote reflects 3 full-fare occupants.

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/**
 * @param {object} q
 * @param {string} q.checkin  "YYYY-MM-DD"
 * @param {string} q.checkout "YYYY-MM-DD"
 * @param {number} q.adults
 * @param {number[]} q.childrenAges  e.g. [10]
 * @param {string} q.currency  "EUR" | "TND" | "USD"
 */
export function buildDeepLinks(q) {
  const { checkin, checkout, adults, childrenAges = [], currency = "EUR" } = q;
  const children = childrenAges.length;
  // Channels without a child param: count children 2+ as adults.
  const adultsFolded = adults + childrenAges.filter((a) => a >= 2).length;

  return [
    {
      channel: "Booking.com",
      // Booking.com honours a well-documented deep-link query format.
      url:
        `https://www.booking.com/hotel/tn/tabarka-beach.html` +
        `?checkin=${checkin}&checkout=${checkout}` +
        `&group_adults=${adults}&group_children=${children}` +
        childrenAges.map((a) => `&age=${a}`).join("") +
        `&no_rooms=1&selected_currency=${currency}&lang=fr`,
      priceHints: [
        '[data-testid="price-and-discounted-price"]',
        ".prco-valign-middle-helper",
        ".bui-price-display__value",
      ],
    },
    {
      channel: "Trip.com",
      url:
        `https://fr.trip.com/hotels/tabarka-hotel-detail-10717795/la-cigale-tabarka/` +
        `?checkIn=${checkin}&checkOut=${checkout}` +
        `&adult=${adultsFolded}&children=0&crn=1&curr=${currency}`,
      priceHints: [".realPrice", '[class*="price"]', ".saleRoomItemBox-priceBox-realPrice"],
    },
    {
      channel: "h-rez (direct)",
      // Group booking engine; no reliable public deep-link params → land on
      // the engine and let the validator read whatever "from" price renders.
      url: `https://la-cigale-hotel-tabarka.h-rez.com/`,
      priceHints: ['[class*="price"]', '[class*="tarif"]', ".amount"],
    },
    {
      channel: "TunisieBooking",
      url: `https://tn.tunisiebooking.com/detail_hotel_354/`,
      priceHints: ['[class*="prix"]', '[class*="price"]', ".montant"],
    },
  ];
}

export { iso };
