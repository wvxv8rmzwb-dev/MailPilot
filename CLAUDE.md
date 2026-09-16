# MailPilot — instructions projet

Outil local d'envoi d'emails programmables, connecté à Claude Code via MCP. Mascotte : Pilou 🐱.

Fonctions : campagnes texte ou **HTML** (fallback texte auto), variables `{x}`, quota `daily_cap` respecté en cours d'envoi, liste de **suppressions** (désinscriptions) par compte, **relances auto** N jours après, retry auto des échecs temporaires, envoi test de rendu à soi-même, import CSV fichier (UTF-8/Windows-1252), export CSV des résultats.

## Architecture (2 processus, une SQLite WAL)

- **Daemon** (`npm start`) : scheduler 15 s + dashboard Hono sur http://localhost:3777. C'est lui qui envoie — sans lui, rien ne part.
- **MCP stdio** (`npm run mcp`) : ne fait qu'écrire/lire `data/mailpilot.db`. Le MCP peut mourir avec la session, les envois programmés partent quand même.

## Règles strictes

- **`data/` ne se commit jamais** (contient la base et la clé `.secret`). Déjà gitignored — ne pas désactiver.
- **Les mots de passe SMTP (AES-256-GCM) ne sortent jamais** : aucun log, aucune réponse d'API/MCP, aucun exemple avec un vrai mot de passe.
- **Dashboard en localhost uniquement** — n'ajouter aucune exposition réseau.
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

## Liens

- Repo : https://github.com/wvxv8rmzwb-dev/MailPilot (CI typecheck+tests sur main)
- Landing : https://wvxv8rmzwb-dev.github.io/MailPilot/
- Guide utilisateur : `docs/guide.md`