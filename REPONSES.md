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