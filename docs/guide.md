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
| Limite quotidienne | vide (Gmail : 500/jour posé automatiquement) | selon ton offre |

> **Quota quotidien** : MailPilot compte les envois du jour par compte. Quand le cap est atteint — même au milieu d'une campagne — il s'arrête et reporte la suite à demain. Le quota restant s'affiche dans le récapitulatif du Composer et l'onglet Comptes.

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
4. Clique **Aperçu du mail** pour voir le rendu comme Amélie le recevra — MailPilot te prévient si une variable manque (`{entreprise}` sans valeur restera vide). Tu peux aussi cliquer **Envoi test à moi-même** : le mail composé, avec des variables d'exemple, part vers ta propre adresse.
5. **Programmer l'envoi** : immédiat, ou planifié à la date/heure de ton choix.

**Format HTML** : bascule le corps en HTML pour un rendu soigné (tableaux, styles, boutons). Le fallback texte est dégradé automatiquement pour les clients sans HTML, et les variables `{x}` restent remplaçées.

**Pièces jointes** : ajoute un PDF ou une image dans le Composer (10 Mo max au total). Chaque destinataire reçoit sa copie. Les relances auto ne repartent pas avec la pièce jointe.

**Variables globales** : dans **Réglages**, définis une fois des variables valables partout (`signature`, `lien_calendly`... au format `cle = valeur`). Elles deviennent des chips cliquables dans le Composer et se remplacent comme les autres : `{signature}`.

**Relance automatique** : coche-la dans le rail, choisis un nombre de jours + un sujet et un corps de relance. Dès la campagne terminée, MailPilot programme le follow-up **aux destinataires qui ont bien reçu le premier mail** (les désinscrits en sont exclus automatiquement).

**Cooldown** : par défaut, un contact servi il y a moins de 7 jours ne reçoit pas de second mail (réglable dans Réglages, `cooldown_days` 0 = off). Les relances ne sont pas concernées — c'est leur rôle.

Chaque contact reçoit **son propre mail individuel** — jamais de liste visible. L'envoi est séquentiel (3 s entre chaque mail) pour respecter les serveurs : une campagne de 500 contacts part en ~25 minutes, et le cap quotidien du compte coupe proprement si besoin (le reste part demain).

**Par défaut** : mention de désinscription ajoutée en pied de mail + header `List-Unsubscribe` (obligatoire en cold email France, et bon signal pour les boîtes mail).

### Les listes de contacts

Pour ne pas retaper tes contacts : onglet **Contacts** (import direct d'un fichier CSV, encodage UTF-8 ou Windows-1252 détecté automatiquement), ou via Claude Code `import_contacts` avec un CSV :

```csv
email,nom,prenom,entreprise
amelie.fournier@of-lyon.fr,Amélie Fournier,Amélie,OF Lyon
karim.benali@cfa-paris.fr,Karim Benali,Karim,CFA Paris
```

### Les désinscriptions

Quand un contact répond « STOP » ou rebondit durablement, inscris-le dans **Contacts → Désinscriptions** (ou via Claude Code `add_suppression`). Il sera **exclu automatiquement de toutes les futures campagnes et relances** de ce compte — même s'il est présent dans une liste. Tu peux le réinscrire en un clic.

### La surveillance des réponses (IMAP)

Dans **Réglages → Réponses STOP et bounces**, configure la boîte de réception du compte (pour Gmail : `imap.gmail.com`, port 993, le même mot de passe d'application). MailPilot la lit périodiquement :

- une réponse contenant « STOP », « désinscription », « unsubscribe »… → le contact est **désinscrit automatiquement** ;
- un rapport d'échec **définitif** (boîte inexistante, adresse rejetée) → désinscrit aussi ;
- un échec **temporaire** (boîte pleine, serveur occupé) → ignoré, ça se résout souvent seul.

### L'historique d'un contact

Dans **Contacts**, clique sur un contact : tu vois toutes ses campagnes, les dates, le statut de chaque envoi, et ses désinscriptions éventuelles.

### Le warm-up (compte neuf)

Un compte tout neuf qui envoie 200 mails le premier jour se fait souvent bloquer. Active **Warm-up progressif** dans le formulaire du compte : MailPilot limite tout seul la montée en charge (~15 envois le premier jour, +15 par jour — réglable dans Réglages). Le plafond le plus strict entre la limite du fournisseur et le warm-up s'applique ; quand la montée est terminée, désactive-le depuis la liste des comptes.

### Le rapport quotidien

Chaque soir (20:00 par défaut, réglable), les comptes qui ont eu de l'activité reçoivent chez eux un récap : envois du jour, quota restant, échecs en attente, campagnes programmées. Réglable dans **Réglages → Rythme d'envoi**.

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

`list_accounts` · `add_account` · `test_account` · `send_test` · `send_now` · `schedule_campaign` · `preview_campaign` · `list_campaigns` · `campaign_status` · `retry_failed_campaign` · `cancel_campaign` · `save_template` · `list_templates` · `delete_template` · `import_contacts` · `list_contacts` · `add_suppression` · `list_suppressions` · `remove_suppression` · `list_variables` · `set_variables`

---

## 5. Bien envoyer (délivrabilité)

- **Gmail** : les limites sont celles de Google (~500 mails/jour en gratuit, ~2 000 en Workspace — pas MailPilot). Le cap de 500/jour est posé automatiquement à la création du compte, et MailPilot respecte la limite **pendant** l'envoi : le surplus part le lendemain au lieu de te faire bloquer. Un avertissement s'affiche dans le formulaire dès que tu saisis un hôte Gmail.
- **Domaine perso** (OVH, Zoho, ton propre SMTP) : **aucune limite imposée par MailPilot** (cap illimité par défaut) — configure quand même SPF, DKIM et DMARC avant d'envoyer en volume, et reste raisonnable avec ton hébergeur.
- **Échecs temporaires** : erreur réseau ou SMTP injoignable au moment d'une campagne → MailPilot réessaie tout seul 15 minutes plus tard (une fois, réglable via `max_auto_retries` dans `settings`). Les échecs définitifs (boîte inexistante...) restent manuels : « Relancer les échecs ».
- **Fenêtre d'envoi** : par défaut 08:00–20:00 (heure locale). Un mail programmé à minuit part au matin — c'est voulu, un mail reçu à 3h sent le robot. Modifiable via les clés `send_window_start` / `send_window_end` de la table `settings`.
- **Délai inter-mails** : 3 s par défaut (`send_delay_ms`). Ne le descends pas trop.
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