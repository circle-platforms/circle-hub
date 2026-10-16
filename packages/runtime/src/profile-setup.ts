// Operators hit this when a skill run starts without CIRCLE_RUNTIME_CONFIG.
// The command writes a development file outside the repository; the hub never
// approves that file by itself.
export const runtimeProfileSetupCommand = 'npm run runtime:profile';
export const runtimeProfileMissingMessage = 'A Circle runtime profile is the JSON file CIRCLE_RUNTIME_CONFIG points at. It names circleBin, circleCommit (40 hexadecimal characters), circleVersion and model (kind scripted or remote, base_url, model, protocol set to openai, and api_key). Create one with npm run runtime:profile, set CIRCLE_RUNTIME_CONFIG, restart the hub, call GET /v1/runtime-profiles, register a runtime-profile asset, and have a different person approve it. See docs/quickstart.md.';
