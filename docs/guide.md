# Guide MailPilot 🐱✈️

Bienvenue ! Ce guide t'accompagne de zéro à ta première campagne envoyée. Compte 15 minutes.

---

## 0. Ce dont tu as besoin

| Prérequis | Pourquoi |
|---|---|
| **Node.js 18+** ([nodejs.org](https://nodejs.org)) | fait tourner le daemon et le MCP |
| **Claude Code** (optionnel mais recommandé) | pour piloter MailPilot en langage naturel |
| **Une adresse email avec SMTP** | Gmail (gratuit), OVH, Zoho, ton domaine perso... |

> Gmail : tu dois activer la **double authentification** puis créer un **mot de passe d'application** (Google → Compte → Sécurité → Mots de passe d'application). Ce mot de passe de 16 caractères, c'est lui que tu mettras dans MailPilot — **jamais** ton mot de passe principal.

---

## 1. Installation (2 minutes)

```bash
git clone https://github.com/wvxv8rmzwb-dev/MailPilot.git
cd MailPilot
npm install
npm start
```

Tu devrais voir :

```
MailPilot dashboard : http://localhost:3777
```

Ouvre **http://localhost:3777** dans ton navigateur : c'est le dashboard. Tout se passe sur ta machine — aucun de tes emails ne transite par un serveur tiers.

> **Windows — service en tâche de fond (optionnel)** : pour que les mails programmés partent même sans fenêtre ouverte, lance dans un PowerShell **en administrateur** : `npm run service:install`. MailPilot démarre alors avec Windows.

---

## 2. Ajouter ton compte envoyeur (2 minutes)

Dans le dashboard, onglet **Comptes SMTP** :

| Champ | Exemple Gmail | Exemple OVH |
|---|---|---|
| Libellé | `Pro Gmail` | `Pro OVH` |
| Serveur | `smtp.gmail.com` | `ssl0.ovh.net` |
| Port | `465` | `465` |
| Utilisateur | toi@gmail.com | toi@tondomaine.fr |
| Mot de passe | mot de passe d'application | mot de passe boîte |
| Limite quotidienne | `500` (Gmail coupe au-delà) | selon ton offre |

Clique **Ajouter le compte**, puis **Test** : un mail part vers ta propre adresse. S'il arrive, tout est bon. ✈️

---

## 3. Ta première campagne (3 minutes)

Onglet **Composer** :

1. **Compte envoyeur** : choisis ton compte
2. **Sujet et corps** : utilise des variables entre accolades
   ```
   Bonjour {prenom},

   Une question rapide sur {entreprise} : est-ce que la certification
   Qualiopi est un sujet pour cette année ?
   ```
3. **Destinataires** : une ligne par contact
   ```
   amelie.fournier@of-lyon.fr ; Amélie Fournier ; entreprise=OF Lyon
   karim.benali@cfa-paris.fr ; Karim Benali ; entreprise=CFA Paris
   ```
4. Clique **Aperçu du mail** pour voir le rendu comme Amélie le recevra — MailPilot te prévient si une variable manque (`{entreprise}` sans valeur restera vide).
5. **Programmer l'envoi** : immédiat, ou planifié à la date/heure de ton choix.

Chaque contact reçoit **son propre mail individuel** — jamais de liste visible. L'envoi est séquentiel (3 s entre chaque mail) pour respecter les serveurs : une campagne de 100 contacts part en ~5 minutes.

**Par défaut** : mention de désinscription ajoutée en pied de mail + header `List-Unsubscribe` (obligatoire en cold email France, et bon signal pour les boîtes mail).

### Les listes de contacts

Pour ne pas retaper tes contacts : onglet **Contacts**, ou via Claude Code `import_contacts` avec un CSV :

```csv
email,nom,prenom,entreprise
amelie.fournier@of-lyon.fr,Amélie Fournier,Amélie,OF Lyon
karim.benali@cfa-paris.fr,Karim Benali,Karim,CFA Paris
```

---

## 4. Brancher Claude Code (1 minute)

Dans un terminal :

```bash
claude mcp add mailpilot -- npm --prefix /chemin/vers/MailPilot run mcp
```

(Windows : `--prefix C:\Users\toi\MailPilot` — Mac/Linux : `--prefix ~/MailPilot`)

Redémarre Claude Code, puis parle simplement :

> « Programme un mail pour demain 9h à ma liste Prospection OF, sujet "Bonjour {prenom}, une question sur {entreprise}" »

> « Montre-moi le statut de la campagne 3 »

> « Relance les envois qui ont échoué »

Les mails programmés partent **même si ta session Claude Code est fermée** : c'est le daemon qui les déclenche, pas Claude.

### Tous les outils MCP

`list_accounts` · `add_account` · `test_account` · `send_now` · `schedule_campaign` · `preview_campaign` · `list_campaigns` · `campaign_status` · `retry_failed_campaign` · `cancel_campaign` · `save_template` · `list_templates` · `delete_template` · `import_contacts` · `list_contacts`

---

## 5. Bien envoyer (délivrabilité)

- **Gmail** : ~500 mails/jour maximum. Mets `daily_cap: 500` sur le compte : MailPilot repousse les campagnes au lendemain au lieu de te faire bloquer.
- **Fenêtre d'envoi** : par défaut 08:00–20:00 (heure locale). Un mail programmé à minuit part au matin — c'est voulu, un mail reçu à 3h sent le robot. Modifiable via les clés `send_window_start` / `send_window_end` de la table `settings`.
- **Délai inter-mails** : 3 s par défaut (`send_delay_ms`). Ne le descends pas trop.
- **Domaine perso** : configure SPF, DKIM et DMARC avant d'envoyer en volume.
- **Warm-up** : un compte neuf n'envoie pas 100 mails le premier jour. Monte progressivement (10, 25, 50...).
- **Légal (France, LCEN/CGPR)** : mention de l'expéditeur + voie de désinscription obligatoires (activées par défaut). Cold email vers des particuliers sans opt-out : interdit. En B2B : respecte les oppositions.

---

## 6. Dépannage

| Problème | Solution |
|---|---|
| « Daemon éteint » dans le dashboard | lance `npm start` (ou installe le service Windows) |
| Le mail test échoue avec Gmail | mot de passe d'application requis (pas le mot de passe du compte), 2FA activée |
| `EADDRINUSE :3777` | le daemon tourne déjà — ouvre juste le dashboard, ou tue l'ancien processus |
| Une campagne reste « Planifié » | heure hors fenêtre d'envoi ? cap quotidien atteint ? le daemon tourne ? |
| Variables vides dans le mail | ajoute `cle=valeur` sur la ligne du contact, ou dans le CSV |
| Erreur SSL/TLS | vérifie le port : 465 = SSL, 587 = STARTTLS |

---

## 7. Tes données (et pourquoi elles restent chez toi)

Tout vit dans `MailPilot/data/` (jamais envoyé, jamais commité) :

- `mailpilot.db` — contacts, campagnes, historique
- `.secret` — clé de chiffrement de tes mots de passe SMTP (AES-256-GCM)

**Sauvegarde** = copie le dossier `data/`. **Migration vers un autre PC** = copie le dossier `data/` + le code. **Désinstallation** = supprime le dossier.

---

Des questions ? Ouvre une [issue sur GitHub](https://github.com/wvxv8rmzwb-dev/MailPilot/issues). Pilou est aux commandes. 🐱