# Modèle de données — hotel-deal-finder

> Contrat de données figé (Phase 1). Aligné sur le **schéma d'offre RÉEL** produit
> par les modules Node de `.claude/agents/tools/` (`tunisiebooking-rate.mjs`,
> `apify-hotel-rates.mjs`, `browser-rate.mjs`, orchestré par `find-best-rate.mjs`).
> Les types correspondent exactement aux `schemas` de [`openapi.yaml`](./openapi.yaml).
> Ne pas inventer de champ : si un canal ne connaît pas une donnée (room, board,
> occupation), le champ est **nullable / `unknown`** — jamais deviné.

## Vue d'ensemble

```
Query ──► (search) ──► Hotel[]           résolution nom/ville → hôtels candidats
Query + Hotel ──► (rank) ──► Offer[]      classement d'offres vérifiées
                     │
                     ├─ ChannelPlan       quels canaux pour ce pays
                     └─ FxRate            conversion EUR/TND appliquée au tri
```

Entités : **Hotel**, **Offer**, **Query**, **ChannelPlan**, **FxRate**
(+ objets valeur : `Occupants`, `Geo`).

---

## 1. Query

Requête normalisée d'un utilisateur. Il n'existe **aucun champ URL** (anti-SSRF) :
un hôtel se désigne par `slug` (motif strict) ou `hotelId` (entier), jamais par lien.

