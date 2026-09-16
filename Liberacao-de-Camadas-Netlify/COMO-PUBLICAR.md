# Como publicar a "Liberação de Camadas" no Netlify

Este pacote já vem pronto para publicar. Ele tem duas partes:

- **Página** (`index.html`, `app.js`, `assets/`, `vendor/`) — o que todo mundo vê no navegador.
- **Servidor** (pasta `netlify/functions/`) — três rotinas pequenas que rodam no Netlify, guardam os dados de verdade (faixas, ensaios, histórico) e são as únicas que sabem as senhas. É isso que permite várias pessoas verem a mesma tela ao vivo, com só o João e a Aline conseguindo editar.

Por causa dessa parte de servidor, **não dá pra simplesmente arrastar uma pasta no Netlify** — é preciso conectar um repositório do GitHub. Não precisa saber usar git: dá pra fazer tudo pela página do navegador, sem instalar nada. São uns 15 minutos, uma vez só.

---

## Parte 1 — Colocar os arquivos no GitHub

1. Acesse **github.com** e crie uma conta gratuita, se ainda não tiver.
2. Clique no **+** no canto superior direito → **New repository**.
3. Dê um nome, por exemplo `liberacao-de-camadas`. Marque como **Private** (só quem você convidar vai ver o código — isso não afeta quem consegue ver a página publicada, que é decidido depois no Netlify/pelas senhas).
4. Clique em **Create repository**.
5. Na página do repositório recém-criado, clique em **uploading an existing file** (ou **Add file → Upload files**).
6. Abra a pasta deste pacote no seu computador e **arraste a pasta inteira** (com tudo dentro: `index.html`, `app.js`, `assets`, `vendor`, `netlify`, `package.json`, `netlify.toml`) para dentro da área de upload do GitHub. Ele mantém as subpastas do jeito que estão.
7. Role para baixo e clique em **Commit changes**.

Pronto — o código está no GitHub.

---

## Parte 2 — Conectar o repositório ao Netlify

1. Acesse **netlify.com** e crie uma conta gratuita (dá pra entrar direto com a conta do GitHub, é mais rápido).
2. No painel do Netlify, clique em **Add new site → Import an existing project**.
3. Escolha **GitHub** e autorize o Netlify a acessar sua conta.
4. Selecione o repositório `liberacao-de-camadas` que você criou.
5. O Netlify já deve preencher sozinho, a partir do arquivo `netlify.toml`:
   - **Build command:** `npm install`
   - **Publish directory:** `.`
   - **Functions directory:** `netlify/functions`

   Se algum desses campos vier em branco, preencha exatamente assim.
6. Clique em **Deploy site**.

Depois de 1–2 minutos, o Netlify te dá um endereço parecido com `https://algum-nome-aleatorio.netlify.app`. **Ainda não abra esse link para usar** — falta configurar as senhas (próximo passo). Se abrir agora, o login vai dar erro "Login não configurado no servidor".

Dica: em **Site configuration → Domain management**, dá pra trocar esse endereço por algo mais fácil de lembrar, tipo `liberacao-camadas-maravilhas3.netlify.app` (gratuito), ou até apontar um domínio próprio da Aterpa, se vocês tiverem um.

---

## Parte 3 — Configurar as duas senhas

As senhas **não ficam escritas em nenhum arquivo** — ficam guardadas só dentro do Netlify, como "variável de ambiente". É isso que faz a senha valer de verdade (ninguém consegue descobrir olhando o código do site).

1. No painel do seu site no Netlify, vá em **Site configuration → Environment variables**.
2. Clique em **Add a variable → Add a single variable** e crie:
   - Chave: `EDIT_PASSWORD_JOAO` → Valor: `00063727`
3. Repita para a segunda:
   - Chave: `EDIT_PASSWORD_ALINE` → Valor: `00056087`
4. Salve. Depois vá em **Deploys** e clique em **Trigger deploy → Deploy site** (as variáveis novas só valem a partir do próximo deploy).

---

## Parte 4 — Testar

1. Abra o link do site (o `https://....netlify.app`, ou o domínio que você configurou).
2. Sem fazer login: você deve ver as 7 faixas, os botões **Imprimir / PDF** e **Login**, mas **sem** o botão de Baixar Excel e sem os botões de editar (isso é o modo "acompanhamento", igual vai ser pra quem está na obra).
3. Clique em **Login**, digite `00063727` → deve aparecer "Bem-vindo João!" e liberar a edição (Baixar Excel, mover faixas, ✕ remover, 🔁 Novo Lançamento, etc).
4. Clique em **Login** de novo (agora mostrando "Sair (João)") pra sair, e teste com `00056087` → deve aparecer "Bem-vinda Aline!".
5. Abra o mesmo link em outro navegador (ou no celular) sem fazer login, faça uma alteração no primeiro (logado), e veja a tela do segundo atualizar sozinha em alguns segundos.

---

## Perguntas que provavelmente vão surgir

**Quanto custa?** Nada, dentro do uso normal de uma obra (poucos acessos por minuto). O plano gratuito do Netlify cobre isso tranquilamente.

**A atualização é instantânea?** Quase — quem só acompanha (sem login) atualiza a tela sozinha a cada 5 segundos. Não é instantâneo no sentido de "aparece no mesmo milissegundo", mas dá a sensação de tempo real numa obra.

**Como troco as senhas depois?** Repita a Parte 3 com os novos valores nas mesmas duas variáveis e dispare um novo deploy. Não precisa mexer em nenhum código.

**Dá pra ter uma terceira pessoa editando?** Dá — é só adicionar uma terceira variável (por exemplo `EDIT_PASSWORD_MARIA`) e um trecho a mais no `login.mjs` e no `save-state.mjs` reconhecendo essa senha. Se precisar disso, é só pedir.

**E se eu esquecer as duas senhas?** Diferente da versão antiga (arquivo local criptografado), aqui não tem problema: você mesmo redefine as senhas a qualquer momento na Parte 3, sem perder nenhum dado — as senhas só controlam quem pode editar, os dados ficam guardados à parte, no banco do site.

**Os dados ficam salvos entre um deploy e outro?** Sim. Os dados das faixas ficam no "Netlify Blobs" (um banco de dados simples ligado ao site), separado do código. Só republique o site (Parte 2) sem se preocupar — os dados continuam lá.
