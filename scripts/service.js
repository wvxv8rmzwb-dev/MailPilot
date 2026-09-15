/**
 * Service Windows MailPilot (via node-windows) : le daemon tourne en tâche
 * de fond, redémarre tout seul au boot et après un plantage — les mails
 * programmés partent sans qu'on ait besoin de lancer `npm start`.
 *
 * Installation  (PowerShell en administrateur) : npm run service:install
 * Désinstallation (PowerShell en administrateur) : npm run service:uninstall
 */
import { Service } from "node-windows";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const svc = new Service({
  name: "MailPilot",
  description:
    "Daemon MailPilot : envoi des campagnes programmées + dashboard http://localhost:3777",
  script: path.join(root, "scripts", "daemon.mjs"),
  // Laisse Pilou respirer : 10 s avant de compter un crash, max 3 redémarrages rapides.
  wait: 10,
  grow: 0.25,
  maxRestarts: 3,
});

const cmd = process.argv[2];

if (cmd === "install") {
  svc.on("install", () => {
    console.log("Service MailPilot installé. Démarrage…");
    svc.start();
  });
  svc.on("start", () => console.log("MailPilot tourne. Dashboard : http://localhost:3777"));
  svc.on("error", (e) => { console.error("Erreur :", e); process.exitCode = 1; });
  svc.install();
} else if (cmd === "uninstall") {
  svc.on("uninstall", () => console.log("Service MailPilot désinstallé."));
  svc.on("alreadyinstalled", () => console.log("Le service n'était pas installé."));
  svc.on("error", (e) => { console.error("Erreur :", e); process.exitCode = 1; });
  svc.uninstall();
} else {
  console.log("Usage : node scripts/service.js install|uninstall");
  process.exitCode = 1;
}