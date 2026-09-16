// GET /api/get-state — leitura pública do estado compartilhado (faixas, histórico,
// lançamentos arquivados). Qualquer pessoa com o link pode chamar isso: é o que
// alimenta a tela de quem só acompanha (encarregados na obra), sem precisar de senha.
// Quem edita (login válido) é decidido só na hora de ESCREVER, em save-state.mjs.
import { getStore } from '@netlify/blobs';
import { DEFAULT_STATE } from './lib/default-state.mjs';

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ ok: false, error: 'Método não permitido' }), {
      status: 405,
      headers: { 'content-type': 'application/json' },
    });
  }
  try {
    const store = getStore({ name: 'liberacao-camadas', consistency: 'strong' });
    const state = await store.get('state', { type: 'json' });
    const body = state && Array.isArray(state.faixas) ? state : DEFAULT_STATE;
    return new Response(JSON.stringify(body), {
      headers: {
        'content-type': 'application/json',
        // nunca cachear: cada consulta deve refletir o estado mais recente
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    console.error('get-state falhou', err);
    return new Response(JSON.stringify({ ok: false, error: 'Falha ao ler o estado' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
};

export const config = { path: '/api/get-state' };
