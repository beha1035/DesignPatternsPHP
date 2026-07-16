# ADR 0001 — Stratégie de cache & pacing anti-throttling

Statut : **Accepté** (Phase 1) · Date : 2026-07-16 · Portée : Cache/Perf, Backend

## Contexte

Le canal le plus utile (TunisieBooking, Tier 1, gratuit) **throttle les rafales
parallèles** : au-delà de quelques requêtes simultanées, son endpoint renvoie de
fausses « non-disponibilités » (`no_price`) au lieu du vrai prix. C'est un bug déjà
rencontré et corrigé dans `find-best-rate.mjs` par une `mapLimit(stays, 2, …)`
(concurrence plafonnée à 2 fenêtres simultanées). Voir aussi le modèle de menace
§7 risque #4 : une rafale peut faire **bannir l'IP sortante** du serveur.

Une webapp amplifie ce risque : plusieurs utilisateurs, une fenêtre flexible qui se
déploie en N séjours (ex. `2026-07-14..2026-07-20` × 2 nuits = 5 fenêtres), chacune
interrogeant plusieurs canaux/régimes. Sans cache ni régulation, une seule recherche
peut émettre des dizaines de requêtes sortantes vers le même hôte.

Deux besoins distincts :
1. **Cache** : éviter de re-tarifer une même clé `(hotelId, checkin, checkout, occupants, board)`.
2. **Pacing** : borner la concurrence et le débit sortant **par hôte** (throttle
   global + backoff), indépendamment du cache.

## Décision

**1. Cache à TTL, clé composite, en mémoire (process) pour l'usage perso.**

- Clé : `sha1(channel | hotelId | checkin | checkout | adults | childrenAges.sort() | board | currency)`.
  Les `childrenAges` sont **triés** pour que `[10,4]` et `[4,10]` partagent l'entrée.
- TTL par type de résultat (les prix bougent, mais pas à la seconde) :
  - `verified` : **30 min** — assez frais pour un usage perso, assez long pour tenir une rafale.
  - `no_price` : **10 min** — négatif plus court (une dispo peut réapparaître).
  - `blocked` / `drift` / `error` : **non cachés** (ou 60 s anti-tempête) — ne jamais
    figer un échec technique comme s'il était une réponse métier.
- FxRate (`lib/fx.mjs`) : caché **6 h** (le taux EUR/TND ne bouge quasi pas
  intra-journée) ; le flag `stale` reste propagé tel quel.
- Résolution d'ids (`discover-hotel`) et geo (`lib/geo.mjs`) : caché **long / persistant**
  (`cache/hotel-ids.json` existe déjà) — ce sont des identifiants quasi statiques.

**2. Pacing indépendant, appliqué AVANT le cache-miss.**

- **Concurrence plafonnée par hôte** (reprend `mapLimit`, généralisée en pool global) :
  au plus **2** requêtes simultanées vers `tn.tunisiebooking.com` ; au plus **1**
  session simultanée vers `www.booking.com` (Tier 3, navigateur Chromium — canal
  le plus coûteux/risqué, menace #8) ; **1** vers `api.apify.com`. Chaque hôte
  sortant a une limite chiffrée, pas seulement TunisieBooking.
- **Débit** : file d'attente + intervalle minimal entre requêtes sortantes par hôte.
- **Backoff exponentiel + circuit-breaker** sur `blocked`/timeout (déjà des timeouts
  par tier dans l'orchestrateur) : après N échecs consécutifs, ouvrir le circuit et
  répondre `502 upstream_blocked` sans marteler l'hôte.
- **Rate-limit par client** sur l'API (route → `429` + `Retry-After`) pour que la
  charge externe ne puisse pas dépasser le budget sortant.

**3. Choix de backing store : mémoire (Map + horodatage) pour l'usage perso.**
Redis est prévu comme option activable derrière la même interface, mais non requis
au départ.

## Conséquences

### Positives
- Le bug de throttling **ne peut pas réapparaître** : la concurrence est bornée par
  construction, pas par discipline d'appelant.
- Une fenêtre flexible re-consultée est quasi gratuite (cache-hits) → réponses rapides.
- L'IP sortante est protégée du bannissement (pacing + circuit-breaker).
- Interface de cache unique (get/set/TTL) : passer mémoire → Redis est un swap
  d'implémentation, pas un refactor.

### Négatives / compromis
- **Fraîcheur** : un prix peut être vieux de ≤ 30 min. Acceptable en usage perso ;
  documenté dans l'UI (« prix vérifié il y a X min »). Mitigation : bouton
  « rafraîchir » qui bypasse le cache pour une clé.
- **Cache mémoire = non partagé** entre process/instances et **perdu au redémarrage**.
  Sans importance en mono-process perso ; devient un motif de bascule vers Redis si
  on scale (voir Alternatives).
- Le pacing peut **allonger** une recherche large (fenêtre longue) puisque les
  requêtes sont sérialisées par lots de 2. Compromis assumé : lent mais fiable >
  rapide mais banni.

## Alternatives écartées

- **Pas de cache (toujours live)** : rejeté — throttling/bannissement garantis sous
  rafale, latence élevée, aucune valeur ajoutée pour l'usage perso.
- **Redis / KV dès le départ** : rejeté pour la V1 perso — ajoute une dépendance
  d'infra (serveur, connexion, secret) sans bénéfice tant qu'on est mono-process.
  **Conservé comme option** derrière l'interface de cache pour un futur multi-instance.
- **TTL unique global** : rejeté — cacher un `error`/`blocked` aussi longtemps qu'un
  `verified` figerait un échec technique en fausse réponse métier (viole l'honnêteté).
- **Concurrence illimitée + retry agressif** : rejeté — c'est exactement ce qui
  déclenche les fausses « non-dispo » et le bannissement.
