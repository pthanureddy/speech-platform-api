import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function start(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({ config });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    const failure =
      error instanceof Error ? error : new Error('The HTTP server failed to listen.', { cause: error });
    await app.close().catch((closeError: unknown) => {
      app.log.error({ err: closeError }, 'failed to close after listen error');
    });
    throw failure;
  }

  const close = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
  };
  process.once('SIGINT', () => {
    void close('SIGINT');
  });
  process.once('SIGTERM', () => {
    void close('SIGTERM');
  });
}

start().catch((error: unknown) => {
  // This is the only pre-listen failure path; request-time errors use structured logging.
  console.error(error);
  process.exitCode = 1;
});
