# ADR 0003 — Périmètre de prix (Tunisie vérifié / monde signal)

Statut : **Accepté** (Phase 1) · Date : 2026-07-16 · Portée : Produit, Frontend, Data

## Contexte

La capacité de tarification n'est **pas uniforme géographiquement** :

- **Tunisie** : `tunisiebooking-rate.mjs` (Tier 1) donne un prix **vérifié**,
  occupation-exacte, daté, **gratuit** et rapide (~2 s). TunisieBooking porte souvent
  le tarif le moins cher des resorts tunisiens et est **invisible à Google Hotels**.
- **Reste du monde** : aucun canal gratuit ne donne un prix vérifié occupation-exacte.
  On dispose de **signaux** : Google Hotels (couverture régionale faible), Apify
  (headline, occupation non appliquée → `occupancyVerified:false`), Booking navigateur
  (room non étiquetée), tous derrière une **clé API** ou lents/fragiles.
- Le `country-channels.json` cité (Forbes/Frommer's/Mize 2026) est explicite : **il
  n'existe pas de « site le moins cher » universel**. Le résultat dépend du pays, de
  l'hôtel, des dates et des programmes de fidélité empilés.

Risque produit : présenter un prix mondial « signal » avec la même autorité qu'un prix
tunisien vérifié tromperait l'utilisateur (faux « meilleur prix »). C'est la ligne
rouge d'honnêteté héritée de l'agent (Architecture §0.5).

## Décision

**Le périmètre de prix est explicite et à deux niveaux, et l'UI le communique
honnêtement — jamais de nivellement par le haut.**

1. **Tunisie = prix vérifié gratuit (le classement)**. Les offres du canal
   TunisieBooking (`status: verified`, `occupancyVerified: true`) sont les seules qui
   **classent** et produisent le `best`. C'est le périmètre de confiance par défaut.

2. **Monde = signal (corroboration / conseil), clé API optionnelle**. Hors Tunisie
   (ou pour corroborer), on n'affiche que des **signaux** :
   - Offres `occupancyVerified:false` → listées dans `unverifiedOccupancy` /
     `browserObserved`, **jamais** dans `best` ni `ranking`.
   - Le `ChannelPlan.alsoCheck` liste les canaux forts du pays **à vérifier
     manuellement / avec une clé** (Agoda, Almosafer, Wego…), présentés comme
     conseils, pas comme prix.
   - `ChannelPlan.globalApi` dit si une clé (`APIFY_TOKEN`/`BRIGHTDATA_API_KEY`) est
     active ; sans clé, on assume la couverture réduite au lieu d'inventer.

3. **L'UI porte la distinction visuellement et textuellement** :
   - **Badge par offre** : `Vérifié` (vert) vs `Signal` (ambre) vs `Indisponible`.
   - Un prix signal affiche sa note (`occupancyNote`) : « prix vitrine — occupation
     non confirmée, à vérifier sur le site ».
   - Le bloc **FxRate** montre `stale` (« taux approximatif ») quand le live échoue.
   - Quand le `best` est **single-sourced** (non corroboré), l'UI le dit
     explicitement (« un seul canal — non confirmé ») plutôt que de le présenter
     comme certain.
   - Hors Tunisie sans clé : message clair « prix vérifié indisponible pour ce pays ;
     voici les canaux à comparer » — pas d'écran vide, pas de faux prix.

## Conséquences

### Positives
- L'utilisateur **sait toujours** ce qu'il regarde : un prix garanti vs un indice.
  L'honnêteté du produit est tenue de bout en bout (module → API → UI).
- Le cœur gratuit et fiable (Tunisie) fonctionne sans aucune clé ni coût.
- L'extension mondiale est possible **incrémentalement** (ajouter une clé, un
  adaptateur `verified`) sans re-architecturer : le périmètre est une propriété de
  données (`status` / `occupancyVerified`), pas du code d'affichage.
- Aligne l'UI sur la réalité citée (« pas de site universellement le moins cher »),
  ce qui protège aussi juridiquement l'usage perso.

### Négatives / compromis
- **Asymétrie d'expérience** : riche en Tunisie, plus pauvre ailleurs. Assumé — mieux
  vaut honnête et partiel que complet et faux.
- L'UI est **plus complexe** : plusieurs badges, notes, états « non corroboré ». Coût
  de design justifié par l'anti-tromperie.
- Certains utilisateurs voudront un prix mondial vérifié qu'on ne peut pas donner
  gratuitement → friction (message d'explication + option clé API).

## Alternatives écartées

- **Afficher les signaux mondiaux comme des prix fermes** : rejeté — c'est le
  mensonge produit interdit ; un headline Apify n'est pas une garantie.
- **Restreindre l'app à la Tunisie uniquement** : rejeté — perd la valeur de conseil
  (ChannelPlan par pays) déjà construite et citée ; l'utilisateur veut au moins
  « où chercher » à l'étranger.
- **Exiger une clé API dès le départ** : rejeté — casse le cœur gratuit et fiable et
  ajoute un coût/secret pour un usage perso. La clé reste **optionnelle**, pour élargir.
- **Masquer complètement le monde faute de prix vérifié** : rejeté — un écran vide est
  moins utile et moins honnête qu'un « voici les canaux à comparer ».
