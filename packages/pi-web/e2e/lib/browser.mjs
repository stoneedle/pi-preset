// Every browser is owned by this test run, never an attached daily profile.
// Force the owned server's process tree down after assertions: WebKit can leave
// service-worker/SSE shutdown pending indefinitely during graceful close.
export async function launchTestBrowser(engine, options = {}) {
  const server = await engine.launchServer(options);
  try {
    const browser = await engine.connect(server.wsEndpoint());
    return { browser, close: () => server.kill() };
  } catch (error) {
    await server.kill();
    throw error;
  }
}
