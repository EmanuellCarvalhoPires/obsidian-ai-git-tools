// Interface strings in English and Portuguese. Picks the language of the Obsidian interface.
import { getLanguage } from "obsidian";

type Table = Record<string, string>;

const en: Table = {
  "dependency.title": "AI Ecosystem is required",
  "dependency.body":
    "AI Git Tools needs the AI Ecosystem plugin. It provides the local server and MCP endpoint that AI agents use for git, GitHub and Bitbucket.",
  "dependency.standby":
    "AI Git Tools stays in standby until the AI Ecosystem is installed and enabled, and connects automatically as soon as it starts.",
  "dependency.install": "Install and enable AI Ecosystem",
  "dependency.openPage": "Open plugin page",
  "dependency.installed": "AI Ecosystem installed and enabled.",
  "dependency.failed": "Could not install automatically. Opening the plugin page.",

  "graph.missingProject": "Name the project in the block (projeto: Name).",
  "graph.noProject": "Project not found: {name}. It needs a note tagged dev/projeto.",
  "graph.noClone": "The project {name} has no local clone, so there is no graph to draw.",
  "graph.empty": "This repository has no commits yet.",
  "graph.failed": "Could not draw the graph: {reason}",

  "command.openView": "Open the AI Git Tools screen",
  "ribbon.openView": "AI Git Tools",

  "settings.folders.heading": "Projects and folders",
  "settings.projectsRoot": "Projects folder",
  "settings.projectsRootDesc": "Vault folder with one folder per development project (notes tagged dev/projeto).",
  "settings.eventsFolder": "Events subfolder",
  "settings.eventsFolderDesc": "Subfolder of each project that receives the event notes.",
  "settings.changelogsFolder": "Changelogs subfolder",
  "settings.changelogsFolderDesc": "Subfolder of each project that receives the changelog notes.",
  "settings.allowedFolders": "Extra allowed folders",
  "settings.allowedFoldersDesc": "Absolute folders, one per line, that the git tools may use besides the clones of the projects.",
  "settings.allowAnyFolder": "Allow all folders",
  "settings.allowAnyFolderDesc": "The git tools may use any folder on the disk that is a git repository. When off, only the project clones and the extra allowed folders are used.",
  "settings.providers.heading": "GitHub and Bitbucket",
  "settings.secretGithub": "GitHub secret",
  "settings.secretBitbucket": "Bitbucket secret",
  "settings.secretDesc": "Environment Keys secret used for pull requests and pipelines. Without one, only the local git tools work for this provider.",
  "settings.secret.none": "None",
  "settings.secret.missing": "not found",
  "settings.secret.loading": "Reading the secrets of Environment Keys...",
  "settings.secret.status.sem_servico": "Environment Keys is not active; showing the saved choice only.",
  "settings.secret.status.sem_listagem": "This version of Environment Keys cannot list secrets; update it. Showing the saved choice only.",
  "settings.secret.status.cofre_bloqueado": "The Environment Keys vault is locked; unlock it to see the secrets. Showing the saved choice only.",
  "settings.secret.status.erro": "Could not read the secrets of Environment Keys; showing the saved choice only.",
  "settings.automation.heading": "Automatic documentation",
  "settings.watch": "Watch the terminal",
  "settings.watchDesc": "Records the commits, pushes and branches made outside the tools by watching the git reflogs.",
  "settings.remotePolling": "Read the remote",
  "settings.remotePollingDesc": "Reads pull requests and pipelines from GitHub or Bitbucket on a timer. Only for projects whose provider has a secret.",
  "settings.remoteInterval": "Minutes between remote reads",
  "settings.remoteIntervalDesc": "From 1 to 120.",
  "settings.sync": "Synchronize now",
  "settings.syncDesc": "Reads every project with a clone and records what is new as event notes.",
  "settings.syncButton": "Synchronize now",
  "settings.sync.running": "Synchronizing...",
  "settings.sync.done": "Synchronized {projects} project(s): {notes} note(s) created, {baselines} first read(s), {errors} error(s).",
  "settings.sync.failed": "Could not synchronize: {reason}",
  "settings.events.heading": "Event notes",
  "settings.events.desc":
    "Kinds of event that become a note in the Events subfolder of each project. Commits and pushes are the bulk of the notes, so they start off.",
  "settings.eventType.commit": "Commit notes",
  "settings.eventType.push": "Push notes",
  "settings.eventType.branch": "Branch notes",
  "settings.eventType.pr": "PR notes",
  "settings.eventType.deploy": "Deploy notes",
  "settings.hook.heading": "Agent hook",
  "settings.hook.name": "Hook mode",
  "settings.hook.desc":
    "The mode of the hook that reminds agents to use these tools (warn, block or off) is chosen in the AI Ecosystem configuration, not here.",
};

