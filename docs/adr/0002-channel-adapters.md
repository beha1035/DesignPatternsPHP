# ADR 0002 — Pattern d'adaptateur par canal

Statut : **Accepté** (Phase 1) · Date : 2026-07-16 · Portée : Data/Adapters, Backend

## Contexte

Les prix viennent de sources hétérogènes, chacune avec sa mécanique et sa
**fiabilité** différente :

| Canal | Module | Tier | Fiabilité |
|---|---|---|---|
| TunisieBooking | `tunisiebooking-rate.mjs` | 1 (HTTP browserless) | **verified**, occupation exacte, gratuit |
| Google Hotels | `google-hotels-rate.mjs` | 0 (API/scrape) | structuré, couverture régionale faible |
| Apify (OTA breadth) | `apify-hotel-rates.mjs` | 0 (clé) | **signal** (headline, occupation non appliquée) |
| BrightData unlock | `brightdata-unlock.mjs` | 2 (clé) | débloque un canal ciblé |
| Booking navigateur | `browser-rate.mjs` | 3 (Chromium) | **signal** (room non étiquetée) |

Ces modules produisent **déjà** un schéma d'offre commun (voir
[`data-model.md`](../api/data-model.md) §Offer) et un `status` honnête
(`verified` / `no_price` / `blocked` / `drift` / `error`). `tunisiebooking-rate.mjs`
implémente en plus un **canary de dérive** : `sucess###` + radios de chambre rendues
mais **aucun** champ `price_*` parsé ⇒ statut `drift` (le markup a changé) plutôt
qu'un faux `no_price` silencieux.

Le risque : sans interface figée, chaque nouveau canal réinvente sa forme de sortie,
et la webapp finit par mélanger un `verified` occupation-exacte avec un `signal`
headline — ce qui produirait de **faux « meilleurs prix »**.

## Décision

**Un adaptateur par canal, derrière une interface commune, avec un statut honnête
et une détection de dérive obligatoire.**

### Interface commune (contrat de l'adaptateur)

```
quote(query) -> ChannelResult
  query        : { hotelId|slug, checkin, checkout, occupants, board?, currency }
  ChannelResult: { status, source, offers: Offer[], note? }
    status  : verified | signal | no_price | blocked | drift | error
    offers  : Offer[]  (schéma normalisé §Offer ; occupancyVerified explicite)
```

Règles du contrat :
1. **Sortie normalisée** : tout adaptateur renvoie des `Offer` du schéma commun.
   Ce qu'il ne peut pas mapper va dans un champ conservé, jamais perdu ni inventé.
2. **Statut honnête, jamais confondu** :
   - `verified` **uniquement** si l'occupation exacte a été appliquée ET confirmée
     (`occupancyVerified:true`). C'est le cas de TunisieBooking.
   - Un canal qui ne prouve pas l'occupation (Apify headline, scrape Booking) émet
     ses offres avec `occupancyVerified:false` → traitées en **signal** par
     l'orchestrateur (corroborent, ne classent jamais en `best`).
   - `blocked` (anti-bot) et `error` sont distincts de `no_price` (réponse métier).
3. **Détection de dérive (canary) obligatoire** : chaque adaptateur qui parse du HTML
   doit distinguer « la source dit vide » (`no_price`) de « la source a répondu mais
   je n'ai rien su parser » (`drift`). `drift` sort en code non-zéro / `502` pour que
   la CI et le QA le voient — un parser cassé ne doit jamais se déguiser en sold-out.
4. **Isolation des échecs** : un adaptateur en `blocked`/`error`/`drift` n'empêche
   pas les autres ; l'orchestrateur agrège ce qui a réussi (`find-best-rate` filtre
   déjà `status === "verified"`).
5. **`execFile` en tableau d'args, jamais de shell** (déjà le cas) — pas
   d'interpolation, chaque argument validé (modèle de menace §7 #5).

### Canaux implémentés vs signal

- **Implémentés `verified`** : TunisieBooking (Tier 1). C'est le seul canal
  occupation-exacte et gratuit → source du classement.
- **Implémentés `signal`** : Apify, Booking navigateur, Google Hotels — utilisés pour
  **corroborer** le leader (accord ≤ 3 % ⇒ court-circuit), jamais pour créer un prix
  plus bas non vérifié.
- **Recommandés non implémentés** : les canaux `alsoCheck` du ChannelPlan (Agoda,
  Almosafer, Wego, Traveltodo…) sont exposés comme **conseils**, pas comme prix.

## Conséquences

### Positives
- Ajouter un canal = écrire un adaptateur conforme + fixtures ; zéro changement dans
  l'orchestrateur ni l'API.
- Impossible de faire passer un `signal` pour un `verified` : la distinction est dans
  le contrat, pas dans la politesse de l'appelant.
- La dérive de markup devient un **signal actif** (canary → `drift` → alerte QA), pas
  une panne silencieuse.
- Les fixtures HTML sauvegardées rendent chaque adaptateur testable **sans réseau**.

### Négatives / compromis
- Chaque nouveau canal doit implémenter le canary de dérive → un peu plus de travail
  par adaptateur (compromis assumé : la fiabilité prime).
- La normalisation « best-effort » (Apify) laisse des champs `null` — l'UI doit gérer
  l'absence de room/board (déjà prévu par le nullable du schéma).
- Deux niveaux de vérité (`verified` vs `signal`) alourdissent l'UI, qui doit
  afficher des badges distincts (traité par [ADR 0003](./0003-price-scope.md)).

## Alternatives écartées

- **Un scraper unique paramétré par site** : rejeté — les canaux diffèrent trop
  (endpoint HTTP vs navigateur vs API clé) ; un « god scraper » serait fragile et
  illisible.
- **Tout normaliser en `verified`** : rejeté — c'est le mensonge que le produit
  interdit ; un headline Apify n'est pas une garantie d'occupation.
- **Traiter `drift` comme `no_price`** : rejeté — masquerait un parser cassé et ferait
  croire à tort qu'un hôtel est complet.
- **Adaptateurs couplés à l'orchestrateur** (pas d'interface) : rejeté — empêcherait
  les tests par fixtures et le remplacement d'un canal.
