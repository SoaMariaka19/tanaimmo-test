# Test technique — TanàImmo

Réalisé par Soa Mariaka RAKOTOMALALA, pour le poste de Développeur Web React (TARAM GROUP).

## Prérequis

- Node.js 18+ (fetch natif utilisé dans `crmClient.ts`)
- npm

## Installation

```bash
npm install
```

Copier `.env.example` en `.env` et renseigner les valeurs si besoin (aucune vraie valeur n'est nécessaire pour lancer les tests, tout est mocké) :

```bash
cp .env.example .env
```

## Lancer les tests

```bash
npm test
```

Vérification des types :

```bash
npx tsc --noEmit
```

## Structure du projet

```
src/
  api/
    listings.ts          # Extrait B corrigé
    payment-webhook.ts   # Extrait C corrigé
  crm/
    crmClient.ts          # Connecteur CRM (Partie 2)
    __tests__/
      crmClient.test.ts   # Tests unitaires du connecteur
REPONSES.md               # Tableaux d'analyse (Partie 1) + rédaction (Partie 3)
.env.example
```

## Ce qui a été fait

- **Partie 1** : analyse complète des 3 extraits (tableau problème / gravité / correction dans `REPONSES.md`). Extraits B et C corrigés dans `src/api/`.
- **Partie 2** : connecteur `crmClient` avec timeout 5s, retry + backoff exponentiel sur 429/5xx, respect de `Retry-After`, aucun retry sur 4xx définitives, clé d'idempotence stable par lead, token jamais loggé. Deux tests unitaires demandés par l'énoncé (429 puis succès, 500×3 puis abandon).
- **Partie 3** : rédaction dans `REPONSES.md` (scénario d'incident + alertes de lancement).

## Ce qui n'a pas été fait

- Pas de tests d'intégration (supertest) sur les routes `listings` et `payment-webhook` elles-mêmes — seule la logique du connecteur CRM est testée unitairement, conformément à ce que demandait l'énoncé ("deux tests unitaires suffisent, ajoutez-en d'autres seulement s'il vous reste du temps").
- Pas de vraie base PostgreSQL ni de file d'attente (BullMQ/SQS) mise en place pour le webhook paiement — reste au stade de recommandation dans la Partie 3, conformément à la consigne "tout peut être simulé en mémoire".

## Temps réellement passé

Entre 2h et 3h au total (installation et configuration de l'environnement comprises). J'ai dépassé légèrement les 2 heures indicatives pour m'assurer de bien comprendre et pouvoir justifier chaque partie du code, plutôt que de rendre quelque chose de plus rapide mais moins maîtrisé.