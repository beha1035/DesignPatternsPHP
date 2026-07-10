# Agents personnalisés

## `hotel-deal-finder`

Agent spécialisé dans la recherche de la **meilleure offre d'hôtel au meilleur
prix**, sur plusieurs plateformes, pour une configuration voyageurs/dates/régime
donnée.

### Utilisation

Dans Claude Code, délègue une recherche à l'agent :

```
> Utilise l'agent hotel-deal-finder pour trouver la meilleure offre à
  l'Hôtel La Cigale Tabarka, 2 nuits entre le 14 et le 21 juillet,
  2 adultes + 1 enfant (âge : X ans), en all inclusive.
```

L'agent :

1. interroge OTA internationales + comparateurs tunisiens + site officiel ;
2. normalise chaque tarif (occupants exacts, régime, taxes, annulation) ;
3. teste les créneaux de 2 nuits dans la fenêtre de dates ;
4. renvoie un tableau comparatif trié par prix + une recommandation sourcée.

### Brief préconfiguré

Un brief prêt à l'emploi pour ce voyage se trouve dans
[`briefs/la-cigale-tabarka.md`](briefs/la-cigale-tabarka.md).

### Valider un prix (session réelle) — `validate-rate`

Pour transformer une **estimation** en **prix vérifié**, l'agent dispose d'un
outil de validation qui pilote un vrai navigateur (Playwright + Chromium) sur des
deep links préremplis :

```bash
node .claude/agents/tools/validate-rate.mjs \
  --checkin 2026-07-15 --checkout 2026-07-17 \
  --adults 2 --children 10 --currency EUR
```

- Sortie **JSON** par canal : `verified` / `blocked` / `no_price` / `error`,
  prix lus, et screenshot dans `reports/`.
- N'invente jamais de prix : un blocage ou une étape interactive est reporté tel
  quel.
- **Prérequis réseau** : le domaine doit être joignable. Dans une session web à
  politique d'egress fermée, les sites de voyage renvoient **403 au CONNECT** →
  la validation live échoue ; on retombe alors sur les **liens préremplis** que
  l'utilisateur ouvre lui-même. À exécuter idéalement en local ou dans un
  environnement à réseau ouvert, ou à remplacer par une **API hôtel** (Amadeus,
  RateHawk, Hotelbeds…) pour une fiabilité maximale.

Fichiers : `tools/validate-rate.mjs` (pilote) et `tools/deep-links.mjs`
(constructeurs d'URL préremplies).

### Prix vérifiés via API — `google-hotels-rate` (recommandé)

Voie la plus fiable et pérenne : **SerpApi / Google Hotels** (prix datés agrégés
OTA + direct, pas de blocage anti-bot). Clé self-service sur serpapi.com (essai
gratuit puis payant).

```bash
export SERPAPI_KEY=xxx
node .claude/agents/tools/google-hotels-rate.mjs \
  --checkin 2026-07-15 --checkout 2026-07-17 \
  --adults 2 --children 10 --currency EUR --query "La Cigale Tabarka" --gl tn --hl fr
```

- Sortie JSON au schéma normalisé, offres `verified` (confidence 0.9), triées par
  prix, une ligne par source (OTA/direct).
- Gère proprement l'absence de clé et les blocages réseau (jamais de prix inventé).
- **Egress** : en session web fermée, `serpapi.com` est bloqué → l'autoriser dans
  la network policy de l'environnement, ou exécuter en local avec ta clé.

Fichier : `tools/google-hotels-rate.mjs`.

> **Déprécié** : `tools/amadeus-rate.mjs` — le portail Amadeus Self-Service ferme
> le **2026-07-17**. Conservé uniquement pour un accès Amadeus **Enterprise**.

### Points d'attention (marché tunisien)

- **Enfants 2 ans et + facturés comme adultes** à La Cigale — l'âge de l'enfant
  change le prix total : toujours le préciser.
- Les comparateurs tunisiens (`tunisiebooking.com`, `traveltodo.com`, `cte.tn`)
  sont souvent moins chers que les OTA internationales pour la Tunisie.
- Les prix live par dates exigent souvent une session interactive : l'agent
  fournit des liens de réservation préremplis quand le prix exact n'est pas
  lisible directement.
