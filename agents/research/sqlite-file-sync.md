# Recherche : sync de fichier SQLite — viabilité

Issue: [64ix/emdash#111](https://github.com/64ix/emdash/issues/111) — « Recherche : sync de
fichier SQLite — viabilité ». Recherche read-only (code + web), en appui d'une décision
multi-machine (2 machines personnelles). Pas de conclusion sur la solution globale ; ce
document répond à UNE question : est-il sûr de synchroniser le fichier `emdash4.db` par
sync de fichiers (Syncthing / iCloud / OneDrive / Dropbox…) pendant que l'app tourne et
écrit ?

---

## 1. Faits locaux : configuration du client SQLite (file:line)

Chemin app : `apps/emdash-desktop/src/main/db/`. Tous les chemins ci-dessous sont relatifs
à ce dossier.

- **Ouvre le fichier read-write, en continu, pour toute la vie de l'app.** Le singleton
  est créé à l'import du module : `new Database(resolveDatabasePath())` puis
  `journal_mode = WAL` et `busy_timeout = 5000` (`client.ts:11-13`). Importé depuis
  `src/main/index.ts:46,115` au boot — donc connexion ouverte en permanence, jamais
  fermée dans le chemin de production (aucun `sqlite.close()` sur le singleton hors tests
  et legacy-port). La connexion est toujours là, prête à écrire.
- **Journal mode = WAL.** `PRAGMA journal_mode = WAL` (`client.ts:12`,
  `drizzleClient.ts:26`). Conséquences (détaillées §2) : les écritures vont dans
  `emdash4.db-wal`, coordonnées via le fichier `emdash4.db-shm` ; le fichier principal
  est modifié uniquement par checkpoint ; il existe donc **trois fichiers** dont la
  cohérence est liée.
- **`synchronous` non spécifié** : défaut SQLite, **FULL** (`client.ts` n'a que les 2
  pragmas ; pareil dans `drizzleClient.ts:24-29`). Donc chaque commit sync le WAL —
  bonne durabilité locale, mais ne change rien au risque de sync de fichiers.
- **`busy_timeout = 5000`** (`client.ts:13`) : l'app attend 5 s en cas de verrou, puis
  échoue avec `SQLITE_BUSY` — utile si un outil externe touche au fichier, mais n'empêche
  pas la corruption par un sync agent (cf. §2).
- **Aucun checkpoint géré par l'app.** `grep wal_checkpoint|checkpoint` sur
  `src/main/` : rien. On s'en remet au checkpoint automatique par défaut (WAL ≈ 1000 pages
  ≈ ~4 Mo, `sqlite.org/wal.html` §6) — pas de fenêtre « fichier au repos » garantie.
- **Migrations DDL à chaque démarrage** : `initializeDatabase()` (`initialize.ts:142-153`)
  exécute `runBundledMigrations()` (requêtes DDL des migrations Drizzle,
  `initialize.ts:15-49`), puis `ensureSearchIndex()` et `ensureFileIndex()` — des
  `CREATE VIRTUAL TABLE` / `DROP TABLE` FTS5 versionnés par la table `kv`
  (`initialize.ts:57-129`). Toute cette DDL tourne sur le singleton au boot
  (`main/index.ts:115`), alors qu'une autre machine peut avoir le même fichier ouvert.
  Deux versions d'app différentes = schémas différents = sync de fichiers impossible
  entre elles.
- **Fichier : `emdash4.db`** dans le userData Electron (`default-path.ts:4-5`,
  `database-file.ts:37-52`) ; override via `EMDASH_DB_FILE` (`path.ts:11-14`). `emdash3.db`
  est converti en `emdash4.db` au premier lancement.
- **Le code a déjà le pattern sûr** : `copySqliteDatabase()` (`database-file.ts:10-20`)
  copie une base vivante via `VACUUM INTO` (snapshot SQLite officiel, cf. §3.2) en
  read-only avec busy_timeout — utilisé pour la migration v3 → v4
  (`database-file.ts:41-49`). C'est exactement le mécanisme qu'un futur export de sync
  pourrait réutiliser.
