// POST /api/login  { password }
// Confere a senha contra as variáveis de ambiente do site no Netlify (nunca
// gravadas no código). Não existe usuário/sessão de verdade aqui — é só a
// confirmação de que a senha bate, para o navegador saber que pode chamar
// save-state depois (que confere a senha de novo, em cada gravação).
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
    console.error('login: variáveis EDIT_PASSWORD_JOAO / EDIT_PASSWORD_ALINE não configuradas no site');
    return new Response(JSON.stringify({ ok: false, error: 'Login não configurado no servidor' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  let name = null;
  if (password && password === pJoao) name = 'João';
  else if (password && password === pAline) name = 'Aline';

  if (!name) {
    return new Response(JSON.stringify({ ok: false, error: 'Senha incorreta' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true, name, password }), {
    headers: { 'content-type': 'application/json' },
  });
};

export const config = { path: '/api/login' };
