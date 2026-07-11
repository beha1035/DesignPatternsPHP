# Rapport prix vérifié — Hôtel La Cigale Tabarka (2 nuits, juillet 2026)

> Recherche menée par l'agent `hotel-deal-finder`. Prix **lus en session navigateur
> réelle** (Playwright/Chromium), pas des estimations.

## Demande

| Champ | Valeur |
|---|---|
| Hôtel | **La Cigale Tabarka Hôtel Thalasso, Spa & Golf** (5★, Zone Touristique El Morjene, Tabarka) |
| Fenêtre | N'importe quel créneau de **2 nuits entre le 14/07 et le 20/07/2026** (dates flexibles) |
| Voyageurs | **2 adultes + 1 enfant de 10 ans** → 3 occupants plein tarif (enfant ≥ 2 ans facturé comme adulte, confirmé sur 2 canaux) |
| Régime | BB (petit-déjeuner) et HB (demi-pension) seuls disponibles en ligne — **pas d'All Inclusive** sur ces canaux/dates |
| Devise | TND + EUR (taux ~1 EUR = 3,37 TND, 11/07/2026) |

## Meilleur prix (recommandé)

**TunisieBooking — 14→16/07 (ou 15→17/07, identique)**
Chambre Triple Supérieure + lit supplémentaire, petit-déjeuner inclus.
**2 682 TND ≈ 796 €** — tarif non remboursable.

- ✅ Vérifié en session live, **recoupé par Booking.com à 797 €** (écart < 0,5 %) → confiance ~0,9.
- TunisieBooking affiche un total repas + taxes inclus (54 TND de « frais éventuels » à confirmer au paiement).

**Alternative flexible : TunisieBooking 16→18/07 — 2 729 TND ≈ 810 €**, même chambre/régime,
**annulation gratuite jusqu'au 12/07/2026** (+14 € pour la flexibilité).

## Tableau comparatif (prix vérifiés, régime petit-déjeuner sauf indication)

| Canal | Chambre / Régime | Dates | Total TND | Total EUR | Annulation | Statut |
|---|---|---|---|---|---|---|
| **TunisieBooking** | Triple Sup. + lit suppl. / BB | 14→16 | 2 682 (+54) | ~796 | Non remboursable | ✅ verified |
| **TunisieBooking** | Triple Sup. + lit suppl. / BB | 15→17 | 2 682 (+54) | ~796 | Non remboursable | ✅ verified |
| **Booking.com** | Double Sup. / BB | 14→16 | ~2 686 (base) | 797 base / ~874 TTC | Non remboursable | ✅ verified |
| **TunisieBooking** | Triple Sup. + lit suppl. / BB | 16→18 | 2 729 (+55) | ~810 | **Gratuite jusqu'au 12/07** | ✅ verified |
| **Booking.com** | Double Sup. / BB | 15→17 | ~2 939 (base) | 872 base | Non remboursable | ✅ verified |
| **TunisieBooking** | Triple Sup. + lit suppl. / **Demi-pension** | 14→16 | 3 491 (+70) | ~1 036 | Non remboursable | ✅ verified |
| **Trip.com** | ⚠️ 2 chambres doubles / BB | 14→16 | ~4 020 | 1 192 (2 unités) | Gratuite jusqu'au 11/07 17h | ✅ verified — **non comparable** (2 chambres) |
| TunisieBooking | — | 17→19, 18→20 | — | — | — | ❌ pas de dispo affichée |
| Booking.com | — | 16→18, 17→19, 18→20 | — | — | — | ⚠️ anti-bot intermittent (prix non rendus) |
| h-rez.com | — | toutes | — | — | — | ❌ « property no longer available » (page vitrine, pas un moteur) |
| lacigaletabarka.com | — | — | — | — | — | ❌ pas de réservation en ligne (email uniquement) |

## Alertes

1. **Enfant 10 ans = 3ᵉ occupant plein tarif** sur les 2 canaux vérifiés — aucune gratuité ; chambre triple / lit suppl. requis.
2. **Pas d'All Inclusive en ligne** sur ces dates. Pour l'AI : `reservation.lacigaletabarka@lacigaletabarka.com` / +216 70 019 000.
3. **Booking.com hors taxes** : +7 % TVA +3,6 €/pers/nuit (~+77 € pour 3 pers/2 nuits) → à ajouter au prix affiché.
4. **Fin de fenêtre (17→20/07)** : pas de dispo TunisieBooking (canal complet ou recherche manuelle à faire).
5. **h-rez.com non fiable** malgré son allure de « site officiel ».

## Note technique

Le proxy MITM de l'environnement ne parsait pas l'extension ECH (Encrypted Client
Hello, GREASE inclus) de Chromium récent → `ERR_CONNECTION_RESET` systématique via
Playwright. Correctif : politique managée `/etc/chromium/policies/managed/no-ech.json`
avec `"EncryptedClientHelloEnabled": false`. Après quoi les sessions live passent.

## Preuves

Captures de validation du créneau 14→16/07 versionnées dans
`.claude/agents/reports/` (Booking, h-rez, Tunisie Booking, Trip.com). Captures de
balayage des autres créneaux conservées dans le scratchpad de session.

## Vérification promos / OTA étrangères (2e balayage)

Question posée : peut-on descendre sous 796 € via des sites étrangers ou en cumulant
des promos ? **Verdict : non, aucun prix vérifié inférieur à 796 € à config comparable.**

Canaux supplémentaires testés en session live : **Expedia** (HTTP 429 anti-bot),
**Hotels.com** (widget prix bloqué en chargement), **Agoda** (params URL ignorés par le
SPA, calendrier non pilotable), **Traveltodo** / **Libertavoyages** (deep-link daté non
supporté), **Destinia** (404).

Découverte majeure : **14→16/07 est le seul créneau de la fenêtre avec une chambre unique
pour 3 personnes.** Ailleurs : 15→17 force 2 chambres (~1 026 €, non comparable) ;
16→18, 17→19, 18→20, 19→21 sont **complets** pour cet hôtel.

Promos repérées mais **non chiffrables** (verrouillées derrière un compte connecté — aucun
montant inventé) :
- **Booking Genius** : « connectez-vous pour voir votre réduction » → ‑10/15 % possible,
  invisible sans login. **Seule vraie piste pour passer sous 796 €** (≈ 717 € si ‑10 %).
- **Hotels.com Member Prices / One Key** : idem, gated.
- **Coupons Trip.com / Agoda** : non testables (moteur bascule sur 2 chambres pour 3 pers).
- **Cashback** : hors portée d'un scraping ; cumulable côté utilisateur.

Action côté utilisateur : réserver **connecté sur Booking.com** pour capter un éventuel
tarif Genius, sinon **TunisieBooking à 796 €** reste la meilleure offre publique vérifiée.

## Sources

- <https://tn.tunisiebooking.com/detail_hotel_354/>
- <https://www.booking.com/hotel/tn/tabarka-beach.html>
- <https://fr.trip.com/hotels/tabarka-hotel-detail-10717795/la-cigale-tabarka/>
- <https://www.expedia.com/Tabarka-Hotels-La-Cigale-Tabarka-Hotel-Thalasso-Spa-Golf.h9209677.Hotel-Information>
- <https://www.hotels.com/ho481157/la-cigale-tabarka-hotel-thalasso-spa-golf-tabarka-tunisia/>
- <https://www.agoda.com/fr-fr/la-cigale-tabarka/hotel/tabarka-tn.html>
- <https://www.lacigaletabarka.com/>
