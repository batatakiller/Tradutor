# Tradutor ao Vivo

Aplicativo web para celular que captura fala pelo microfone, envia audio em tempo real para o Gemini Live Translate e toca a traducao no alto-falante ou caixa Bluetooth conectada ao telefone.

## Configuracao

1. Crie um arquivo `.env` na raiz do projeto:

```bash
GEMINI_API_KEY=sua_chave_gemini
```

2. Inicie:

```bash
npm start
```

3. Abra no computador:

```text
http://localhost:3000
```

## Deploy Na Vercel

1. Suba este repositório no GitHub.
2. Importe o projeto na Vercel.
3. Adicione a variável de ambiente `GEMINI_API_KEY` no painel da Vercel.
4. Faça um novo deploy depois de adicionar a variável.

O endpoint `api/live-token` já fica pronto automaticamente na Vercel, e a página usa os arquivos estáticos de `public/`.

Se aparecer "Falha ao criar token temporario", abra o projeto na Vercel e confira:

- `Settings` -> `Environment Variables` -> `GEMINI_API_KEY` existe em `Production`.
- Depois de adicionar ou trocar a chave, faça `Redeploy`.
- A URL `/api/live-token?targetLanguageCode=pt-BR` deve responder JSON, nao uma pagina 404.

## Uso no celular

O microfone do celular exige HTTPS. Para usar em aula, publique este projeto em um servidor com HTTPS ou use um tunel HTTPS apontando para `localhost:3000`.

Pareie a caixa Bluetooth no celular antes de iniciar a traducao. O app usa a saida de audio normal do telefone.

## Observacoes

- Idioma de entrada: automatico.
- Idioma de saida padrao: Portugues (Brasil).
- Formato enviado para a API: PCM 16 kHz mono.
- Formato recebido da API: PCM 24 kHz mono.
- A chave fica somente no servidor local; o navegador recebe apenas um token temporario.
- Nao ha dependencias externas de npm; Node 18 ou mais recente ja e suficiente.

Se uma chave real ja foi compartilhada em chat, vale criar uma nova no Google AI Studio e substituir no `.env`.
