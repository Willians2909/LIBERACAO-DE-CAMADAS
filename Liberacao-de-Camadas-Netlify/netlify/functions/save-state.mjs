// POST /api/save-state  { password, state }
// Esta é a ÚNICA porta de escrita do sistema. A senha é conferida aqui de novo
// (não basta ter passado no /api/login antes) — então mesmo que alguém tente
// chamar essa função direto, sem passar pela tela de login, sem a senha certa
// nada é gravado. Isso é o que garante que só quem sabe a senha do João ou da
// Aline consegue alterar a liberação das faixas.
import { getStore } from '@netlify/blobs';

function validState(s) {
  return s && typeof s === 'object' && Array.isArray(s.faixas);
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'Método não permitido' }), {
      status: 405,
      headers: { 'content-type': 'application/json' },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'Corpo inválido' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const password = body && typeof body.password === 'string' ? body.password : '';
  const pJoao = process.env.EDIT_PASSWORD_JOAO || '';
  const pAline = process.env.EDIT_PASSWORD_ALINE || '';

  if (!pJoao || !pAline) {
    console.error('save-state: variáveis EDIT_PASSWORD_JOAO / EDIT_PASSWORD_ALINE não configuradas no site');
    return new Response(JSON.stringify({ ok: false, error: 'Login não configurado no servidor' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  let name = null;
  if (password && password === pJoao) name = 'João';
  else if (password && password === pAline) name = 'Aline';

  if (!name) {
    return new Response(JSON.stringify({ ok: false, error: 'Senha incorreta ou ausente — nada foi salvo' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const state = body && body.state;
  if (!validState(state)) {
    return new Response(JSON.stringify({ ok: false, error: 'Estado inválido — nada foi salvo' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  try {
    const savedAt = new Date().toISOString();
    state.meta = state.meta || {};
    state.meta.savedAt = savedAt;
    state.meta.updatedBy = name;

    const store = getStore({ name: 'liberacao-camadas', consistency: 'strong' });
    await store.setJSON('state', state);

    return new Response(JSON.stringify({ ok: true, savedAt, updatedBy: name }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    console.error('save-state falhou', err);
    return new Response(JSON.stringify({ ok: false, error: 'Falha ao gravar o estado' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
};

export const config = { path: '/api/save-state' };
