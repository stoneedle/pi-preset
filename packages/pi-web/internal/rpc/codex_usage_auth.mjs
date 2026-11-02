// Resolve request auth through Pi's locked OAuth refresh path, without a session or extensions.
const { ModelRuntime } = await import(new URL('./core/model-runtime.js', pathToFileURL(entry)));
let result;
try {
  const runtime = await ModelRuntime.create({
    authPath: join(sdkArgs[0], 'auth.json'), modelsPath: null, refreshOnCreate: false,
  });
  const credentials = await runtime.listCredentials();
  if (!credentials.some((credential) => credential.providerId === 'openai-codex' && credential.type === 'oauth')) {
    result = { status: 'signed-out' };
  } else {
    const resolved = await runtime.getAuth('openai-codex', { signal: AbortSignal.timeout(8000) });
    const token = resolved?.auth.apiKey;
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    if (typeof accountId !== 'string' || !accountId) throw new Error('Missing account');
    // These secrets go only to the parent Go process, never to an HTTP response or log.
    result = { status: 'ok', accessToken: token, accountId };
  }
} catch {
  result = { status: 'auth-error' };
}
process.stdout.write(JSON.stringify(result));
