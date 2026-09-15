/**
 * Lanceur utilisé par le service Windows : charge le loader tsx puis
 * démarre le daemon (scheduler + dashboard). Aucune CLI nécessaire.
 */
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
register(
  pathToFileURL(path.join(root, "node_modules", "tsx", "dist", "loader.mjs")),
  pathToFileURL(path.join(root, path.sep))
);
await import(pathToFileURL(path.join(root, "src", "server.ts")).href);