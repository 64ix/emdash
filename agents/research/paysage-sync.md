# Paysage des mécanismes de sync — fact sheet comparative

Contexte : emdash est une app Electron local-first (macOS + Windows) dont tout l'état
vit dans une base SQLite locale (Drizzle ORM, PK UUID, colonnes `updatedAt`/`createdAt`,
colonnes JSON versionnées). Objectif : sync multi-machine pour UN utilisateur, 2 machines,
quasi-continue + à l'ouverture + bouton manuel. Pas de sync de credentials. Coût ~0.

Conventions : chaque affirmation cite sa source primaire (URL entre parenthèses).
« E2EE » = chiffrement de bout en bout défendable côté client.

---

## Pôle 1 — Backend opéré (petit serveur de sync dédié)

### Design minimal d'un serveur de sync (modèle « row-level »)

Le pattern éprouvé est un serveur sans état avec deux endpoints, plus un canal de
notification. C'est le protocole de Replicache (pull = delta depuis un cookie/cursor,
push = mutations batchées) (https://replicache.dev/), celui de Turso Sync (`push()`/
`pull()` + long-poll) (https://docs.turso.tech/sync/usage), et celui d'Electric
(Shapes HTTP avec offset cursor) (https://electric-sql.com/docs/sync). Formes typiques :

- `POST /sync/pull { cursor }` → `{ cursor: <opaque token>, patches: [{table, pk,
  operation, row}] }`. Côté serveur : `SELECT ... FROM <table> WHERE updatedAt > cursor`,
  trié par `updatedAt` (les colonnes `updatedAt`/`createdAt` déjà présentes dans le schéma
  emdash suffisent — pas besoin de change-log dédié).
- `POST /sync/push { mutations: [...] }` → applique les upserts avec `lastWriteWins`
  (stratégie par défaut de Turso Sync : « last push wins », https://docs.turso.tech/sync/usage).
- Notifications : WebSocket, SSE ou long-poll HTTP. Replicache et PowerSync streament par
  HTTP/WebSocket (https://docs.powersync.com/client-sdk-references/javascript-web/) ;
  pour 1 utilisateur, un long-poll simple suffit.
- Le client garde SQLite local comme source de vérité ; le serveur n'est qu'un relais de
  rows versionnées. Les colonnes JSON versionnées se sync opèrent comme chaînes opaques.

### Coût d'hébergement (~1 utilisateur, trafic négligeable)

| Plateforme | Coût | Notes (source) |
|---|---|---|
| Cloudflare Workers + D1 | **0 $** | Free plan : 100 k requêtes/j, D1 5 M rows lues/j, 100 k rows écrites/j, 5 GB, **zéro egress facturé** (https://developers.cloudflare.com/workers/platform/pricing/, https://developers.cloudflare.com/d1/platform/pricing/) |
| Cloudflare Durable Objects | 0 $ | Free : 100 k req/j, 13 000 GB-s/j, DO SQLite 5 GB ; WebSocket Hibernation possible (https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Railway | 0 $ (Free) | Free : 1 vCPU/0.5 GB, 1 replica, 1 $ de crédits/mois ; Hobby 5 $/mois (https://railway.com/pricing) |
| Fly.io | ~2-4 $/mois | Pas de plan gratuit pour les nouveaux (plans gratuits supprimés) ; machine `shared-cpu-1x 256MB` ≈ 2,02 $/mois + volume 0,15 $/GB + egress 0,02 $/GB (https://fly.io/docs/about/pricing/) |
| Render | 0 $ (gratuit) | Web service gratuit 512 MB/0.1 CPU mais **se met en veille après 15 min d'inactivité** ; Starter 7 $/mois, disques 0,25 $/GB (https://render.com/pricing) |

### « SQLite hébergé » qui supprime la gestion serveur

- **Turso (libSQL)** : SQLite managé avec sync intégré. Free : 100 bases, 5 GB, 10 M rows
  écrites/mois, **3 GB de sync/mois** ; Developer 4,99 $/mois (https://turso.tech/pricing).
  Deux mécanismes : *Embedded Replicas* (réplique locale en lecture, écritures vers la
  primaire cloud, `syncInterval` configurable, encryption at rest locale possible via
  `encryptionKey`) (https://docs.turso.tech/features/embedded-replicas) et *Turso Sync*
  (CDC logique, écritures local-first avec `push()`/`pull()` explicites, long-poll)
  (https://docs.turso.tech/sync/usage). Seule option « SQLite existant » clé en main.
- **Cloudflare D1** : SQLite serverless côté serveur (pas de réplication device↔cloud) ;
  pratique comme stockage du serveur de sync, pas comme canal de sync client
  (https://developers.cloudflare.com/d1/).

---

## Pôle 2 — SaaS de sync / libs CRDT

| Option | Coût free | E2EE | Offline | macOS+Windows (Electron) | Effort | Store serveur requis ? |
|---|---|---|---|---|---|---|
| **Turso / libSQL** | 0 $ (3 GB sync/mois, 5 GB) | Encrypt. at rest locale (client `encryptionKey`) | Oui (local-first) | Oui (SDK TS/Node dans Electron) | **Faible** | Turso Cloud (SQLite) |
| **Replicache** | 0 $ (open-sourcé, **maintenance mode**) | À construire | Oui | Oui (JS/IndexedDB) | Élevé | Oui, BYO backend |
| **PowerSync** | 0 $ (2 GB sync/mois, 50 conn.) | À construire | Oui | Web SDK (rendu Electron possible, SQLite gérée par le SDK) | Élevé | **Postgres/Mongo/MySQL/SQL Server** (pas SQLite) |
| **ElectricSQL** | 0 $ effectif (factures < 5 $/mois annulées) | À construire | Oui (PGlite) | Oui (client TS) | Élevé | **Postgres** |
| **Supabase Realtime** | 0 $ (500 MB DB, 2 M messages/mois, pause après 1 sem. d'inactivité) | Non | Non (à construire) | Oui (JS SDK) | Moyen-élevé | Postgres |
| **Firebase / Firestore** | 0 $ (1 GiB, 20 k writes/j, 50 k reads/j) | Non | Oui (persistance offline intégrée) | Oui (JS SDK) | Élevé (modèle documents ≠ SQL) | Firestore |
| **Yjs** | 0 $ (open source) | Oui (chiffrer les updates avant transport) | Oui (persistance locale) | Oui (JS) | Élevé (pas relationnel) | Non (P2P ou relay quelconque) |
| **Automerge** | 0 $ (open source) | Oui (idem) | Oui | Oui (JS/Rust) | Élevé (pas relationnel) | Non (P2P ; Automerge Repo avec serveur optionnel) |

Détails par option :

- **Turso / libSQL** : sync de vrais fichiers SQLite → compatible Drizzle. Les writes
  passent par la primaire cloud (Embedded Replicas) ou restent locaux avec `push()`/`pull()`
  (Turso Sync). Conflits : « last push wins » au niveau statement. Unités de 4 kB par frame
  → une petite row coûte 4 kB de sync (https://docs.turso.tech/features/embedded-replicas,
  https://docs.turso.tech/sync/usage, https://turso.tech/pricing).
- **Replicache** : framework client de sync avec cache local, push/pull vers n'importe quel
  backend, conflits réglés par « server reconciliation ». Open-sourcé et gratuit depuis le
  passage en maintenance mode ; Rocicorp recommande de migrer vers Zero (qui exige Postgres)
  (https://replicache.dev/).
- **PowerSync** : service de streaming + SDK client qui gère sa propre SQLite locale
  (schéma client appliqué via vues SQLite) ; écritures remontées via `uploadData()` vers
  votre API. Backends supportés : Postgres, MongoDB, MySQL, SQL Server — pas SQLite.
  Open Edition self-host gratuite (source disponible) (https://www.powersync.com/pricing,
  https://docs.powersync.com/client-sdk-references/javascript-web/).
- **ElectricSQL** : sync *lecture* de Postgres vers clients via Shapes HTTP (CDN cache,
  offset cursor) ; les writes repassent par votre API. Open source (Apache-2.0), self-host
  documenté. Cloud PAYG : 1 $/1 M writes, 0,10 $/GB-mois, sous 5 $/mois non facturé
  (https://electric-sql.com/docs/sync, https://electric-sql.com/pricing).
- **Supabase Realtime** : Postgres Changes (WAL) + broadcast, 200 connections peak, 2 M
  messages/mois en free ; projet free **pausé après 1 semaine d'inactivité** (incompatible
  avec une sync continue). Pas de file offline client native (https://supabase.com/pricing).
- **Firebase/Firestore** : persistance offline incluse et solide, SDK JS compatible
  Electron ; mais store de documents, pas SQL → remapper tout le modèle relationnel. Spark
  free : 1 GiB, 20 k writes/j, 50 k reads/j (https://firebase.google.com/pricing).
- **Yjs** : CRDT partagés (Map/Array/text), réseau-agnostique, persistance locale
  (IndexedDB, LevelDB), écosystème de providers hébergés (Y-Sweet, Liveblocks, Hocuspocus).
  Ne sync pas de tables SQL — il faut modéliser l'état comme documents CRDT
  (https://yjs.dev/).
- **Automerge** : moteur de sync local-first, P2P ou client-serveur, stockage colonnaire
  compact ; Automerge Repo fournit un backend sync prêt à héberger. Même limite : pas
  relationnel (https://automerge.org/).

---

## Pôle 3 — Selfhost / niveau fichier

| Option | Gratuit | E2EE | macOS+Windows | Continu | Adapté à des données app |
|---|---|---|---|---|---|
| **Syncthing** | Oui (open source, MPL-2.0) | **Oui** (TLS + forward secrecy, pas de serveur central) | Oui (binaries macOS/Windows) | **Oui** (sync continue temps réel) | Fichiers seulement — risque connu sur fichier SQLite brut (ticket séparé) |
| **Nextcloud** | Oui (serveur self-host, clients desktop gratuits) | Partiel (app E2EE, non par défaut) | Oui | Quasi (polling client) | Fichiers seulement ; ops serveur à assumer |
| **iCloud Drive** | 5 GB gratuit | Non | Oui (natif macOS, client Windows) | Oui | Fichiers seulement |
| **OneDrive** | 5 GB gratuit | Non | Oui | Oui | Fichiers seulement |
| **Dropbox** | 2 GB gratuit (Basic) | Non | Oui | Oui | Fichiers seulement |
| **Git** | Oui (si dépôt existant) | Oui (déjà en place) | Oui (git natif) | **Non** (push/pull manuel ou cron) | Export/import de données, pas sync de fichiers app |

Détails par option :

- **Syncthing** : sync de fichiers continue et chiffrée entre vos propres machines, sans
  serveur central ; identité par certificats, seul l'appairage explicite peut connecter un
  device (https://syncthing.net/). Zéro coût, zéro infra. L'inconvénient est l'objet syncé :
  un fichier SQLite vivant (voir ticket dédié « raw SQLite file sync »).
- **Nextcloud** : plateforme open source self-host (gratuite ; support/compliance en
  Enterprise payant), clients desktop Windows/macOS, sync de fichiers continue par le
  client ; chiffrement E2E en option d'app, pas le défaut (https://nextcloud.com/).
- **iCloud Drive** : 5 GB gratuits, intégré macOS, client Windows maintenu par Apple ;
  pas de chiffrement de bout en bout (Apple détient les clés) (https://www.apple.com/icloud/).
- **OneDrive** : 5 GB gratuits, clients macOS + Windows, sync continue ; pas d'E2EE
  (https://www.microsoft.com/en-us/microsoft-365/onedrive/online-cloud-storage).
- **Dropbox** : 2 GB gratuits (Basic), clients macOS + Windows, sync continue ; pas d'E2EE
  (https://www.dropbox.com/pricing).
- **Git** : mécanisme gratuit si le dépôt existe déjà, mais non continu et conflictuel pour
  des données binaires ; utilisable uniquement pour exporter/importer des exports de
  données (ex. settings portables), pas pour sync la base elle-même.

---

## Synthèse — options les plus prometteuses

1. **Turso / libSQL (Turso Sync ou Embedded Replicas)** — seule option qui sync un vrai
   SQLite Drizzle-compatible avec écritures local-first, offline, gratuite ; effort le
   plus faible, coût 0 $ (3 GB sync/mois suffisent).
2. **Backend minimal opéré sur Cloudflare Workers + D1** (ou Railway Free en repli) —
   suit le pattern auth.emdash.sh existant, coût 0 $, row-level sync exploitant les
   colonnes `updatedAt` existantes, contrôle total ; le plus simple à écrire (2 endpoints).
3. **Syncthing** — zéro infra, continu, E2EE ; viable uniquement si le ticket « sync de
   fichier SQLite brut » conclut à une faisabilité (p. ex. base hors-ligne et swap
   atomique), sinon à écarter.
4. **PowerSync (Open Edition self-host ou Cloud free)** — moteur de sync le plus complet
   (conflits, streams, SDK) mais impose un backend Postgres/Mongo et sa propre SQLite
   cliente → ré-architecture forte ; bon plan B si le row-level maison se heurte aux
   conflits.
5. **Replicache (protocol) / Electric (Shapes)** — pas retenus comme produits (maintenance
   mode / Postgres obligatoire), mais leurs protocoles push-pull à cursor servent de
   référence de design pour le serveur minimal du point 2.

## Sources principales

- https://turso.tech/pricing · https://docs.turso.tech/features/embedded-replicas ·
  https://docs.turso.tech/sync/usage
- https://replicache.dev/ · https://www.powersync.com/pricing ·
  https://docs.powersync.com/client-sdk-references/javascript-web/
- https://electric-sql.com/docs/sync · https://electric-sql.com/pricing
- https://supabase.com/pricing · https://firebase.google.com/pricing
- https://developers.cloudflare.com/d1/platform/pricing/ ·
  https://developers.cloudflare.com/workers/platform/pricing/ ·
  https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://fly.io/docs/about/pricing/ · https://railway.com/pricing · https://render.com/pricing
- https://syncthing.net/ · https://nextcloud.com/ · https://automerge.org/ · https://yjs.dev/
- https://www.apple.com/icloud/ ·
  https://www.microsoft.com/en-us/microsoft-365/onedrive/online-cloud-storage ·
  https://www.dropbox.com/pricing