const pt: Table = {
  "dependency.title": "O AI Ecosystem é necessário",
  "dependency.body":
    "O AI Git Tools precisa do plugin AI Ecosystem. Ele oferece o servidor local e o endpoint MCP que os agentes de IA usam para git, GitHub e Bitbucket.",
  "dependency.standby":
    "O AI Git Tools fica em espera até o AI Ecosystem estar instalado e ativado, e conecta sozinho assim que ele iniciar.",
  "dependency.install": "Instalar e ativar o AI Ecosystem",
  "dependency.openPage": "Abrir a página do plugin",
  "dependency.installed": "AI Ecosystem instalado e ativado.",
  "dependency.failed": "Não foi possível instalar sozinho. Abrindo a página do plugin.",

  "graph.missingProject": "Informe o projeto no bloco (projeto: Nome).",
  "graph.noProject": "Projeto não encontrado: {name}. Ele precisa de uma nota com a tag dev/projeto.",
  "graph.noClone": "O projeto {name} não tem clone local, então não há grafo para desenhar.",
  "graph.empty": "Este repositório ainda não tem commits.",
  "graph.failed": "Não foi possível desenhar o grafo: {reason}",

  "command.openView": "Abrir a tela do AI Git Tools",
  "ribbon.openView": "AI Git Tools",

  "settings.folders.heading": "Projetos e pastas",
  "settings.projectsRoot": "Pasta dos projetos",
  "settings.projectsRootDesc": "Pasta do cofre com uma pasta por projeto de desenvolvimento (notas com a tag dev/projeto).",
  "settings.eventsFolder": "Subpasta de eventos",
  "settings.eventsFolderDesc": "Subpasta de cada projeto que recebe as notas de evento.",
  "settings.changelogsFolder": "Subpasta de changelogs",
  "settings.changelogsFolderDesc": "Subpasta de cada projeto que recebe as notas de changelog.",
  "settings.allowedFolders": "Pastas extras permitidas",
  "settings.allowedFoldersDesc": "Pastas absolutas, uma por linha, que as tools de git podem usar além dos clones dos projetos.",
  "settings.allowAnyFolder": "Liberar todas as pastas",
  "settings.allowAnyFolderDesc": "As tools de git podem usar qualquer pasta do disco que seja um repositório git. Desligado, usam só os clones dos projetos e as pastas extras permitidas.",
  "settings.providers.heading": "GitHub e Bitbucket",
  "settings.secretGithub": "Secret do GitHub",
  "settings.secretBitbucket": "Secret do Bitbucket",
  "settings.secretDesc": "Secret do Environment Keys usada em pull requests e pipelines. Sem ela, só as tools locais de git funcionam para este provedor.",
  "settings.secret.none": "Nenhuma",
  "settings.secret.missing": "não encontrada",
  "settings.secret.loading": "Lendo as secrets do Environment Keys...",
  "settings.secret.status.sem_servico": "O Environment Keys não está ativo; mostrando só a escolha salva.",
  "settings.secret.status.sem_listagem": "Esta versão do Environment Keys não lista secrets; atualize-o. Mostrando só a escolha salva.",
  "settings.secret.status.cofre_bloqueado": "O cofre do Environment Keys está bloqueado; desbloqueie para ver as secrets. Mostrando só a escolha salva.",
  "settings.secret.status.erro": "Não foi possível ler as secrets do Environment Keys; mostrando só a escolha salva.",
  "settings.automation.heading": "Documentação automática",
  "settings.watch": "Observar o terminal",
  "settings.watchDesc": "Registra os commits, pushes e branches feitos fora das tools, observando os reflogs do git.",
  "settings.remotePolling": "Ler o remoto",
  "settings.remotePollingDesc": "Lê PRs e pipelines do GitHub ou do Bitbucket de tempos em tempos. Só para projetos cujo provedor tem secret.",
  "settings.remoteInterval": "Minutos entre leituras do remoto",
  "settings.remoteIntervalDesc": "De 1 a 120.",
  "settings.sync": "Sincronizar agora",
  "settings.syncDesc": "Lê todos os projetos com clone e grava o que é novo como notas de evento.",
  "settings.syncButton": "Sincronizar agora",
  "settings.sync.running": "Sincronizando...",
  "settings.sync.done": "{projects} projeto(s) sincronizado(s): {notes} nota(s) criada(s), {baselines} primeira(s) leitura(s), {errors} erro(s).",
  "settings.sync.failed": "Não foi possível sincronizar: {reason}",
  "settings.events.heading": "Notas de evento",
  "settings.events.desc":
    "Tipos de evento que viram nota na subpasta de eventos de cada projeto. Commits e pushes são a maior parte das notas, por isso começam desligados.",
  "settings.eventType.commit": "Notas de commit",
  "settings.eventType.push": "Notas de push",
  "settings.eventType.branch": "Notas de branch",
  "settings.eventType.pr": "Notas de PR",
  "settings.eventType.deploy": "Notas de deploy",
  "settings.hook.heading": "Hook do agente",
  "settings.hook.name": "Modo do hook",
  "settings.hook.desc":
    "O modo do hook que lembra os agentes de usar estas tools (avisar, bloquear ou desligado) é escolhido na configuração do AI Ecosystem, não aqui.",
};

export function t(key: string, vars?: Record<string, string | number>): string {
  const table = getLanguage().toLowerCase().startsWith("pt") ? pt : en;
  let text = table[key] ?? en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(String(v));
  return text;
}
