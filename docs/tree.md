# noaa-climate-mcp-server - Directory Structure

Generated on: 2026-09-16 11:01:37

```text
noaa-climate-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   ├── 0.5.x/
│   ├── 0.6.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   ├── split-changelog.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── noaa-datasets.resource.ts
│   │   │       └── noaa-station.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── shared/
│   │           │   ├── upstream-auth.ts
│   │           │   ├── upstream-availability.ts
│   │           │   └── validation.ts
│   │           ├── noaa-climate-fetch-data.tool.ts
│   │           ├── noaa-climate-find-locations.tool.ts
│   │           ├── noaa-climate-find-stations.tool.ts
│   │           ├── noaa-climate-get-billion-dollar-disasters.tool.ts
│   │           ├── noaa-climate-get-station.tool.ts
│   │           ├── noaa-climate-list-data-categories.tool.ts
│   │           ├── noaa-climate-list-data-types.tool.ts
│   │           ├── noaa-climate-list-datasets.tool.ts
│   │           ├── noaa-climate-list-location-categories.tool.ts
│   │           └── noaa-climate-search-storm-events.tool.ts
│   ├── services/
│   │   ├── billion-dollar-disasters/
│   │   │   ├── billion-dollar-disasters-service.ts
│   │   │   └── types.ts
│   │   ├── cdo/
│   │   │   ├── cdo-service.ts
│   │   │   ├── pagination.ts
│   │   │   └── types.ts
│   │   ├── csv/
│   │   │   └── csv-stream-reader.ts
│   │   └── storm-events/
│   │       ├── damage.ts
│   │       ├── storm-events-service.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── fixtures/
│   │   └── billion-dollar-disasters.ts
│   ├── helpers/
│   │   ├── content.ts
│   │   └── example-identifiers.ts
│   ├── live/
│   │   └── example-identifiers.live.test.ts
│   ├── prompts/
│   ├── resources/
│   │   ├── noaa-datasets.resource.test.ts
│   │   └── noaa-station.resource.test.ts
│   ├── services/
│   │   ├── billion-dollar-disasters-service.test.ts
│   │   ├── cdo-error-explanation.test.ts
│   │   ├── cdo-pagination.test.ts
│   │   ├── cdo-service-request-options.test.ts
│   │   ├── cdo-service.test.ts
│   │   ├── cdo-upstream-500-retry.test.ts
│   │   ├── csv-stream-reader.test.ts
│   │   ├── storm-events-damage.test.ts
│   │   └── storm-events-service.test.ts
│   ├── tools/
│   │   ├── cdo-upstream-rejection-routing.test.ts
│   │   ├── date-wire-normalization.test.ts
│   │   ├── example-identifier-extraction.test.ts
│   │   ├── example-station-id.test.ts
│   │   ├── fetch-data-date-range.test.ts
│   │   ├── fetch-data-includemetadata.test.ts
│   │   ├── format-empty-page.test.ts
│   │   ├── noaa-climate-fetch-data-extended.tool.test.ts
│   │   ├── noaa-climate-fetch-data.tool.test.ts
│   │   ├── noaa-climate-find-locations-extended.tool.test.ts
│   │   ├── noaa-climate-find-locations-name-filter.test.ts
│   │   ├── noaa-climate-find-locations.tool.test.ts
│   │   ├── noaa-climate-find-stations-extended.tool.test.ts
│   │   ├── noaa-climate-find-stations.tool.test.ts
│   │   ├── noaa-climate-get-billion-dollar-disasters.tool.test.ts
│   │   ├── noaa-climate-get-station-extended.tool.test.ts
│   │   ├── noaa-climate-get-station.tool.test.ts
│   │   ├── noaa-climate-list-data-categories-extended.tool.test.ts
│   │   ├── noaa-climate-list-data-categories.tool.test.ts
│   │   ├── noaa-climate-list-data-types-extended.tool.test.ts
│   │   ├── noaa-climate-list-data-types.tool.test.ts
│   │   ├── noaa-climate-list-datasets-extended.tool.test.ts
│   │   ├── noaa-climate-list-datasets.tool.test.ts
│   │   ├── noaa-climate-list-location-categories.tool.test.ts
│   │   ├── noaa-climate-search-storm-events.tool.test.ts
│   │   ├── pagination-exhausted.test.ts
│   │   ├── validation-helpers.test.ts
│   │   └── validation-schemas.test.ts
│   └── tool-naming.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
