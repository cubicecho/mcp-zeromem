import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

describe('loadConfig', () => {
  it('reads the data dir, port and token', () => {
    const config = loadConfig({ DATA_DIR: '/tmp/zm', PORT: '4000', MCP_ZEROMEM_TOKEN: 'secret' });
    expect(config).toEqual({
      dataDir: '/tmp/zm',
      port: 4000,
      authToken: 'secret',
      readOnly: false,
      embedder: 'auto',
      allowEmbedderSwitch: false,
      remoteEmbedder: null,
      embeddingApiKey: null,
      sessionId: null,
    });
  });

  it('reads the remote embedder endpoint and requires it for openai', () => {
    const env = { DATA_DIR: '/tmp/zm', SECURE_LOCAL_NET: '1' };
    expect(() => loadConfig({ ...env, ZEROMEM_EMBEDDER: 'openai' })).toThrow(/ZEROMEM_EMBEDDING_URL/);
    expect(() => loadConfig({ ...env, ZEROMEM_EMBEDDING_URL: 'http://npu:8080/v1' })).toThrow(
      /ZEROMEM_EMBEDDING_MODEL/,
    );
    const config = loadConfig({
      ...env,
      ZEROMEM_EMBEDDER: 'openai',
      ZEROMEM_EMBEDDING_URL: 'http://npu:8080/v1',
      ZEROMEM_EMBEDDING_MODEL: 'nomic-embed-text',
      ZEROMEM_EMBEDDING_API_KEY: 'sk-test',
      ZEROMEM_EMBEDDING_QUERY_PREFIX: 'query: ',
      ZEROMEM_EMBEDDING_TIMEOUT_MS: '2500',
    });
    expect(config.embedder).toBe('openai');
    expect(config.remoteEmbedder).toEqual({
      url: 'http://npu:8080/v1',
      model: 'nomic-embed-text',
      query_prefix: 'query: ',
      document_prefix: '',
      timeout_ms: 2500,
    });
    expect(config.embeddingApiKey).toBe('sk-test');
    expect(() => loadConfig({ ...env, ZEROMEM_EMBEDDING_URL: 'npu', ZEROMEM_EMBEDDING_MODEL: 'm' })).toThrow(
      /ZEROMEM_EMBEDDING_URL/,
    );
  });

  it('reads the embedder settings and rejects an unknown embedder', () => {
    const env = { DATA_DIR: '/tmp/zm', SECURE_LOCAL_NET: '1' };
    const config = loadConfig({ ...env, ZEROMEM_EMBEDDER: 'hash', ZEROMEM_ALLOW_EMBEDDER_SWITCH: 'true' });
    expect(config.embedder).toBe('hash');
    expect(config.allowEmbedderSwitch).toBe(true);
    expect(() => loadConfig({ ...env, ZEROMEM_EMBEDDER: 'bert' })).toThrow(/ZEROMEM_EMBEDDER/);
  });

  it('refuses an HTTP server with neither a token nor SECURE_LOCAL_NET', () => {
    expect(() => loadConfig({ DATA_DIR: '/tmp/zm' })).toThrow(/MCP_ZEROMEM_TOKEN/);
    expect(loadConfig({ DATA_DIR: '/tmp/zm', SECURE_LOCAL_NET: 'true' }).authToken).toBeNull();
  });

  it('does not require auth for the stdio transport', () => {
    expect(loadConfig({ DATA_DIR: '/tmp/zm' }, { transport: 'stdio' }).authToken).toBeNull();
  });

  it('refuses a ZEROMEM_HOME that is not the data dir', () => {
    expect(() => loadConfig({ DATA_DIR: '/tmp/a', ZEROMEM_HOME: '/tmp/b', SECURE_LOCAL_NET: '1' })).toThrow(
      /ZEROMEM_HOME/,
    );
    expect(loadConfig({ DATA_DIR: '/tmp/a', ZEROMEM_HOME: '/tmp/a/', SECURE_LOCAL_NET: '1' }).dataDir).toBe('/tmp/a');
  });

  it('rejects an unparseable boolean rather than guessing', () => {
    expect(() => loadConfig({ DATA_DIR: '/tmp/a', SECURE_LOCAL_NET: '1', ZEROMEM_READ_ONLY: 'ture' })).toThrow(
      /ZEROMEM_READ_ONLY/,
    );
    expect(loadConfig({ DATA_DIR: '/tmp/a', SECURE_LOCAL_NET: '1', ZEROMEM_READ_ONLY: 'yes' }).readOnly).toBe(true);
  });

  it('defaults the data dir relative to the working directory', () => {
    expect(loadConfig({ SECURE_LOCAL_NET: '1' }).dataDir).toBe(path.resolve('./data'));
  });
});
