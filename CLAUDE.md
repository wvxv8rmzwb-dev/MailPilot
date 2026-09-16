# MailPilot — instructions projet

Outil local d'envoi d'emails programmables, connecté à Claude Code via MCP. Mascotte : Pilou 🐱.

Fonctions : campagnes texte ou **HTML** (fallback texte auto), variables `{x}` + **variables globales** (settings `global_vars`, ex `{signature}`), pièces **jointes** (data/attachments/<id>/), quota `daily_cap` respecté en cours d'envoi, liste de **suppressions** (désinscriptions) par compte, **relances auto** N jours après, **cooldown inter-campagnes** (settings `cooldown_days`, défaut 7 j — un contact servi récemment est exclu avec warning), retry auto des échecs temporaires, envoi test de rendu à soi-même, import CSV fichier (UTF-8/Windows-1252), export CSV des résultats, **rapport quotidien** à soi-même (settings `report_hour`, défaut 20:00, saute les comptes sans activité), **warm-up progressif** par compte (case à cocher ; plafond `warmup_base` + `warmup_step`×jour, croise le daily_cap — le plus strict gagne, via `effectiveCap`/`remainingQuota`), **historique par contact** (dashboard, clic sur un contact), **poll IMAP** des réponses STOP + bounces durs → suppressions auto (`src/imap.ts`, config par compte via API/dashboard, poll toutes les `imap_poll_minutes`).

## Architecture (2 processus, une SQLite WAL)

- **Daemon** (`npm start`) : scheduler 15 s + dashboard Hono sur http://localhost:3777. C'est lui qui envoie — sans lui, rien ne part.
- **MCP stdio** (`npm run mcp`) : ne fait qu'écrire/lire `data/mailpilot.db`. Le MCP peut mourir avec la session, les envois programmés partent quand même.

## Règles strictes

- **`data/` ne se commit jamais** (contient la base et la clé `.secret`). Déjà gitignored — ne pas désactiver.
- **Les mots de passe SMTP (AES-256-GCM) ne sortent jamais** : aucun log, aucune réponse d'API/MCP, aucun exemple avec un vrai mot de passe. Idem pour `imap_password_enc`.
- **Dashboard en localhost uniquement** — n'ajouter aucune exposition réseau. (Pas de tracking ouvertures/clics : exigerait un endpoint public, interdit par cette règle.)
- Cap 500 destinataires par campagne (settings `max_recipients`), format de ligne : `email ; nom ; cle=valeur`.

## Commandes

```bash
npm start             # daemon + dashboard :3777
npm run mcp           # serveur MCP stdio
npm test              # tests unitaires (tsx --test)
npm run typecheck     # tsc --noEmit
npm run service:install / service:uninstall   # service Windows (PowerShell admin)
```

## Pièges connus

- Dates en SQLite `YYYY-MM-DD HH:MM:SS` **UTC** (jamais d'ISO avec `T`), sinon `scheduled_at <= datetime('now')` ne matche jamais.
- Le scheduler ne ramasse que `status = 'scheduled'` ; les campagnes `sending` orphelines sont reprises par `recoverOrphanedCampaigns()` au démarrage du daemon.
- Fenêtre d'envoi 08:00–20:00 locale (settings `send_window_start`/`end`) — un test bloqué après 20h est normal, pas un bug.
- Après un `TaskStop` du daemon, tuer l'orphelin qui tient le port : `netstat -ano | grep :3777` puis `taskkill //PID <pid> //F`.
- Port 465 = SSL, 587 = STARTTLS. Gmail = 2FA + mot de passe d'application.
- **Quota (`daily_cap`)** : 0 = illimité ; vide à la création = 500 pour Gmail (`defaultDailyCap`). Respecté **pendant** l'envoi (`opts.remaining` dans `sendToRecipients`) : à épuisement, les destinataires restent `pending` et la campagne repart demain (`error` = "reportés à demain"). Ne pas retirer le `continue` après `postponeIfDailyCapped` dans `tick()`.
- **Format HTML** (`campaigns.body_format`) : le corps EST du HTML, le texte est dégradé via `htmlToText` (render.ts) ; en mode `text` c'est l'inverse (`textToHtml`).
- **Suppressions** (`add_suppression`/`remove_suppression`) : filtrées dans `queueCampaign` et à la création des relances — un désinscrit ne doit plus jamais recevoir de mail du compte.
- **Relances auto** (`followup_days/subject/body` sur campaigns) : programmées par `scheduleFollowUp()` quand une campagne finit avec des envois `sent` ; ciblent les `sent` uniquement. `auto_retries` plafonne le retry auto des échecs temporaires globaux (settings `max_auto_retries`, défaut 1).
- **Warm-up** (`smtp_accounts.warmup`) : `effectiveCap()` = min(daily_cap, plafond warm-up du jour). `postponeIfDailyCapped` utilise `remainingQuota` (ne pas remettre une lecture brute de `daily_cap`).
- **Pièces jointes** : `attachments_json` sur campaigns = [{filename, path}] ; fichiers réellement écrits dans `data/attachments/<id>/` (base64 reçu de l'API, 10 Mo max total, noms neutralisés).
- **IMAP** (`src/imap.ts`) : ne traite que les messages **non lus**, les marque lus ensuite ; bounce doux (4.x.x, boîte pleine) → ignoré, dur (5.x.x, user unknown) → suppression. Config IMAP par compte : `imap_host` vide = désactivé.
- `MAILPILOT_DATA_DIR` (env) redirige `data/` — utilisé par les tests (base isolée), jamais sur la vraie install.
- GSAP **et les polices** (woff2 dans `src/fonts/`, route `/fonts/:name`) sont servis localement — pas de CDN, le dashboard doit marcher hors-ligne.

## Liens

- Repo : https://github.com/wvxv8rmzwb-dev/MailPilot (CI typecheck+tests sur main)
- Landing : https://wvxv8rmzwb-dev.github.io/MailPilot/
- Guide utilisateur : `docs/guide.md`