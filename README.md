# AI Git Tools

Obsidian plugin of the AI Ecosystem suite. It gives AI agents git, GitHub and Bitbucket tools and keeps the history of each development project in notes.

Status: version 0.1.0, under development. The module connects to the AI Ecosystem; the tools are added in later phases.

Requires the AI Ecosystem plugin (installed and enabled).

## Development

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run deploy` copies `main.js`, `manifest.json` and `styles.css` to the folder in `.deploy-target` (or to the `AIGT_DEPLOY_DIR` variable).

## App entry (AI Ecosystem 2.0)

- `npm run build:app` generates `dist-app/ai-git-tools.cjs`, which the AI Ecosystem 2.0 app runs with Node.
- The automations only run in the app with the module in service (`servico`); turn the plugin off in Obsidian at that point.
- The pipeline notice goes through the app's Telegram bus (the Telegram module must also be in `servico`).

## License

MIT, see [LICENSE](LICENSE).
