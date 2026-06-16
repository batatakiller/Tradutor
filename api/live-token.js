const AUTH_TOKEN_ENDPOINT = 'https://generativelanguage.googleapis.com/v1alpha/auth_tokens';
const MODEL = 'gemini-3.5-live-translate-preview';

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

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Metodo nao permitido.' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'Configure GEMINI_API_KEY nas variaveis de ambiente da Vercel.'
    });
    return;
  }

  const targetLanguageCode = String(req.query.targetLanguageCode || 'pt-BR');
  const echoTargetLanguage = String(req.query.echoTargetLanguage || 'true') !== 'false';

  if (!allowedLanguages.has(targetLanguageCode)) {
    res.status(400).json({ error: 'Idioma de saida nao suportado por este app.' });
    return;
  }

  const setup = buildBidiSetup(targetLanguageCode, echoTargetLanguage);
  const body = {
    uses: 1,
    expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    newSessionExpireTime: new Date(Date.now() + 60 * 1000).toISOString(),
    bidiGenerateContentSetup: setup
  };

  let response;
  try {
    response = await fetch(`${AUTH_TOKEN_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    res.status(502).json({
      error: 'A Vercel nao conseguiu conectar na API da Gemini.',
      detail: error.message
    });
    return;
  }

  const text = await response.text();
  const payload = parseJson(text);

  if (!response.ok) {
    const message = payload?.error?.message || text || 'Falha ao criar token temporario na Gemini.';
    res.status(502).json({
      error: message,
      geminiStatus: response.status
    });
    return;
  }

  res.status(200).json({
    token: payload.name,
    model: MODEL,
    targetLanguageCode,
    echoTargetLanguage,
    setup
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