- Pas de contrainte de taille connue dans le code ; à noter : le WAL est plafonné ~4 Mo
  par checkpoint auto, et le DB porte des index FTS5 (reconstruits au boot).

Conclusion factuelle : **l'app est dans le pire cas pour une sync de fichiers** — WAL
actif, connexion ouverte read-write en permanence, écritures fréquentes, DDL au démarrage,
pas de checkpoint contrôlé.

---

## 2. Risque de la sync de fichiers en WAL (sources)

- **Un DB WAL n'est pas un fichier unique.** Les données validées vivent dans
  `-wal` jusqu'au checkpoint ; le fichier `-wal` « fait partie de l'état persistant de la
  base » et « si la base est séparée de son WAL, des transactions déjà validées peuvent
  être perdues, ou le fichier peut devenir corrompu »
  ([sqlite.org/wal.html §4](https://www.sqlite.org/wal.html#wal_database_is_special)).
  Les « -shm » et « -wal » existent tant qu'une connexion est ouverte, sont recréés au
  premier accès et supprimés à la fermeture de la dernière connexion
  ([wal.html §4](https://www.sqlite.org/wal.html#the_wal_file),
  [wal.html §6](https://www.sqlite.org/wal.html#wal_autocheckpoint)).
- **Copier le fichier pendant une transaction = corruption** : « Systems that run
  automatic backups in the background might try to make a backup copy of an SQLite
  database file while it is in the middle of a transaction. The backup copy then might
  contain some old and some new content, and thus be corrupt »
  ([sqlite.org/howtocorrupt.html §1.2](https://www.sqlite.org/howtocorrupt.html#backup_or_restore_while_a_transaction_is_active)).
  C'est exactement ce que fait un agent de sync (Syncthing, Dropbox, iCloud…) : il
  photographie le fichier à un instant t, sans connaissance des transactions.
- **Copier sans le journal = corruption** : « Copying a database file without also
  copying its journal » est listé parmi les causes de corruption
  ([howtocorrupt.html §1.4](https://www.sqlite.org/howtocorrupt.html#mispairing_database_files_and_hot_journals)).
  Un agent de sync qui transporte `emdash4.db` et `emdash4.db-wal` séparément peut très
  bien livrer le WAL après la base, ou un WAL orphelin — « swapping journal files between
  two databases » / « overwriting a journal file » sont tout aussi dangereux.
- **Verrouillage par fichiers réseau peu fiable** : SQLite « might not work correctly if
  the database file is kept on an NFS filesystem » et « sharing an SQLite database
  between two or more Windows machines might cause unexpected problems »
  ([sqlite.org/faq.html #5](https://www.sqlite.org/faq.html#q5)) ; « network filesystems »
  cité parmi les verrous cassés
  ([howtocorrupt.html §2.1](https://www.sqlite.org/howtocorrupt.html#filesystems_with_broken_or_missing_lock_implementations)).
  Or « All processes using a database must be on the same host computer; WAL does not work
  over a network filesystem » ([wal.html §1](https://www.sqlite.org/wal.html#overview)).
- **Mécanique des outils de sync** : Syncthing découpe en blocs, écrit dans un fichier
  temporaire `.syncthing.xxx.tmp` puis rename, et résout les conflits **par fichier**
  (le perdant devient `*.sync-conflict-<date>-<by>.ext`)
  ([docs.syncthing.net/users/syncing.html](https://docs.syncthing.net/users/syncing.html#temporary-files),
  [syncing.html#conflicting-changes](https://docs.syncthing.net/users/syncing.html#conflicting-changes)).
  Les trois fichiers (db/-wal/-shm) sont donc synchronisés **indépendamment, dans un
  ordre non garanti**, avec des conflits dupliqués au lieu d'une fusion — exactement le
  scénario de mispairing ci-dessus. Syncthing lui-même dit de ses propres bases « My
  Syncthing database is corrupt » = à supprimer et re-synchroniser
  ([faq.syncthing.net](https://docs.syncthing.net/users/faq.html#my-syncthing-database-is-corrupt)).
- **iCloud / Dropbox / OneDrive** : pas de doc vendor SQLite-spécifique, mais guidance
  communautaire unanime : « You have to copy the database out of the cloud sync folder,
  connect to it, do your stuff, disconnect, then copy the database back into the cloud
  sync folder. Otherwise you risk corrupting the database with all automatic cloud sync
  services » ([Xojo forum, "Sqlite files on iCloud or Dropbox", 2026-03](https://forum.xojo.com/t/sqlite-files-on-icloud-or-dropbox/87972)).
  iCloud Drive ajoute le risque d'éviction (« Optimiser le stockage ») : un fichier
  placéhôte peut être remplacé par un placeholder — un DB WAL non présent localement ne
  s'ouvre pas correctement ([wal.html §5](https://www.sqlite.org/wal.html#readonly_databases)
  exige -shm/-wal présents ou du write sur le dossier).

Verdict technique : la sync de fichiers d'un DB WAL **vivant** (app ouverte, écrivant)
n'est pas sûre — pas de condition d'erreur « gentille » : le DB est simplement corrompu
silencieusement, détectable seulement au prochain `SQLITE_CORRUPT`.

---

## 3. Alternatives sûres, évaluées (sources)

1. **Copie uniquement quand l'app est fermée.** Si aucune connexion n'est ouverte, le
   fichier principal est cohérent ; encore faut-il que `-wal` n'existe pas ou soit copié
   avec ([howtocorrupt.html §1.2](https://www.sqlite.org/howtocorrupt.html#backup_or_restore_while_a_transaction_is_active)).
   En WAL, la fermeture propre de la dernière connexion checkpoint + supprime `-wal`/`-shm`
   ([wal.html §4](https://www.sqlite.org/wal.html#the_wal_file)) — donc « copier à froid »
   marche, mais seulement si l'app s'est fermée proprement et que l'outil de sync ne
   photographie pas pendant un autre remplacement. Acceptable pour du « sync à l'arrêt »
   (2 machines personnelles), fragile en pratique (crash → hot WAL laissé sur disque).
2. **Snapshot via `VACUUM INTO` / backup API — le pattern officiel et déjà dans le code.**
   `VACUUM INTO` produit « a consistent snapshot of the original database », taille
   minimale, syncée sur disque ([sqlite.org/lang_vacuum.html §2.1](https://www.sqlite.org/lang_vacuum.html#vacuuminto)).
   Le backup API fait la même chose incrémentalement
   ([sqlite.org/backup.html](https://www.sqlite.org/backup.html)) ; `sqlite3_rsync` copie
   un DB vivant en distant via SSH ([backup.html §1.1](https://www.sqlite.org/backup.html#other_backup_techniques),
   [howtocorrupt.html §1.2](https://www.sqlite.org/howtocorrupt.html#backup_or_restore_while_a_transaction_is_active)).
   **emdash l'utilise déjà** : `copySqliteDatabase()` = `VACUUM INTO`
   (`database-file.ts:16`). Un « export → dossier sync » puis « import au boot si
   snapshot plus récent » est le chemin de moindre résistance : l'export est sûr même app
   ouverte ; l'import doit se faire avant `initializeDatabase()` (`initialize.ts:142`),
   les migrations étant ensuite ré-exécutées par la machine réceptrice
   (compatible si versions d'app identiques ; sinon, migrer d'abord puis exporter).
3. **Réplication de delta au niveau WAL (type Litestream).** Litestream lit le WAL en
   continu et le réplique en fichiers de transactions (LTX) + snapshots périodiques,
   restaurés en appliquant les LTX dans l'ordre
   ([litestream.io/how-it-works](https://litestream.io/how-it-works/)). C'est le pattern
   « oplog/delta » du cahier des charges — robuste, mais c'est un service externe, et
   **pas** de la sync bidirectionnelle multi-écrivains : chaque machine aurait besoin de
   son propre flux et d'une stratégie de fusion.
4. **Oplog/delta applicatif (l'app écrit des mutations dans une table synchro).** Les
   deltas sont de petits fichiers que la sync de fichiers transporte sans risque (écrits
   en append/rename atomique) ; la machine réceptrice les rejoue dans sa base. Nécessite
   : schéma stable entre machines, règles de conflit (last-write-wins par ligne, ou
   CRDT), et acceptation d'un DB éventuellement divergent. C'est le seul pattern de sync
   **bidirectionnelle à chaud** viable sans serveur.
5. **À rejeter** : syncer `emdash4.db` (+ `-wal`/`-shm`) en direct (corruption, cf. §2) ;
   placer le userData entier dans iCloud/Dropbox avec l'app qui tourne (mêmes risques +
   éviction de fichiers) ; LiteFS/rqlite (architecture multi-nœuds, hors sujet pour
   2 machines personnelles hors ligne).

---

## 4. Recommandation pour emdash (bottom line)

- **Ne pas synchroniser `emdash4.db` par sync de fichiers tant que l'app tourne.**
  L'app est WAL, ouverte read-write en permanence (`client.ts:11-13`), avec DDL de
  migrations au démarrage (`initialize.ts:142-153`) et zéro contrôle de checkpoint : elle
  incarne exactement le scénario que sqlite.org qualifie de corrupteur
  ([howtocorrupt.html §1.2](https://www.sqlite.org/howtocorrupt.html#backup_or_restore_while_a_transaction_is_active),
  [wal.html §4](https://www.sqlite.org/wal.html#the_wal_file)). Syncthing synchroniserait
  `db`/`-wal`/`-shm` comme trois fichiers indépendants avec des conflits dupliqués
  ([syncthing docs](https://docs.syncthing.net/users/syncing.html#conflicting-changes)) ;
  iCloud/Dropbox ajoutent éviction et snapshots non atomiques (Xojo forum,
  [lien](https://forum.xojo.com/t/sqlite-files-on-icloud-or-dropbox/87972)).
- **Pattern retenu (le plus viable pour 2 machines personnelles)** : snapshot
  `VACUUM INTO` — déjà implémenté (`database-file.ts:10-20`) — exporté périodiquement
  (et à la fermeture) vers un dossier de sync, importé sur l'autre machine au boot,
  avant `initializeDatabase()`. Même schéma requis sur les deux machines (mêmes versions
  d'app) ; c'est du « last-writer-wins par snapshot », simple et sûr car l'export est
  valide même app ouverte et l'import se fait app fermée (ou au démarrage).
- **Si la sync doit être bidirectionnelle à chaud**, il faut un oplog applicatif
  (mutations dans une table + replay) — pattern delta, cf. Litestream
  ([how-it-works](https://litestream.io/how-it-works/)) — et assumer un vrai sujet de
  conception (schéma, conflits), pas un réglage d'outil. La sync de fichiers seule ne
  peut pas la fournir : ce n'est pas un problème de réglage mais de modèle de données.

Sources clés :
[wal.html](https://www.sqlite.org/wal.html) ·
[howtocorrupt.html](https://www.sqlite.org/howtocorrupt.html) ·
[backup.html](https://www.sqlite.org/backup.html) ·
[lang_vacuum.html](https://www.sqlite.org/lang_vacuum.html) ·
[faq.html#q5](https://www.sqlite.org/faq.html#q5) ·
[docs.syncthing.net/users/syncing.html](https://docs.syncthing.net/users/syncing.html) ·
[docs.syncthing.net/users/faq.html](https://docs.syncthing.net/users/faq.html) ·
[litestream.io/how-it-works](https://litestream.io/how-it-works/) ·
[litestream.io/alternatives](https://litestream.io/alternatives/) ·
[Xojo forum iCloud/Dropbox](https://forum.xojo.com/t/sqlite-files-on-icloud-or-dropbox/87972).
