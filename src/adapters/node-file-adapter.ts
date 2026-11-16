// FileAdapter em Node puro, para o armazenamento dos checkpoints fora do Obsidian. Só usa fs.
import * as fs from "fs";
import type { FileAdapter } from "../core/history/checkpoints";
import { writeFileAtomic } from "./node-vault";

/** Caminhos absolutos; a gravação é atômica (arquivo .tmp no mesmo diretório e rename) e cria a pasta. */
export function createNodeFileAdapter(): FileAdapter {
  return {
    exists: async (p) => {
      try {
        await fs.promises.access(p);
        return true;
      } catch {
        return false;
      }
    },
    read: (p) => fs.promises.readFile(p, "utf8"),
    write: (p, data) => writeFileAtomic(p, data),
  };
}
