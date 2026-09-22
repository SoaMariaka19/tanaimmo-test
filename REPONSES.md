# Réponses — Test technique TanàImmo

## Partie 1 — Revue de code et correction de bugs

### Extrait A — Composant React de liste d'annonces

| # | Problème | Gravité | Correction proposée |
|---|----------|---------|---------------------|
| 1 | `useEffect` sans tableau de dépendances → boucle de fetch infinie à chaque rendu | Critique | Ajouter `[city]` comme tableau de dépendances |
| 2 | Aucune gestion d'erreur sur le fetch (`r.ok` non vérifié, `.catch` absent) → `loading` reste bloqué en cas d'erreur | Élevée | Vérifier `r.ok`, ajouter un `.catch` et un état `error` |
| 3 | Race condition : pas d'annulation des requêtes obsolètes si `city` change rapidement | Moyenne | `AbortController` ou flag `ignore` dans le cleanup de l'effet |
| 4 | `l.price.toLocaleString()` plante si `price` est `null`/`undefined` | Moyenne | Vérification défensive, ex. `(l.price ?? 0).toLocaleString()` |
| 5 | Pas de `key` sur les `<li>` du `.map()` | Faible | Ajouter `key={l.id}` |
| 6 | Risque si on ajoute `[]` sans réfléchir : ne recharge plus quand `city` change | Faible (piège de correction) | S'assurer que `[city]` est bien le tableau de dépendances |

*Cet extrait se corrige sur le papier uniquement, conformément à l'énoncé — pas de code livré pour A.*

---

### Extrait B — Route API de recherche d'annonces (Express + PostgreSQL)

| # | Problème | Gravité | Correction proposée |
|---|----------|---------|---------------------|
| 1 | Injection SQL : `city` interpolé directement dans la requête SQL | Critique | Requête paramétrée (`$1`) au lieu de l'interpolation de chaîne |
| 2 | Problème N+1 : une requête agence + une requête photos par annonce dans une boucle | Élevée | Une seule requête agrégée (`JOIN` + `jsonb_agg`) au lieu de N+1 requêtes séquentielles |
| 3 | Pagination ignorée (`page` récupéré mais jamais utilisé) | Moyenne | `LIMIT`/`OFFSET` calculés à partir de `page`, avec une taille de page plafonnée |
| 4 | Aucune gestion d'erreur (pas de try/catch) | Élevée | `try/catch` autour de la logique + réponse 500 propre en cas d'échec |
| 5 | `SELECT *` expose potentiellement des colonnes internes/sensibles | Moyenne | Sélectionner explicitement les colonnes nécessaires |
| 6 | `city` non validé (absent/invalide) | Faible | Valider `city` en entrée, réponse 400 si absent ou incorrect |

**Remarque** : avec un `LEFT JOIN` sur `agencies`, une annonce sans agence renvoie `agency: {"id": null, "name": null, "phone": null}` plutôt que `agency: null`. Choix assumé — à vérifier côté front (`agency?.id` plutôt que `agency`).

Code corrigé : `src/api/listings.ts`

---

### Extrait C — Webhook de confirmation de paiement

| # | Problème | Gravité | Correction proposée |
|---|----------|---------|---------------------|
| 1 | Aucune vérification de la signature du webhook → n'importe qui peut appeler cette route et marquer une réservation comme payée | Critique | Vérifier une signature HMAC avant tout traitement |
| 2 | Absence d'idempotence : un réessai du prestataire (jusqu'à 5 fois) retraite l'événement en entier | Critique | Stocker les `event.id` déjà traités, court-circuiter si déjà vu |
| 3 | Travail synchrone long (`db.query` + `sendEmail` + `crm.notifyPayment` à 2-8s) avant `res.status(200)` → dépasse les 10s, déclenche des réessais en cascade | Élevée | Répondre `200` dès que le nécessaire est fait, différer l'email et le CRM en tâche asynchrone |
| 4 | Pas de transaction / découplage : si `sendEmail` ou `crm.notifyPayment` échoue après le `UPDATE`, l'état reste incohérent | Élevée | Découpler : le `UPDATE` réussit seul ; les effets de bord sont ré-essayables indépendamment |
| 5 | Validation du payload absente (`event.type`, `event.booking_id`, `event.customer_email` non vérifiés) | Moyenne | Valider la forme du payload avant d'y toucher, répondre 400 si invalide |
| 6 | Aucun `try/catch` autour de la logique | Élevée | `try/catch`, avec log + réponse d'erreur adaptée |

