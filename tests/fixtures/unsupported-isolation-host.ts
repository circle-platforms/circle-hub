// Test-only preload for Hub server/worker children. The harness PostgreSQL
// process keeps the real host platform; this can only emulate an unsupported
// adapter and must never turn the execution host into macOS.
const platform=process.env.CIRCLE_HUB_TEST_SANDBOX_PLATFORM;
if(platform&&platform!=='darwin'&&platform!==process.platform)Object.defineProperty(process,'platform',{value:platform});
