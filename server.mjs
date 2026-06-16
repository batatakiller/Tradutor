import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';

const ROOT = process.cwd();
const PUBLIC_DIR = resolve(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MODEL = 'gemini-3.5-live-translate-preview';
const AUTH_TOKEN_ENDPOINT = 'https://generativelanguage.googleapis.com/v1alpha/auth_tokens';

loadEnvFile(resolve(ROOT, '.env'));

const apiKey = process.env.GEMINI_API_KEY;

const allowedLanguages = new Set([
  'pt-BR',
  'en',
  'es',
  'fr',
  'ar',
  'uk',
  'ru',
  'fa',
  'tr',
  'de',
  'it',
  'zh-Hans',
  'hi',
  'ur',
  'vi',
  'pl',
  'ja',
  'ko'
]);

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.ico', 'image/x-icon']
]);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/live-token') {
      await handleTokenRequest(url, res);
      return;
    }

    if (url.pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: 'Erro interno do servidor.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log('\nTradutor ao Vivo pronto.');
  console.log(`Local:   http://localhost:${PORT}`);
  for (const address of getLanAddresses()) {
    console.log(`Rede:    http://${address}:${PORT}`);
  }
  console.log('\nNo celular, use HTTPS em um deploy ou tunel para liberar o microfone.');
});

async function handleTokenRequest(url, res) {
  if (!apiKey) {
    sendJson(res, 500, {
      error: 'Configure GEMINI_API_KEY no arquivo .env antes de iniciar.'
    });
    return;
  }

  const targetLanguageCode = url.searchParams.get('targetLanguageCode') || 'pt-BR';
  const echoTargetLanguage = url.searchParams.get('echoTargetLanguage') !== 'false';

  if (!allowedLanguages.has(targetLanguageCode)) {
    sendJson(res, 400, { error: 'Idioma de saida nao suportado por este app.' });
    return;
  }

  const now = Date.now();
  const setup = buildBidiSetup(targetLanguageCode, echoTargetLanguage);
  let token;

  try {
    token = await createEphemeralToken({
      uses: 1,
      expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
      newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
      bidiGenerateContentSetup: setup
    });
  } catch (error) {
    sendJson(res, 502, {
      error: error.message || 'Falha ao criar token temporario na Gemini.'
    });
    return;
  }

  sendJson(res, 200, {
    token: token.name,
    model: MODEL,
    targetLanguageCode,
    echoTargetLanguage,
    setup
  });
}

async function createEphemeralToken(body) {
  const response = await fetch(`${AUTH_TOKEN_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload.error?.message || 'Falha ao criar token temporario na Gemini.';
    throw new Error(message);
  }

  return payload;
}

function buildBidiSetup(targetLanguageCode, echoTargetLanguage) {
  return {
    model: `models/${MODEL}`,
    generationConfig: {
      responseModalities: ['AUDIO'],
      translationConfig: {
        targetLanguageCode,
        echoTargetLanguage
      }
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {}
  };
}

async function serveStatic(pathname, res) {
  const cleanPath = pathname === '/' ? '/index.html' : pathname;
  const normalizedPath = normalize(decodeURIComponent(cleanPath)).replace(/^(\.\.[/\\])+/, '');
  const filePath = resolve(join(PUBLIC_DIR, normalizedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Acesso negado.');
    return;
  }

  const finalPath = existsSync(filePath) ? filePath : resolve(PUBLIC_DIR, 'index.html');
  const type = contentTypes.get(extname(finalPath)) || 'application/octet-stream';
  const cache = finalPath.endsWith('index.html') ? 'no-store' : 'public, max-age=3600';
  const body = await readFile(finalPath);

  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': cache
  });
  res.end(body);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function sendText(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return;
  }

  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, '');

    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

function getLanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}
