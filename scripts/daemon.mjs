/**
 * Lanceur utilisé par le service Windows : charge l'API tsx puis démarre
 * le daemon (scheduler + dashboard) dans le même process. Aucune CLI
 * nécessaire. (register du loader direct est refusé par Node 24 :
 * "tsx must be loaded with --import" — tsImport est la voie supportée.)
 */
import { tsImport } from "tsx/esm/api";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
// Windows : le chemin doit être une URL file:// sinon ERR_UNSUPPORTED_ESM_URL_SCHEME.
await tsImport(pathToFileURL(path.join(root, "..", "src", "server.ts")).href, import.meta.url);