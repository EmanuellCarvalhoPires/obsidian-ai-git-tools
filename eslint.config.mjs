import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{ ignores: ["main.js", "dist-app/","node_modules/", ".claude/", "esbuild.config.mjs", "vitest.config.mjs", "scripts/", "tests/", "docs/", "src/hook/*.mjs"] },
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.*"],
				},
			},
		},
	},
	{
		// src/app roda em Node puro (processo filho do app AI Ecosystem 2.0), sem janelas popout do Obsidian:
		// as regras abaixo, pensadas para o plugin dentro do Obsidian, não se aplicam.
		files: ["src/app/**/*.ts"],
		rules: {
			"obsidianmd/prefer-window-timers": "off",
			"obsidianmd/no-global-this": "off",
			// shim.ts desvia console.log/info para o stderr (o stdout é só do JSON-RPC).
			"obsidianmd/rule-custom-message": "off",
		},
	},
]);