| Champ | Type | Requis | Notes |
|---|---|---|---|
| `slug` | `string` `^[a-z]{2}/[a-z0-9-]+$` | l'un de slug/slugs/hotelId | pays ISO2 + identifiant. Ex. `tn/la-cigale-tabarka` |
| `slugs` | `string[]` (1..10) | alt. | classement multi-hôtels |
| `hotelId` | `integer ≥ 1` | route `/price` | id numérique côté canal (ex. TunisieBooking 354) |
| `name` | `string` (2..120) | search | nom libre (validé, pas d'URL) |
| `city` | `string` (2..80) | search | ville |
| `country` | `CountryCode` `^[A-Z]{2}$` | non | indice pays ISO2 |
| `window` | `string` `START..END` (ISO) | l'un de window/checkin+checkout | fenêtre flexible |
| `nights` | `integer` 1..30 (défaut 2) | avec window | nuits par séjour balayé |
| `checkin` / `checkout` | `date` YYYY-MM-DD | alt. | dates fixes |
| `occupants` | `Occupants` | rank | voir ci-dessous |
| `currency` | `EUR\|TND\|USD\|GBP` (défaut EUR) | non | devise d'affichage |
| `escalate` | `boolean` (défaut false) | non | autorise le Tier 3 navigateur (signal), slug interne uniquement |

### Occupants (objet valeur)

| Champ | Type | Requis | Notes |
|---|---|---|---|
| `adults` | `integer` 1..8 | oui | |
| `childrenAges` | `integer[]` 0..17, max 6 (défaut `[]`) | non | âges réels ; la politique enfant appartient au canal (TunisieBooking facture 2+ comme adulte) |

---

## 2. Hotel

Hôtel candidat résolu par `discover-hotel.mjs` + cache `cache/hotel-ids.json`.

| Champ | Type | Nullable | Source module |
|---|---|---|---|
| `slug` | `string` `^[a-z]{2}/[a-z0-9-]+$` | non | clé de cache |
| `displayName` | `string` | non | `entry.displayName` |
| `city` | `string` | oui | `entry.city` |
| `country` | `CountryCode` | oui | `entry.country` (ex. `TN`) |
| `hotelId` | `integer ≥ 1` | oui | `entry.tunisiebooking.hotelId` (numérique) |
| `channels` | `string[]` | non | clés de canaux résolus (`tunisiebooking`, `googleHotels`, …) |
| `childPolicy` | `string` | oui | `entry.childPolicy` |
| `resolution` | `resolved\|partial` | non | `partial` si des ids de canal manquent |

> Note : le cache contient aussi `booking.slug` / `trip.id` en interne. Ils ne
> sont **pas** exposés comme entrées client ; le `booking.slug` ne sert qu'au
> Tier 3 navigateur côté serveur (jamais une URL fournie par l'utilisateur).

---

## 3. Offer

**Cœur du contrat.** Reproduit champ pour champ ce que retournent les modules
canaux (voir `parseOffers` dans `tunisiebooking-rate.mjs`, `normalize` dans
`apify-hotel-rates.mjs`, l'offre de `browser-rate.mjs`) + l'enrichissement de
l'orchestrateur (`eur`, `window`).

| Champ | Type | Nullable | Émis par | Notes |
|---|---|---|---|---|
| `channel` | `string` | non | tous | ex. `TunisieBooking`, `Booking.com (Apify)` |
| `hotel` | `string` | oui | tous | étiquette canal (`hotel_354`) |
| `room` | `string` | oui (`""`) | TB/Apify | vide si le canal n'expose pas la chambre |
| `board` | `breakfast\|half-board\|full-board\|all-inclusive\|room-only\|unknown` | non | tous | régime ; `unknown` honnête |
| `checkin` / `checkout` | `date` | non | tous | ISO |
| `nights` | `integer ≥ 1` | oui | TB | |
| `window` | `string` `ci→co` | oui | orchestrateur | ajouté au sweep |
| `total` | `number` | non | tous | total séjour dans `currency`, frais canal inclus |
| `currency` | `EUR\|TND\|USD\|GBP` | non | tous | TB→TND, browser/Apify→EUR le plus souvent |
| `totalTND` | `number` | oui | TB | miroir en TND |
| `totalEUR` | `number` | oui | TB/browser | EUR si connu à la source |
| `eur` | `number` | oui | orchestrateur | **clé de tri** (converti via FxRate) |
| `baseBeforeFee` | `number` | oui | TB | avant frais de dossier |
| `feePct` | `number` | oui | TB | % ajouté (ex. `2`) |
| `cancellation` | `free\|non-refundable\|unknown` | non (défaut `unknown`) | tous | |
| `status` | `OfferStatus` | non | tous | voir §Statuts |
| `confidence` | `number` 0..1 | oui | tous | 0.9 TB vérifié, 0.6 Apify, 0.5 browser |
| `occupancyVerified` | `boolean` | oui | Apify/browser | `false` ⇒ **signal**, jamais classé en `best` |
| `occupancyNote` | `string` | oui | Apify/browser | pourquoi non vérifié |
| `priceRange` | `{min,max}` | oui | browser | fourchette observée |
| `candidates` | `number[]` | non (`[]`) | browser | prix candidats (transparence signal) |
| `sourceUrl` | `string` | oui | tous | **SORTIE informative** ; jamais rejouée depuis une entrée client |
| `verifiedAt` | `date-time` | oui | tous | horodatage d'observation |

### Statuts (`OfferStatus`) — honnêteté produit

| Statut | Sens | Classé ? |
|---|---|---|
| `verified` | prix daté réel, occupation confirmée | oui |
| `signal` | observé mais room/occupation non garantis (`occupancyVerified:false`) | non — listé à part |
| `no_price` | aucun tarif pour ces dates/occupants | n/a |
| `blocked` | canal anti-bot / indisponible | n/a → `502` |
| `drift` | markup du site changé (canary) — parser à corriger | n/a → `502` |
| `error` | échec technique | n/a |

> Règle d'or (héritée de l'agent) : `verified` / `signal` / `no_price` ne sont
> **jamais confondus**. Une offre `occupancyVerified:false` (headline Apify, scrape
> Booking navigateur) reste un **signal** — elle corrobore, mais ne devient jamais
> le meilleur prix classé.

---

## 4. ChannelPlan

Produit par `lib/country-router.mjs` depuis `config/country-channels.json` (cité).
Dit **quels canaux vérifier en premier** pour un pays — pas de « site le moins cher »
universel.

| Champ | Type | Nullable | Notes |
|---|---|---|---|
| `country` | `CountryCode` | oui | pays résolu |
| `region` | `string` | oui | ex. `North Africa` |
| `matched` | `boolean` | non | `false` = plan par défaut |
| `countrySource` | `explicit\|cache\|geo-detected\|default` | non | d'où vient le pays |
| `pricedNow` | `string[]` | non | canaux avec outil implémenté (tarifés maintenant) |
| `alsoCheck` | `ChannelPlanEntry[]` | non | canaux forts sans outil (manuel/clé) |
| `globalApi` | `string` | oui | état couverture mondiale (clé API présente ?) |
| `note` | `string` | oui | |

**ChannelPlanEntry** : `channel: string`, `tier: 0..3`, `note: string|null`.

Tiers : `0` API structurée · `1` HTTP browserless (TunisieBooking, gratuit) ·
`2` unblocker managé (clé) · `3` navigateur auto-hébergé (dernier recours).

---

## 5. FxRate

Produit par `lib/fx.mjs`. Conversion honnête : `stale:true` signale un taux de
repli épinglé quand le live est indisponible.

| Champ | Type | Nullable | Notes |
|---|---|---|---|
| `pair` | `string` | non | ex. `EUR/TND` |
| `rate` | `number` | non | taux appliqué |
| `stale` | `boolean` | non | `true` = repli épinglé (`PINNED`), à afficher comme approximatif |
| `asOf` | `date-time` | oui | horodatage live (`null` si repli) |
| `source` | `string` | non | `open.er-api.com` ou `pinned-fallback` |

---

## 6. Geo (objet valeur)

Produit par `lib/geo.mjs` (Nominatim). Détecte le pays d'une ville pour choisir le
ChannelPlan automatiquement.

| Champ | Type | Nullable | Notes |
|---|---|---|---|
| `detectedCity` | `string` | oui | ville canonique |
| `country` | `CountryCode` | oui | ISO2 détecté |
| `countryName` | `string` | oui | |
| `source` | `string` | oui | `nominatim` |

---

## Invariants transverses

1. **Tri par `eur`** : le classement se fait toujours sur `Offer.eur` (converti via
   FxRate) ; une offre sans devise convertible est **écartée**, pas mal classée.
2. **`occupancyVerified:false` ⇒ hors classement** : ces offres vont dans
   `unverifiedOccupancy` / `browserObserved`, jamais dans `best`.
3. **Aucune URL en entrée** : les entités Query n'ont que `slug`/`hotelId`. Les
   `sourceUrl` sont des sorties informatives.
4. **Nullable = honnête** : un champ nul/`unknown` veut dire « le canal ne le sait
   pas », jamais « valeur par défaut inventée ».
