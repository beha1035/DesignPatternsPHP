# hotel-deal-finder — webapp (perso / interne)

Interface web au-dessus de l'agent `hotel-deal-finder` : cherche et classe les
meilleures offres d'hôtel (prix **vérifié** en Tunisie via TunisieBooking, signaux
ailleurs). Backend Express + UI statique, servis par **un seul process**.

> Usage **perso / interne** uniquement. Voir `docs/ARCHITECTURE-MULTIAGENT.md`
> (architecture + §7 sécurité) et `docs/api/openapi.yaml` (contrat d'API).

## Démarrer

```bash
cd webapp
npm install                      # deps (express, helmet, zod, playwright pour l'e2e)
cp .env.example .env             # puis éditer
#   API_BEARER_TOKEN=<une longue valeur aléatoire>   (obligatoire)
#   HOST=127.0.0.1  PORT=3000                         (localhost par défaut)
#   APIFY_TOKEN=... / SERPAPI_KEY=...                 (optionnels — signaux monde)
npm start                        # http://127.0.0.1:3000
```

Dans l'UI : bouton **Réglages** → coller le même `API_BEARER_TOKEN` (stocké en
`localStorage`, jamais commité).

## API (résumé)

| Route | Auth | Rôle |
|---|---|---|
| `GET /api/health` | non | statut serveur/cache/fx |
| `POST /api/search` | bearer | hôtels candidats par ville/nom |
| `POST /api/rank` | bearer | classement multi-fenêtres (cascade `find-best-rate`) |
| `GET /api/hotels/{id}/price` | bearer | prix daté d'un hôtel (occupation exacte) |

Statuts d'offre honnêtes : `verified` (occupation exacte, classe le *best*) /
`signal` (occupation non confirmée — jamais présenté comme meilleur prix) /
`no_price` / `blocked` / `drift`.

## Sécurité (posture)

- **Anti-SSRF** à deux niveaux : garde in-process (`lib/ssrf-guard.mjs`, allowlist
  + IP privées + DNS-rebind) pour les appels du serveur ; **`net-guard`** importé
  par chaque script CLI/sous-process (`/api/rank` shell-out) pour que la même
  allowlist s'applique dans **tous** les process. Aucune URL libre en entrée.
- **Auth** bearer sur toutes les routes `/api` sauf `/health` ; **bind localhost**.
- **Rate-limit** par client + **pacing/concurrence par hôte** (anti-throttling +
  anti-bannissement).
- **Anti-XSS** : rendu 100 % `textContent`/`createElement` (jamais `innerHTML`),
  `sanitizeUrl` (bloque `javascript:`/`data:`…), **CSP stricte** (en-tête helmet).
- **Secrets** en env, redactés dans les logs, jamais commités (`.env` gitignored).

Deux gates sécurité adversariaux ont été passés (backend + frontend) ; ils ont
attrapé et fait corriger une vraie faille SSRF avant la mise en service.

### Limites assumées (perso / interne)
- Prix **vérifié occupation-exacte** = Tunisie (TunisieBooking, gratuit). Monde =
  `signal` (clé API optionnelle). Voir ADR 0003.
- `Offer.sourceUrl` (lien « source ») n'a pas d'allowlist de domaine : le lien
  affiche le texte statique « source » et porte `rel="noopener noreferrer"` — pas
  un XSS/SSRF (ADR 0003 : `sourceUrl` informatif). À restreindre si un jour public.
- `net-guard` (sous-process) ne fait pas de résolution DNS (pas de défense
  anti-rebinding) : acceptable car ces process ne fetchent que des hôtes codés en
  dur, jamais dérivés d'une entrée utilisateur.

## Tests

```bash
npm test            # unitaires (backend + frontend), sans réseau — 145
npm run test:e2e    # end-to-end Playwright (serveur + service mock) — 8
npm run test:all    # les deux
```

Les tests unitaires n'ont pas de réseau (fixtures). Rappel : un test mocké ne
remplace pas un appel réel — la démo live a attrapé un bug d'occupation que les
mocks masquaient (résolution de la ville). Vérifie en réel après un changement
de canal.

## Déploiement (perso)

Node ≥ 22. Le serveur reste **bind localhost** par défaut ; pour un accès distant,
mettre derrière un tunnel/VPN ou un reverse-proxy TLS + garder l'auth bearer.
Fournir `API_BEARER_TOKEN` (et les clés canaux optionnelles) via l'environnement.
