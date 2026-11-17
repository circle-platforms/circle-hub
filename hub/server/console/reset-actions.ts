/**
 * Reset is not registered on the sync command bridge: launching it stops the serve process.
 * Settings and rebuild pages post to async preview/execute (routes in console/routes.ts);
 * Server AppOptions.reset / rebuild-http own launch, ACK and status (answers-codex 18:40 / requests-to-cursor).
 */
export {};
