# Como publicar a "Liberação de Camadas" no Netlify

Este pacote já vem pronto para publicar. Ele tem duas partes:

- **Página** (`index.html`, `app.js`, `assets/`, `vendor/`) — o que todo mundo vê no navegador.
- **Servidor** (pasta `netlify/functions/`) — três rotinas pequenas que rodam no Netlify, guardam os dados de verdade (faixas, ensaios, histórico) e são as únicas que sabem as senhas. É isso que permite várias pessoas verem a mesma tela ao vivo, com só o João e a Aline conseguindo editar.

Por causa dessa parte de servidor, **não dá pra simplesmente arrastar a pasta na tela inicial do Netlify** (aquele "drag and drop" simples só publica arquivos estáticos, sem rodar as três rotinas). Mas isso **não significa que precisa de GitHub** — dá pra publicar direto da sua conta Netlify, usando o "Netlify CLI" (um programinha de linha de comando). É a opção mais rápida se você já tem conta lá. Deixei o caminho pelo GitHub como alternativa lá embaixo, para quem preferir tudo pelo navegador.

---

## Opção A — Só com sua conta Netlify (recomendado, sem GitHub)

Precisa de duas coisas instaladas no computador uma única vez: **Node.js** (para rodar o comando `npm`) e o **Netlify CLI**. Depois disso é só copiar e colar os comandos abaixo.

### Passo 0 — Verificar/instalar o Node.js

Abra o terminal (no Windows, **PowerShell**; no Mac, **Terminal**) e digite:

```
node -v
```

- Se aparecer um número tipo `v18.x` ou `v20.x`, já tem Node.js — pule para o Passo 1.
- Se der erro ("comando não encontrado"), baixe e instale em **nodejs.org** (baixe a versão "LTS", clique em avançar em tudo) e depois feche e abra o terminal de novo.

### Passo 1 — Instalar o Netlify CLI (uma vez só)

```
npm install -g netlify-cli
```

### Passo 2 — Entrar na sua conta Netlify

```
netlify login
```

Isso abre uma aba no navegador pedindo para autorizar — clique em autorizar e volte pro terminal.

### Passo 3 — Ir até a pasta do projeto

Descompacte o arquivo `.zip` deste pacote em algum lugar do computador (por exemplo, na Área de Trabalho) e entre nessa pasta pelo terminal. Exemplo (ajuste o caminho para onde você descompactou):

- **Windows (PowerShell):**
  ```
  cd C:\Users\SeuUsuario\Desktop\Liberacao-de-Camadas-Netlify
  ```
- **Mac (Terminal):**
  ```
  cd ~/Desktop/Liberacao-de-Camadas-Netlify
  ```

### Passo 4 — Instalar as dependências do projeto

```
npm install
```

(Isso baixa uma pequena biblioteca — `@netlify/blobs` — que as rotinas do servidor usam. É rápido.)

### Passo 5 — Primeiro envio (cria o site)

```
netlify deploy
```

O terminal vai perguntar:
- **"What would you like to do?"** → escolha **"Create & configure a new site"** (ou "Create a new site").
- **Team** → escolha sua conta/time.
- **Site name** → pode digitar um nome (ex: `liberacao-camadas-maravilhas3`) ou deixar em branco para um nome aleatório — dá pra trocar depois no site.

Isso faz um envio de **teste** (preview), não o site final ainda. Ele te dá um link de preview — pode ignorar por enquanto.

### Passo 6 — Configurar as duas senhas

Antes de publicar de vez, configure as senhas (veja a explicação completa na Parte 3 mais abaixo — o processo é o mesmo, só que agora acessando o site pelo painel normal do Netlify, em **netlify.com → seu site → Site configuration → Environment variables**):

- `EDIT_PASSWORD_JOAO` → `00063727`
- `EDIT_PASSWORD_ALINE` → `00056087`

Ou, se preferir continuar tudo pelo terminal, sem abrir o navegador:

```
netlify env:set EDIT_PASSWORD_JOAO 00063727
netlify env:set EDIT_PASSWORD_ALINE 00056087
```

### Passo 7 — Publicar de vez (produção)

```
netlify deploy --prod
```

Ao final, ele mostra o link do site de verdade (algo como `https://liberacao-camadas-maravilhas3.netlify.app`). Esse é o link para compartilhar com a equipe.

Pronto — publicado, só com a sua conta Netlify, sem precisar de GitHub.

**Para atualizar depois** (se eu te mandar uma nova versão do app): descompacte a nova pasta, `cd` até ela, rode `npm install` e depois `netlify deploy --prod` de novo — ele vai perguntar se quer linkar ao site já existente (diga que sim).

---

## Opção B — Pelo GitHub (alternativa, tudo pelo navegador)

