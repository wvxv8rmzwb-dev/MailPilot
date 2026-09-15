# MailPilot — instructions projet

Outil local d'envoi d'emails programmables, connecté à Claude Code via MCP. Mascotte : Pilou 🐱.

## Architecture (2 processus, une SQLite WAL)

- **Daemon** (`npm start`) : scheduler 15 s + dashboard Hono sur http://localhost:3777. C'est lui qui envoie — sans lui, rien ne part.
- **MCP stdio** (`npm run mcp`) : ne fait qu'écrire/lire `data/mailpilot.db`. Le MCP peut mourir avec la session, les envois programmés partent quand même.

## Règles strictes

- **`data/` ne se commit jamais** (contient la base et la clé `.secret`). Déjà gitignored — ne pas désactiver.
- **Les mots de passe SMTP (AES-256-GCM) ne sortent jamais** : aucun log, aucune réponse d'API/MCP, aucun exemple avec un vrai mot de passe.
- **Dashboard en localhost uniquement** — n'ajouter aucune exposition réseau.
- Cap 100 destinataires par campagne, format de ligne : `email ; nom ; cle=valeur`.

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
- Port 465 = SSL, 587 = STARTTLS. Gmail = 2FA + mot de passe d'application, daily_cap 500.

## Liens

- Repo : https://github.com/wvxv8rmzwb-dev/MailPilot (CI typecheck+tests sur main)
- Landing : https://wvxv8rmzwb-dev.github.io/MailPilot/
- Guide utilisateur : `docs/guide.md`