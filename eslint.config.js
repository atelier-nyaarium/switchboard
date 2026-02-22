import eslintJs from "@eslint/js";
import eslintImport from "eslint-plugin-import";
import eslintSecurity from "eslint-plugin-security";
import eslintUnusedImports from "eslint-plugin-unused-imports";
import globalTypes from "globals";
import eslintTs from "typescript-eslint";

const globals = {
	...globalTypes.node,
	...globalTypes.browser,
	React: "readonly",
	JSX: "readonly",
	NodeJS: "readonly",
};

const bannedTypes = {
	"ZodTypeAny": {
		message: "It is deprecated. Use a more specific Zod type or `z.ZodType<unknown>` instead.",
		fixWith: "z.ZodType<unknown>",
	},
	"z.ZodTypeAny": {
		message: "It is deprecated. Use a more specific Zod type or `z.ZodType<unknown>` instead.",
		fixWith: "z.ZodType<unknown>",
	},
};

const bannedSyntax = [
	{
		selector: "MemberExpression[property.name='_def']",
		message: "Accessing Zod schema by `._def` is not allowed. Use `.def` instead.",
	},
	{
		selector:
			"CallExpression[callee.property.name='url'][callee.object.type='CallExpression'][callee.object.callee.property.name='string']",
		message: "Chaining `.string().url()` is not allowed. Use `.string()` or `.url()`, not both.",
	},
];

export default [
	{
		ignores: [
			".claude/",
			"build/",
			"coverage/",
			"node_modules/",
			"volumes/",
			".eslintrc.js",
			"tsconfig.json",
			"vite.config.ts",
			"remix.env.d.ts",
		],
	},

	// Base recommended rules
	{
		rules: {
			...eslintJs.configs.recommended.rules,
			"preserve-caught-error": "warn",
			"no-useless-assignment": "warn",
		},
	},

	// JavaScript/JSX Configuration
	{
		files: ["**/*.{js,jsx}"],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "module",
			globals,
		},
		plugins: {
			"security": eslintSecurity,
			"unused-imports": eslintUnusedImports,
			"import": eslintImport,
		},
		rules: {
			...eslintImport.flatConfigs.recommended.rules,
			"unused-imports/no-unused-imports": "warn",
			"no-unused-vars": [
				"warn",
				{
					args: "none",
					argsIgnorePattern: "^(args|params|props|request|context|error|resolve|reject)$",
					caughtErrors: "none",
					vars: "all",
					varsIgnorePattern: "^(args|params|props|request|context|error|resolve|reject)$",
				},
			],
		},
		settings: {
			"import/resolver": {
				typescript: {
					project: "./tsconfig.json",
				},
			},
		},
	},

	// TypeScript/TSX Configuration
	{
		files: ["**/*.{ts,tsx}"],
		languageOptions: {
			parser: eslintTs.parser,
			parserOptions: {
				project: "./tsconfig.json",
				tsconfigRootDir: process.cwd(),
			},
			globals,
		},
		plugins: {
			"security": eslintSecurity,
			"unused-imports": eslintUnusedImports,
			"import": eslintImport,
			"@typescript-eslint": eslintTs.plugin,
		},
		rules: {
			...eslintImport.flatConfigs.recommended.rules,
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-restricted-types": [
				"error",
				{
					types: bannedTypes,
				},
			],
			"no-restricted-syntax": ["error", ...bannedSyntax],
			"@typescript-eslint/consistent-type-imports": [
				"error",
				{
					prefer: "type-imports",
					fixStyle: "inline-type-imports",
				},
			],
			"unused-imports/no-unused-imports": "off",
			"no-unused-vars": "off",
			"@typescript-eslint/no-unused-vars": [
				"warn",
				{
					args: "none",
					argsIgnorePattern: "^(args|params|props|request|context|error|resolve|reject)$",
					caughtErrors: "none",
					vars: "all",
					varsIgnorePattern: "^(args|params|props|request|context|error)$",
				},
			],
			"no-redeclare": "off",
			"@typescript-eslint/no-redeclare": ["error", { ignoreDeclarationMerge: true }],
		},
		settings: {
			"import/resolver": {
				typescript: {
					project: "./tsconfig.json",
				},
			},
		},
	},
];
