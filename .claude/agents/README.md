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

### Points d'attention (marché tunisien)

- **Enfants 2 ans et + facturés comme adultes** à La Cigale — l'âge de l'enfant
  change le prix total : toujours le préciser.
- Les comparateurs tunisiens (`tunisiebooking.com`, `traveltodo.com`, `cte.tn`)
  sont souvent moins chers que les OTA internationales pour la Tunisie.
- Les prix live par dates exigent souvent une session interactive : l'agent
  fournit des liens de réservation préremplis quand le prix exact n'est pas
  lisible directement.
