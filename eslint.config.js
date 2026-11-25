// @ts-check
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/** JSX attributes that carry text a user reads (labels, hints, tooltips, alternative texts). */
const UI_TEXT_ATTRIBUTES =
  "/^(aria-label|aria-description|title|placeholder|alt|label|[a-z]+Label|description|hint|heading|empty|message|text|confirm)$/";

/** A literal with words in `context`, directly or as either side of `?:` and `??`/`||`/`&&`. */
function uiTextSelectors(context) {
  const message = "UI text goes into the dictionaries (web/src/i18n), not into JSX.";
  const words = "Literal[value=/[A-Za-z]/]";
  const template = "TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]/]";
  const value = context.startsWith("JSXAttribute")
    ? `${context} > JSXExpressionContainer`
    : context;
  return [
    ...(context.startsWith("JSXAttribute") ? [{ selector: `${context} > ${words}`, message }] : []),
    { selector: `${value} > ${words}`, message },
    { selector: `${value} > ${template}`, message },
    { selector: `${value} > ConditionalExpression > ${words}`, message },
    { selector: `${value} > ConditionalExpression > ${template}`, message },
    { selector: `${value} > LogicalExpression > ${words}`, message },
  ];
}

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      // Generated from the OpenAPI document by orval.
      "web/src/api/generated.ts",
      ".references/**",
      ".scratch/**",
      // Git-ignored local folders: agent worktrees, browser captures, unpacked packages.
      ".claude/**",
      ".playwright-mcp/**",
      "packages/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Size limits from the coding rules: enforced mechanically, never by eye.
      "max-lines": ["error", { max: 1000, skipBlankLines: false, skipComments: false }],
      "max-lines-per-function": ["error", { max: 200, skipBlankLines: false, skipComments: false }],
      "max-depth": ["error", 3],
      "max-params": ["error", 5],
      "no-console": "error",
      eqeqeq: ["error", "always"],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "no-restricted-syntax": [
        "error",
        { selector: "TSEnumDeclaration", message: "Use an `as const` object and a literal union." },
      ],
    },
  },
  {
    // Carrier providers may only use the provider API, never the server's internals.
    files: ["server/src/carriers/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // Anything outside the carriers folder other than the provider API itself.
              regex:
                "^(\\.\\./)+(api|auth|calendar|crypto|db|domain|engine|events|ha|images|log|mail|migrate|parcels|tools)/|^(\\.\\./)+(clock|config|main|services)\\.js$|^(\\.\\./)+provider/(?!api\\.js$)",
              message:
                "Carrier providers may only import the provider API (server/src/provider/api.ts).",
            },
            {
              group: ["open-parcels-rules", "open-parcels-rules/*"],
              message:
                "Carrier providers reach the shared rules through the provider API (server/src/provider/rules.ts).",
            },
          ],
        },
      ],
    },
  },
  {
    // The importers of older data may be deleted one day; the API and engine must not need them.
    files: ["server/src/api/**/*.ts", "server/src/engine/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "/migrate/",
              message: "Only start-up and import code may use the importers in server/src/migrate.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Hooks and components return types TanStack and JSX infer exactly; spelling them out adds noise.
      "@typescript-eslint/explicit-module-boundary-types": "off",
    },
  },
  {
    // Every text the web UI shows comes from the dictionaries in web/src/i18n (English and
    // German): no words written straight into JSX, its text attributes or its expressions.
    files: ["web/src/**/*.tsx"],
    ignores: ["web/src/**/*.test.tsx", "web/src/test/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "TSEnumDeclaration", message: "Use an `as const` object and a literal union." },
        {
          selector: "JSXText[value=/[A-Za-zÄÖÜäöüß]/]",
          message: "UI text goes into the dictionaries (web/src/i18n), not into JSX.",
        },
        ...uiTextSelectors(`JSXAttribute[name.name=${UI_TEXT_ATTRIBUTES}]`),
        ...uiTextSelectors("JSXElement > JSXExpressionContainer"),
        ...uiTextSelectors("JSXFragment > JSXExpressionContainer"),
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "server/test/**/*.ts"],
    rules: {
      // A describe() block holds many tests; the function limit is meant for production code.
      "max-lines-per-function": "off",
    },
  },
  {
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