Se preferir não usar terminal, esse caminho funciona 100% pela página do navegador. Leva uns 15 minutos, uma vez só.

### Parte 1 — Colocar os arquivos no GitHub

1. Acesse **github.com** e crie uma conta gratuita, se ainda não tiver.
2. Clique no **+** no canto superior direito → **New repository**.
3. Dê um nome, por exemplo `liberacao-de-camadas`. Marque como **Private** (só quem você convidar vai ver o código — isso não afeta quem consegue ver a página publicada, que é decidido depois no Netlify/pelas senhas).
4. Clique em **Create repository**.
5. Na página do repositório recém-criado, clique em **uploading an existing file** (ou **Add file → Upload files**).
6. Abra a pasta deste pacote no seu computador e **arraste a pasta inteira** (com tudo dentro: `index.html`, `app.js`, `assets`, `vendor`, `netlify`, `package.json`, `netlify.toml`) para dentro da área de upload do GitHub. Ele mantém as subpastas do jeito que estão.
7. Role para baixo e clique em **Commit changes**.

Pronto — o código está no GitHub.

### Parte 2 — Conectar o repositório ao Netlify

1. Acesse **netlify.com** e crie uma conta gratuita (dá pra entrar direto com a conta do GitHub, é mais rápido) — ou use a conta que você já tem.
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

### Parte 3 — Configurar as duas senhas

As senhas **não ficam escritas em nenhum arquivo** — ficam guardadas só dentro do Netlify, como "variável de ambiente". É isso que faz a senha valer de verdade (ninguém consegue descobrir olhando o código do site).

1. No painel do seu site no Netlify, vá em **Site configuration → Environment variables**.
2. Clique em **Add a variable → Add a single variable** e crie:
   - Chave: `EDIT_PASSWORD_JOAO` → Valor: `00063727`
3. Repita para a segunda:
   - Chave: `EDIT_PASSWORD_ALINE` → Valor: `00056087`
4. Salve. Depois vá em **Deploys** e clique em **Trigger deploy → Deploy site** (as variáveis novas só valem a partir do próximo deploy).

---

## Testar (vale para as duas opções)

1. Abra o link do site (o `https://....netlify.app`, ou o domínio que você configurou).
2. Sem fazer login: você deve ver as 7 faixas, os botões **Imprimir / PDF** e **Login**, mas **sem** o botão de Baixar Excel e sem os botões de editar (isso é o modo "acompanhamento", igual vai ser pra quem está na obra).
3. Clique em **Login**, digite `00063727` → deve aparecer "Bem-vindo João!" e liberar a edição (Baixar Excel, mover faixas, ✕ remover, 🔁 Novo Lançamento, etc).
4. Clique em **Login** de novo (agora mostrando "Sair (João)") pra sair, e teste com `00056087` → deve aparecer "Bem-vinda Aline!".
5. Abra o mesmo link em outro navegador (ou no celular) sem fazer login, faça uma alteração no primeiro (logado), e veja a tela do segundo atualizar sozinha em alguns segundos.

---

## Perguntas que provavelmente vão surgir

**Preciso de GitHub?** Não. A Opção A publica só com a sua conta Netlify. O GitHub (Opção B) é só uma alternativa para quem prefere não usar terminal.

**Quanto custa?** Nada, dentro do uso normal de uma obra (poucos acessos por minuto). O plano gratuito do Netlify cobre isso tranquilamente — nas duas opções.

**A atualização é instantânea?** Quase — quem só acompanha (sem login) atualiza a tela sozinha a cada 5 segundos. Não é instantâneo no sentido de "aparece no mesmo milissegundo", mas dá a sensação de tempo real numa obra.

**Como troco as senhas depois?** Repita o passo das variáveis de ambiente (Passo 6 da Opção A, ou Parte 3 da Opção B) com os novos valores e publique de novo. Não precisa mexer em nenhum código.

**Dá pra ter uma terceira pessoa editando?** Dá — é só adicionar uma terceira variável (por exemplo `EDIT_PASSWORD_MARIA`) e um trecho a mais no `login.mjs` e no `save-state.mjs` reconhecendo essa senha. Se precisar disso, é só pedir.

**E se eu esquecer as duas senhas?** Diferente da versão antiga (arquivo local criptografado), aqui não tem problema: você mesmo redefine as senhas a qualquer momento, sem perder nenhum dado — as senhas só controlam quem pode editar, os dados ficam guardados à parte, no banco do site.

**Os dados ficam salvos entre uma publicação e outra?** Sim. Os dados das faixas ficam no "Netlify Blobs" (um banco de dados simples ligado ao site), separado do código. Pode publicar de novo (Passo 7 da Opção A, ou Parte 2 da Opção B) sem se preocupar — os dados continuam lá.
