# Vaquinha do Tadeuzinho

Página com contador colaborativo de arrecadação, área de transparência, comprovantes e formulário opcional de e-mail.

## Meta
R$ 6.000,00.

## Como funciona o contador
1. A pessoa faz o PIX para `huppesamanda@gmail.com`.
2. Depois informa no site quanto doou.
3. O valor é salvo no PostgreSQL e somado automaticamente ao contador público.
4. Ao atingir R$ 6.000,00, a página muda automaticamente para o estado **“Conseguimos!”** e deixa de pedir novas contribuições.

Importante: o contador é colaborativo e considera os valores declarados pelos próprios doadores. Ele não consulta a conta bancária.

## E-mail opcional
O e-mail é opcional. Quando informado, fica armazenado no PostgreSQL junto à contribuição para uso exclusivo no envio de atualizações e prestação de contas. O e-mail não aparece publicamente no site.

## Railway
Este projeto agora precisa de PostgreSQL porque o contador deve ser compartilhado entre todos os visitantes.

### Deploy
1. Crie/suba este repositório no GitHub.
2. No Railway, crie um projeto a partir do repositório.
3. Dentro do mesmo projeto, clique em **New → Database → PostgreSQL**.
4. O Railway disponibilizará `DATABASE_URL` para a aplicação.
5. Faça um novo deploy.
6. O servidor cria a tabela `tadeu_donations` automaticamente.

A meta usa `GOAL_AMOUNT_CENTS=600000`. Se a variável não existir, R$ 6.000,00 já é o padrão.

## Comprovantes
Coloque PDFs ou imagens em:

`assets/comprovantes/`

Depois, no `index.html`, procure por:

`const COMPROVANTES = [`

e adicione cada documento conforme o exemplo comentado.

## Estrutura
- `index.html` — página
- `server.js` — API e contador
- `package.json` — dependências e comando de start
- `.env.example` — exemplo das variáveis
- `assets/` — imagens e vídeos
- `assets/comprovantes/` — comprovantes publicados