**Remarque sur le lien avec la Partie 3** : l'appel CRM synchrone (2-8s) avant la réponse est la cause directe du scénario d'incident — sous charge, chaque webhook bloque une connexion, le pool sature, le prestataire dépasse ses 10s et réessaie, ce qui ajoute encore plus de charge.

Code corrigé : `src/api/payment-webhook.ts`

---

## Partie 3 — Gestion d'incident

### 3.1 – Scénario

**21h40 —** Ne rien casser. Dashboard (taux 5xx, latence p50/p95, RPS, connexions PostgreSQL actives) + logs filtrés sur les erreurs pour identifier la route en cause. Le début des erreurs (21h35) coïncide avec la campagne SMS lancée à 21h30 : le lien est quasi certain. Message bref à l'équipe, point toutes les 10 minutes, aucun déploiement dans la panique.

**21h45 —** Hypothèses, dans l'ordre, sachant que l'extrait B est en production : **(1)** pool de connexions PostgreSQL saturé — la requête `listings` (`JOIN` + `jsonb_agg` + `GROUP BY`) tient chaque connexion longtemps ; **(2)** index manquant sur `listings(city, created_at)` → seq scan sous charge ; **(3)** webhook paiement synchrone, moins probable un soir de campagne SMS mais à vérifier si les paiements montent aussi. Vérification en 2 minutes : `pg_stat_activity` (saturation), `pg_stat_statements` trié par `mean_exec_time` + `EXPLAIN ANALYZE` (index).
*Message client :* « Dégradation identifiée, liée au pic de trafic de votre campagne. Le site reste accessible mais ralenti, nos équipes sont dessus, prochain point dans 15 minutes. »

**21h55 —** Mitigation sans attendre la cause exacte, par risque croissant : cache HTTP court sur `/api/listings` (`Cache-Control: public, max-age=30, stale-while-revalidate=60`) ; rate limit (20 req/min/IP) ; si `EXPLAIN` confirme le seq scan, `CREATE INDEX CONCURRENTLY idx_listings_city_created ON listings(city, created_at DESC)` (`CONCURRENTLY` pour ne pas bloquer les écritures) ; si le pool est saturé et le CPU encore correct, augmenter temporairement sa taille — jamais si le CPU est déjà à 100 %.

**22h00 —** *Message client :* « En cours de stabilisation, cause probable identifiée côté base, retour à la normale attendu sous 30 minutes. »

**22h10 —** Taux d'erreur redescendu sous 2 %. *Message client :* « Taux d'erreur redescendu sous 2 %, la campagne peut continuer, point complet demain matin. » Règle constante : ne jamais promettre un délai non tenu, ne jamais annoncer « c'est réglé » avant 10 minutes stables.

**Le lendemain —** Post-mortem écrit (blameless), diffusé au client et à l'équipe. Vérifier que les mitigations temporaires sont pérennisées (index toujours en place, cache configuré proprement, pas juste posé en urgence). Revoir la requête `listings` avec `EXPLAIN ANALYZE` sur un volume réaliste, tester en charge (k6/artillery). Basculer le travail synchrone du webhook paiement dans une file asynchrone (BullMQ/SQS). Mettre en place les alertes du 3.2, absentes ce soir-là.

### 3.2 – Avant le lancement

1. **Taux de 5xx API** : warning à 2 % sur 2 min, critical à 5 % sur 1 min — Prometheus + Alertmanager.
2. **Latence p95 `/api/listings`** : > 1,5 s pendant 3 min — Grafana sur histogramme Prometheus.
3. **Saturation du pool PostgreSQL** : connexions actives > 80 % du max pendant 2 min — postgres_exporter + Prometheus.
4. **Échecs du webhook paiement** : > 1 % sur 5 min ou > 3 événements en dead-letter — métrique applicative + Sentry.
   Une alerte qui se déclenche à 35 % de 5xx arrive déjà trop tard — c'est exactement ce qui s'est passé vendredi.