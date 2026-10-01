(function(){
  "use strict";

  var API_BASE = window.LC_API_BASE || '/api';
  var POLL_MS = 5000;
  var SAVE_DEBOUNCE_MS = 700;
  var SAVE_RETRY_MS = 4000;
  // Tempo máximo esperando a planilha confirmar o recebimento no botão Salvar.
  var SHEETS_TIMEOUT_MS = 30000;
  // URL do Web App do Google Apps Script (mesma planilha da premiação) que recebe
  // o histórico (aprovações/reprovações/contraprova/observações) quando o editor
  // clica em "Salvar". Deixe em branco (window.LC_SHEETS_URL = '') para desativar.
  var SHEETS_MIRROR_URL = window.LC_SHEETS_URL || '';

  // Versão do formato dos dados guardados no servidor. 1 = faixas com "pontos" e
  // "lançamentos arquivados"; 2 = faixas com histórico de camadas e quadrantes
  // (OE / Núcleo / OD). Estados na versão 1 são convertidos automaticamente.
  var SCHEMA = 2;

  var STATES = ['pendente','aprovado','reprovado','contraprova'];
  var LAB_FULL = {pendente:'Pendente', aprovado:'Aprovado', reprovado:'Reprovado', contraprova:'Contraprova'};
  var LAYER_LABEL = {liberado:'Liberado', reprovado:'Reprovado', contraprova:'Contraprova', aguardando:'Aguardando'};

  var DEFAULT_STATE = { schema:SCHEMA, meta:{ savedAt:null, updatedBy:null }, faixas:[], historico:[], histSnapshot:{}, planilhaFila:[] };

  var state = null;
  var isEditor = false;
  var editorName = null;
  var editorPassword = null;
  var pollTimer = null;
  var saveTimer = null;
  var enviandoPlanilha = false;
  var lastServerJson = null;
  // Camada escolhida no "Histórico" de cada faixa. É só visualização local
  // (não vai para o servidor), para cada pessoa poder olhar camadas antigas
  // sem mudar a tela dos outros.
  var viewLayer = {};
  var modalFaixaId = null;

  /* ==================== API ==================== */
  function api(path, opts){
    opts = opts || {};
    var fetchOpts = { method: opts.method || 'GET', headers: {'content-type':'application/json'} };
    if(opts.body !== undefined) fetchOpts.body = JSON.stringify(opts.body);
    return fetch(API_BASE + path, fetchOpts).then(function(res){
      return res.text().then(function(text){
        var data = {};
        try{ data = text ? JSON.parse(text) : {}; }catch(e){ /* resposta não-JSON */ }
        if(!res.ok){
          var err = new Error((data && data.error) || ('Erro ' + res.status));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  /* ==================== modelo: faixa → camadas → quadrantes ==================== */
  function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function validState(s){ return STATES.indexOf(s) >= 0 ? s : 'pendente'; }
  function nowIso(){ return new Date().toISOString(); }
  function todayKey(){
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth()+1) + '-' + pad2(d.getDate());
  }
  function localDayKey(iso){
    if(!iso) return '';
    var d = new Date(iso);
    if(isNaN(d)) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth()+1) + '-' + pad2(d.getDate());
  }

  // Primeiro quadrante = Ombreira Esquerda, último = Ombreira Direita, o resto é Núcleo.
  function normalizeTypes(l){
    var n = l.quads.length;
    l.quads.forEach(function(q, i){
      q.tipo = i === 0 ? 'OE' : (i === n - 1 ? 'OD' : 'NUCLEO');
      q.nome = 'Q' + (i + 1);
    });
  }
  function mkQuad(compactado){
    return { id:uid(), nome:'', tipo:'NUCLEO', compactado:compactado !== false, A:'pendente', D:'pendente', AEm:null, DEm:null };
  }
  function mkLayer(camada, lancamento, qtd){
    var now = nowIso();
    var l = { id:uid(), camada:String(camada), lancamento:lancamento, volume:0, oao:'SIM', obs:'',
      createdAt:now, updatedAt:now, touchedOn:todayKey(), quads:[] };
    for(var i = 0; i < qtd; i++) l.quads.push(mkQuad(true));
    normalizeTypes(l);
    return l;
  }
  function currentLayer(f){ return f.layers[f.layers.length - 1]; }
  function shownLayer(f){
    var id = viewLayer[f.id];
    if(id){
      for(var i = 0; i < f.layers.length; i++) if(f.layers[i].id === id) return f.layers[i];
    }
    return currentLayer(f);
  }
  function findFaixa(id){ return state.faixas.find(function(f){ return f.id === id; }); }
  function findLayer(f, id){ return f.layers.find(function(l){ return l.id === id; }); }

  function isReleased(q){ return q.compactado && q.A === 'aprovado' && q.D === 'aprovado'; }
  function qStatus(q){
    if(!q.compactado) return 'compact-pendente';
    if(q.A === 'reprovado' || q.D === 'reprovado') return 'q-bad';
    if(q.A === 'contraprova' || q.D === 'contraprova') return 'q-warn';
    if(isReleased(q)) return 'q-ok';
    return '';
  }
  function qStatusText(q){
    if(!q.compactado) return 'Compactação pendente';
    if(q.A === 'reprovado' || q.D === 'reprovado') return 'Reprovado';
    if(q.A === 'contraprova' || q.D === 'contraprova') return 'Contraprova';
    if(isReleased(q)) return 'Liberado';
    return 'Compactado / aguardando ensaio';
  }
  // Status do ponto como no Excel ("Detalhe por ponto") e na planilha.
  function pontoStatusText(q){
    if(!q.compactado) return 'Compactação pendente';
    if(q.A === 'reprovado' || q.D === 'reprovado') return 'Reprovado';
    if(q.A === 'contraprova' || q.D === 'contraprova') return 'Contraprova';
    if(isReleased(q)) return 'Aprovado';
    return 'Pendente';
  }
  function pontoStatusKey(q){
    if(!q.compactado) return 'pendente';
    if(q.A === 'reprovado' || q.D === 'reprovado') return 'reprovado';
    if(q.A === 'contraprova' || q.D === 'contraprova') return 'contraprova';
    if(isReleased(q)) return 'aprovado';
    return 'pendente';
  }
  function layerStatus(l){
    if(l.quads.some(function(q){ return q.compactado && (q.A === 'reprovado' || q.D === 'reprovado'); })) return 'reprovado';
    if(l.quads.some(function(q){ return q.compactado && (q.A === 'contraprova' || q.D === 'contraprova'); })) return 'contraprova';
    if(l.quads.length && l.quads.every(isReleased)) return 'liberado';
    return 'aguardando';
  }
  function typeLabel(t){ return t === 'OE' ? 'Ombreira E.' : t === 'OD' ? 'Ombreira D.' : 'Núcleo'; }
  function typeShort(t){ return t === 'NUCLEO' ? 'Núcleo' : t; }
  function nextState(s){ return STATES[(STATES.indexOf(validState(s)) + 1) % STATES.length]; }

  // Pendências das camadas anteriores à camada "layer" nesta faixa, por região.
  function unresolvedBefore(f, layer){
    var idx = f.layers.findIndex(function(l){ return l.id === layer.id; });
    var res = {OE:[], NUCLEO:[], OD:[]};
    f.layers.slice(0, idx).forEach(function(l){
      l.quads.forEach(function(q, qi){
        if(isReleased(q)) return;
        res[q.tipo === 'OE' ? 'OE' : q.tipo === 'OD' ? 'OD' : 'NUCLEO'].push({layer:l, quadIndex:qi, quad:q});
      });
    });
    return res;
  }

  // Camadas anteriores que bloqueiam este quadrante. OE/OD: qualquer pendência
  // na mesma ombreira. Núcleo: pendência no mesmo quadrante lógico (posição
  // relativa dentro do núcleo, caso a quantidade de quadrantes tenha mudado).
  function inheritedBlocksFor(f, layer, q, qi){
    var pend = unresolvedBefore(f, layer);
    if(q.tipo === 'OE') return uniq(pend.OE.map(function(x){ return x.layer.camada; }));
    if(q.tipo === 'OD') return uniq(pend.OD.map(function(x){ return x.layer.camada; }));
    var core = layer.quads.map(function(qq, i){ return {qq:qq, i:i}; }).filter(function(x){ return x.qq.tipo === 'NUCLEO'; });
    var pos = core.findIndex(function(x){ return x.i === qi; });
    var out = [];
    pend.NUCLEO.forEach(function(item){
      var oldCore = item.layer.quads.map(function(qq, i){ return {qq:qq, i:i}; }).filter(function(x){ return x.qq.tipo === 'NUCLEO'; });
      if(pos >= 0 && oldCore[pos] && oldCore[pos].i === item.quadIndex) out.push(item.layer.camada);
    });
    return uniq(out);
  }
  function uniq(arr){ return arr.filter(function(v, i){ return arr.indexOf(v) === i; }); }

  /* ==================== formato dos dados / conversão da versão 1 ==================== */
  function normalizeState(parsed){
    if(!parsed || !Array.isArray(parsed.faixas)) return JSON.parse(JSON.stringify(DEFAULT_STATE));
    if(parsed.schema !== SCHEMA) parsed = migrarV1(parsed);
    if(!Array.isArray(parsed.historico)) parsed.historico = [];
    if(!parsed.histSnapshot || typeof parsed.histSnapshot !== 'object') parsed.histSnapshot = {};
    if(!Array.isArray(parsed.planilhaFila)) parsed.planilhaFila = [];
    if(!parsed.meta || typeof parsed.meta !== 'object') parsed.meta = {};
    parsed.faixas.forEach(function(f){
      if(!Array.isArray(f.layers) || !f.layers.length) f.layers = [mkLayer(f.numero || 1, 1, 5)];
      f.layers.forEach(function(l){
        if(!Array.isArray(l.quads)) l.quads = [];
        l.quads.forEach(function(q){ q.A = validState(q.A); q.D = validState(q.D); q.compactado = q.compactado !== false; });
        normalizeTypes(l);
      });
    });
    return parsed;
  }

  // Versão 1 → 2: cada lançamento arquivado da faixa vira uma camada do
  // histórico e o lançamento atual vira a camada atual; cada ponto vira um
  // quadrante (já compactado, com os resultados e horários que tinha). Os
  // ids são fixos (derivados do id da faixa e do nº do lançamento) para que a
  // conversão dê sempre o mesmo resultado em todas as telas.
  function migrarV1(old){
    var arquivados = Array.isArray(old.lancamentosArquivados) ? old.lancamentosArquivados : [];
    var snapOld = old.histSnapshot || {};
    var snapNew = {};
    var usados = {};

    function layerFromV1(fid, lanc, camada, vol, oao, pontos, obs, ts, snapFonte){
      var lid = fid + '_L' + lanc;
      while(usados[lid]) lid += 'b';
      usados[lid] = true;
      var l = { id:lid, camada:String(camada), lancamento:lanc, volume:Number(vol)||0, oao: oao ? 'SIM' : 'NÃO',
        obs: obs || '', createdAt: ts || null, updatedAt: ts || null, touchedOn: localDayKey(ts), quads:[] };
      (pontos || []).forEach(function(p, i){
        var q = { id: lid + '_Q' + (i+1), nome:'', tipo:'', compactado:true, A:validState(p.aterpa), D:validState(p.diefra),
          AEm:p.aterpaEm || null, DEm:p.diefraEm || null };
        l.quads.push(q);
        // Lançamentos arquivados já tinham sido consolidados: a base é o próprio
        // resultado. O atual usa a última consolidação da versão 1 (por rótulo).
        var base = snapFonte ? snapFonte[fid + '::' + (p.label || '')] : {aterpa:q.A, diefra:q.D};
        if(base) snapNew[snapKey(l, q)] = {A:validState(base.aterpa), D:validState(base.diefra)};
      });
      normalizeTypes(l);
      return l;
    }

    var faixas = old.faixas.map(function(f, idx){
      var fid = f.id || ('f' + (idx + 1));
      var camadaAtual = (f.camada !== undefined && f.camada !== null && String(f.camada).trim() !== '') ? f.camada : f.numero;
      var layers = [];
      arquivados.filter(function(a){ return a.faixaId === fid; }).forEach(function(a){
        var cam = (a.camada !== undefined && a.camada !== null && String(a.camada).trim() !== '') ? a.camada : f.numero;
        layers.push(layerFromV1(fid, a.lancamento || 1, cam, a.volumeM3, a.compOmbreiraOmbreira, a.pontos, '', a.arquivadoEm, null));
      });
      var atual = layerFromV1(fid, f.lancamento || 1, camadaAtual, f.volumeM3, f.compOmbreiraOmbreira, f.pontos, f.observacao, f.atualizadoEm, snapOld);
      if(snapOld['obs::' + fid] !== undefined) snapNew['obs::' + atual.id] = snapOld['obs::' + fid];
      layers.push(atual);
      return { id:fid, numero:String(f.numero), layers:layers };
    });

    return {
      schema: SCHEMA,
      meta: old.meta || {},
      faixas: faixas,
      historico: Array.isArray(old.historico) ? old.historico : [],
      histSnapshot: snapNew,
      planilhaFila: Array.isArray(old.planilhaFila) ? old.planilhaFila : []
    };
  }

  /* ==================== sync com o servidor ==================== */
  function updateSyncBadge(text, kind){
    var el = document.getElementById('syncBadge');
    if(!el) return;
    el.textContent = text;
    el.className = 'sync-badge' + (kind ? ' is-' + kind : '');
  }

  function fetchState(){
    return api('/get-state').then(function(data){
      var json = JSON.stringify(data);
      var mudou = json !== lastServerJson;
      lastServerJson = json;
      // Quem só acompanha recebe o estado a cada 5 s; só redesenha se mudou,
      // para não fechar um menu aberto nem pular a tela à toa.
      if(mudou || !state || isEditor){
        state = normalizeState(data);
        render();
      }
      if(!isEditor) updateSyncBadge('ao vivo · atualizado ' + fmtTime(nowIso()), 'ok');
    }).catch(function(err){
      console.error('falha ao buscar estado', err);
      if(!isEditor) updateSyncBadge('sem conexão — tentando de novo', 'error');
      // index.html aberto direto da pasta (duplo clique): não há servidor para ler os dados.
      if(!state && location.protocol === 'file:'){
        document.getElementById('root').innerHTML = '<div class="backlog-panel"><b>Este arquivo precisa do site publicado para funcionar.</b>' +
          '<div class="note">Abra o endereço do site no Netlify, ou, para testar sem internet, abra o arquivo <b>dist/Liberacao-de-Camadas-OFFLINE.html</b>.</div></div>';
      }
    });
  }

  function startPolling(){
    stopPolling();
    pollTimer = setInterval(function(){
      if(!isEditor && !document.hidden) fetchState();
    }, POLL_MS);
  }
  function stopPolling(){ if(pollTimer){ clearInterval(pollTimer); pollTimer = null; } }

  function scheduleSave(){
    if(!isEditor) return;
    updateSyncBadge('editando…', 'saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(pushState, SAVE_DEBOUNCE_MS);
  }

  function pushState(){
    if(!isEditor || !state) return;
    updateSyncBadge('salvando…', 'saving');
    api('/save-state', { method:'POST', body:{ password: editorPassword, state: state } }).then(function(res){
      state.meta = state.meta || {};
      state.meta.savedAt = res.savedAt;
      state.meta.updatedBy = res.updatedBy;
      updateSyncBadge('salvo às ' + fmtTime(res.savedAt), 'ok');
    }).catch(function(err){
      if(err.status === 401){
        alert('Sua sessão de edição não é mais válida (senha alterada ou login expirado). Faça login novamente para continuar editando.');
        logout();
        return;
      }
      console.error('falha ao salvar', err);
      updateSyncBadge('erro ao salvar — tentando de novo', 'error');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(pushState, SAVE_RETRY_MS);
    });
  }

  /* ==================== login / logout ==================== */
  function showLoginOverlay(){
    var input = document.getElementById('loginPassInput');
    input.value = '';
    document.getElementById('loginError').style.display = 'none';
    document.getElementById('loginOverlay').classList.add('show');
    setTimeout(function(){ input.focus(); }, 50);
  }
  function hideLoginOverlay(){ document.getElementById('loginOverlay').classList.remove('show'); }

  function attemptLogin(){
    var input = document.getElementById('loginPassInput');
    var pwd = input.value;
    var errEl = document.getElementById('loginError');
    errEl.style.display = 'none';
    if(!pwd){ errEl.textContent = 'Informe a senha.'; errEl.style.display = 'block'; return; }
    api('/login', { method:'POST', body:{ password: pwd } }).then(function(res){
      isEditor = true;
      editorName = res.name;
      editorPassword = pwd;
      try{ sessionStorage.setItem('lc_editor', JSON.stringify({ name:editorName, password:editorPassword })); }catch(e){}
      hideLoginOverlay();
      stopPolling();
      applyRoleUI();
      fetchState().then(function(){
        var saudacao = editorName === 'Aline' ? 'Bem-vinda' : 'Bem-vindo';
        showToast(saudacao + ' ' + editorName + '! Modo de edição ativado.');
      });
    }).catch(function(err){
      errEl.textContent = err.status === 401 ? 'Senha incorreta.' : 'Não foi possível entrar agora. Tente de novo em instantes.';
      errEl.style.display = 'block';
      input.select();
    });
  }

  function logout(){
    if(isEditor){
      // consolida as mudanças de ensaio ainda não registradas antes de sair; elas
      // ficam na fila (state.planilhaFila) até o próximo clique em "Salvar".
      commitHistorySnapshot();
      clearTimeout(saveTimer);
      pushState();
    }
    isEditor = false;
    editorName = null;
    editorPassword = null;
    try{ sessionStorage.removeItem('lc_editor'); }catch(e){}
    applyRoleUI();
    startPolling();
    fetchState();
    showToast('Login encerrado — voltando ao modo de acompanhamento.');
  }

  function restoreSession(){
    try{
      var raw = sessionStorage.getItem('lc_editor');
      if(!raw) return;
      var saved = JSON.parse(raw);
      if(saved && saved.name && saved.password){
        isEditor = true; editorName = saved.name; editorPassword = saved.password;
      }
    }catch(e){}
  }

  function applyRoleUI(){
    document.body.classList.toggle('is-editor', isEditor);
    var btn = document.getElementById('loginBtn');
    if(btn) btn.textContent = isEditor ? ('🔓 Sair (' + editorName + ')') : '🔒 Login';
    if(state) render();
  }

  /* ==================== histórico interno (aba "Histórico" do Excel) ==================== */
  function logHistorico(f, l, ponto, laboratorio, status){
    if(!Array.isArray(state.historico)) state.historico = [];
    state.historico.push({
      ts: nowIso(),
      faixa: f.numero,
      camada: l.camada,
      lancamento: l.lancamento,
      ponto: ponto || '',
      laboratorio: laboratorio || editorName || 'Sala de controle',
      status: status || ''
    });
  }
  function nomePonto(q){ return q.nome + ' · ' + typeShort(q.tipo); }

  /* ==================== planilha online (aba LIBERACAO_CAMADAS_HISTORICO) ==================== */
  // Cada linha segue o mesmo formato do "Detalhe por ponto" do Excel: Faixa,
  // Camada, Lançamento, Ponto, Aterpa, Horário Aterpa, Diefra, Horário Diefra,
  // Status do ponto (mais a Data/Hora do evento na frente).
  function sheetsRowFromQuad(f, l, q){
    return {
      ts: nowIso(),
      faixa: 'Faixa ' + f.numero,
      camada: String(l.camada),
      lancamento: 'Lançamento ' + l.lancamento,
      ponto: nomePonto(q),
      aterpa: LAB_FULL[q.A],
      horarioAterpa: fmtDateTime(q.AEm) || '—',
      diefra: LAB_FULL[q.D],
      horarioDiefra: fmtDateTime(q.DEm) || '—',
      statusPonto: pontoStatusText(q)
    };
  }
  // Eventos que não são ensaio de um quadrante (OAO, Nova camada, Observação)
  // reaproveitam as mesmas colunas: "Ponto" = nome do evento, "Status" = resultado.
  function sheetsRowEvento(f, l, nomeEvento, statusTexto){
    return {
      ts: nowIso(),
      faixa: 'Faixa ' + f.numero,
      camada: String(l.camada),
      lancamento: 'Lançamento ' + l.lancamento,
      ponto: nomeEvento || '',
      aterpa: '—', horarioAterpa: '—', diefra: '—', horarioDiefra: '—',
      statusPonto: statusTexto || ''
    };
  }

  // As linhas ficam numa fila guardada junto com o estado no servidor e só são
  // enviadas no "Salvar" (fechamento do dia) — nada se perde se a sessão cair.
  function enfileirarPlanilha(rows){
    if(!rows || !rows.length) return;
    if(!Array.isArray(state.planilhaFila)) state.planilhaFila = [];
    Array.prototype.push.apply(state.planilhaFila, rows);
  }

  function enviarParaPlanilha(rows){
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function(){ controller.abort(); }, SHEETS_TIMEOUT_MS) : null;
    return fetch(SHEETS_MIRROR_URL, {
      method: 'POST',
      headers: {'Content-Type': 'text/plain;charset=utf-8'},
      body: JSON.stringify({
        acao: 'LIBERACAO_HISTORICO',
        origem: 'LIBERACAO_CAMADAS',
        registros: JSON.stringify(rows)
      }),
      signal: controller ? controller.signal : undefined
    }).then(function(res){
      return res.text().then(function(text){
        var data = null;
        try{ data = JSON.parse(text); }catch(e){}
        if(!res.ok || !data || data.ok !== true){
          throw new Error((data && data.error) || ('resposta inesperada da planilha (HTTP ' + res.status + ')'));
        }
        return data;
      });
    }).finally(function(){ if(timer) clearTimeout(timer); });
  }

  // ===== botão "Salvar": fechamento do dia na planilha =====
  // Consolida os ensaios, envia a fila (aprovado / reprovado / contraprova / OAO /
  // novas camadas) mais as observações preenchidas de cada camada e, só depois
  // que a planilha confirma o recebimento, apaga da tela as observações enviadas.
  function salvarNaPlanilha(){
    if(!isEditor || !state || enviandoPlanilha) return;
    if(!SHEETS_MIRROR_URL){ showToast('Envio para a planilha não está configurado.'); return; }

    commitHistorySnapshot();

    var fila = (state.planilhaFila || []).slice();
    var obsEnviadas = [];
    var obsRows = [];
    state.faixas.forEach(function(f){
      f.layers.forEach(function(l){
        var texto = l.obs || '';
        if(!texto.trim()) return;
        obsEnviadas.push({ faixaId:f.id, layerId:l.id, texto:texto });
        obsRows.push(sheetsRowEvento(f, l, 'Observação', texto.trim()));
      });
    });

    if(!fila.length && !obsRows.length){ showToast('Nada novo para enviar à planilha.'); return; }

    var msg = 'Salvar o dia na planilha online?\n\n' +
      '• ' + fila.length + ' registro(s) de ensaio / evento\n' +
      '• ' + obsRows.length + ' observação(ões)' +
      (obsRows.length ? '\n\nAs observações enviadas serão apagadas da tela (continuam registradas na planilha).' : '');
    if(!confirm(msg)) return;

    setSalvandoPlanilha(true);
    enviarParaPlanilha(fila.concat(obsRows)).then(function(){
      // Tira da fila só o que foi enviado (algo pode ter entrado durante o envio).
      state.planilhaFila.splice(0, fila.length);
      obsEnviadas.forEach(function(o){
        var f = findFaixa(o.faixaId);
        var l = f && findLayer(f, o.layerId);
        // Se alguém editou a observação durante o envio, mantém o texto novo.
        if(!l || (l.obs || '') !== o.texto) return;
        l.obs = '';
        state.histSnapshot['obs::' + l.id] = '';
      });
      state.meta = state.meta || {};
      state.meta.ultimoEnvioPlanilha = { em: nowIso(), por: editorName, registros: fila.length + obsRows.length };
      scheduleSave();
      render();
      showToast('Salvo na planilha: ' + (fila.length + obsRows.length) + ' registro(s).');
    }).catch(function(err){
      console.error('falha ao enviar para a planilha', err);
      alert('Não foi possível salvar na planilha agora (' + (err && err.name === 'AbortError' ? 'sem resposta da planilha' : (err && err.message) || 'erro de conexão') + ').\n\nNada foi apagado — tente Salvar de novo em instantes.');
    }).finally(function(){
      setSalvandoPlanilha(false);
    });
  }

  function setSalvandoPlanilha(on){
    enviandoPlanilha = on;
    var btn = document.getElementById('saveSheetsBtn');
    if(!btn) return;
    btn.disabled = on;
    btn.textContent = on ? '⏳ Salvando…' : '💾 Salvar';
  }

  // ===== consolidação do histórico de ensaios =====
  // O resultado "ao vivo" muda na hora, mas o histórico (Excel e planilha) só
  // registra o que mudou desde a última consolidação — feita no "Salvar", ao
  // criar uma nova camada, ao baixar o Excel e ao sair — para não lotar o
  // registro com cliques errados corrigidos na sequência.
  function snapKey(l, q){ return 'q::' + l.id + '::' + q.id; }

  function commitHistorySnapshot(){
    if(!state || !isEditor) return;
    if(!state.histSnapshot || typeof state.histSnapshot !== 'object') state.histSnapshot = {};
    var rows = [];
    state.faixas.forEach(function(f){
      f.layers.forEach(function(l){
        l.quads.forEach(function(q){
          var key = snapKey(l, q);
          // Quadrante nunca consolidado parte de pendente — assim um resultado
          // marcado antes do primeiro Salvar também é registrado.
          var last = state.histSnapshot[key] || {A:'pendente', D:'pendente'};
          var mudou = q.A !== last.A || q.D !== last.D;
          if(q.A !== last.A) logHistorico(f, l, nomePonto(q), 'Aterpa', LAB_FULL[q.A]);
          if(q.D !== last.D) logHistorico(f, l, nomePonto(q), 'Diefra', LAB_FULL[q.D]);
          // Quadrante que voltou a ficar todo pendente não vai para a planilha.
          if(mudou && !(q.A === 'pendente' && q.D === 'pendente')) rows.push(sheetsRowFromQuad(f, l, q));
          state.histSnapshot[key] = {A:q.A, D:q.D};
        });
        // Observação: só no histórico interno; para a planilha ela vai no "Salvar".
        var obsKey = 'obs::' + l.id;
        var curObs = l.obs || '';
        var lastObs = state.histSnapshot[obsKey];
        if(lastObs === undefined) state.histSnapshot[obsKey] = curObs;
        else if(curObs !== lastObs){
          logHistorico(f, l, 'Observação', null, curObs || '(em branco)');
          state.histSnapshot[obsKey] = curObs;
        }
      });
    });
    enfileirarPlanilha(rows);
    scheduleSave();
  }

  /* ==================== utilidades ==================== */
  function escapeHtml(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function pad2(n){ return n < 10 ? '0' + n : '' + n; }
  function fmtDateTime(iso){
    if(!iso) return '';
    var d = new Date(iso);
    if(isNaN(d)) return '';
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'});
  }
  function fmtTime(iso){
    if(!iso) return '';
    var d = new Date(iso);
    if(isNaN(d)) return '';
    return d.toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'});
  }
  function touchLayer(l){ l.touchedOn = todayKey(); l.updatedAt = nowIso(); }
  function showToast(msg){
    var t = document.getElementById('toast');
    if(!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function(){ t.classList.remove('show'); }, 2600);
  }
  // Toda edição passa por aqui: grava no servidor (tela ao vivo) e redesenha.
  function changed(l, noRender){
    if(l) touchLayer(l);
    scheduleSave();
    if(!noRender) render();
  }

  /* ==================== render ==================== */
  function render(){
    if(!state) return;
    var root = document.getElementById('root');
    var html = state.faixas.map(faixaCardHtml).join('');
    if(!state.faixas.length) html = '<div class="backlog-empty" style="padding:18px">Nenhuma faixa cadastrada ainda.</div>';
    root.innerHTML = html;
    applyEditMode();
    updateStats();
    renderBacklog();
  }

  function faixaCardHtml(f, fi){
    var l = shownLayer(f);
    var st = layerStatus(l);
    var blocks = unresolvedBefore(f, l);
    var latest = currentLayer(f).id === l.id;
    var total = state.faixas.length;
    var fid = escapeHtml(f.id);

    var layerOptions = f.layers.map(function(x){
      return '<option value="' + escapeHtml(x.id) + '"' + (x.id === l.id ? ' selected' : '') + '>Camada ' + escapeHtml(x.camada) + ' — ' + LAYER_LABEL[layerStatus(x)].toLowerCase() + '</option>';
    }).join('');

    var out = '<div class="faixa-card ' + st + '" id="faixa_' + fid + '" data-fid="' + fid + '" data-lid="' + escapeHtml(l.id) + '">';
    out += '<div class="faixa-head">' +
      '<span class="faixa-title">Faixa</span>' +
      '<input class="faixa-num" data-f="numero" value="' + escapeHtml(f.numero) + '">' +
      '<div class="meta">Histórico <select class="layer-select" data-action="switch-layer" data-keep-enabled="1">' + layerOptions + '</select>' +
        '<button type="button" class="btn sm editor-only" data-action="rename-layer" title="Alterar o número da camada selecionada">✏️ Nº camada</button></div>' +
      '<div class="meta">Volume <input type="number" min="0" step="1" data-f="volume" value="' + (Number(l.volume) || 0) + '"> m³</div>' +
      '<div class="meta">OAO <select data-action="oao">' +
        '<option value="SIM"' + (l.oao === 'SIM' ? ' selected' : '') + '>SIM</option>' +
        '<option value="NÃO"' + (l.oao !== 'SIM' ? ' selected' : '') + '>NÃO</option>' +
      '</select></div>' +
      '<button class="btn sm editor-only" type="button" title="Mover faixa para cima" data-action="move-up"' + (fi === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button class="btn sm editor-only" type="button" title="Mover faixa para baixo" data-action="move-down"' + (fi === total - 1 ? ' disabled' : '') + '>↓</button>' +
      '<button class="btn sm primary editor-only" type="button" data-action="new-layer">+ Nova camada</button>' +
      '<button class="btn sm danger editor-only" type="button" data-action="remove-faixa">Excluir faixa</button>' +
      '<span class="layer-badge ' + (latest ? 'current' : 'old') + '">Camada ' + escapeHtml(l.camada) + ' · Lanç. ' + l.lancamento + (latest ? ' • atual' : ' • histórico') + '</span>' +
      '<div class="head-status ' + st + '">' + LAYER_LABEL[st] + '</div>' +
      '</div>';

    if(blocks.OE.length || blocks.NUCLEO.length || blocks.OD.length){
      out += '<div class="block-banner">';
      if(blocks.OE.length) out += '<span class="block-chip">⚠ OE BLOQUEADA: camada(s) ' + escapeHtml(uniq(blocks.OE.map(function(x){ return x.layer.camada; })).join(', ')) + ' pendente(s)</span>';
      if(blocks.NUCLEO.length) out += '<span class="block-chip">⚠ NÚCLEO BLOQUEADO: camada(s) ' + escapeHtml(uniq(blocks.NUCLEO.map(function(x){ return x.layer.camada; })).join(', ')) + ' pendente(s)</span>';
      if(blocks.OD.length) out += '<span class="block-chip">⚠ OD BLOQUEADA: camada(s) ' + escapeHtml(uniq(blocks.OD.map(function(x){ return x.layer.camada; })).join(', ')) + ' pendente(s)</span>';
      out += '</div>';
    }

    out += '<div class="quad-strip">';
    l.quads.forEach(function(q, qi){
      var blockLayers = inheritedBlocksFor(f, l, q, qi);
      var blocked = blockLayers.length > 0;
      var travado = !q.compactado || blocked;
      out += '<div class="quad ' + qStatus(q) + (blocked ? ' blocked' : '') + '" data-qi="' + qi + '">' +
        '<div class="qtop"><span class="qname">' + escapeHtml(q.nome) + '</span><span class="qtype">' + typeLabel(q.tipo) + '</span></div>' +
        (blocked ? '<div class="block-overlay">NÃO LANÇAR MATERIAL<br>Camada(s) ' + escapeHtml(blockLayers.join(', ')) + ' pendente(s)</div>' : '') +
        '<div class="compact-row"><b>Ensaio</b>' +
          '<button type="button" class="compact-toggle ' + (q.compactado ? 'done' : 'pending') + '" data-action="toggle-compact"' + (blocked ? ' disabled data-lock="1"' : '') + '>' + (q.compactado ? 'CONCLUÍDO' : 'PENDENTE') + '</button>' +
        '</div>' +
        '<div class="adrow">' +
          adButtonHtml(q, 'A', travado) +
          adButtonHtml(q, 'D', travado) +
        '</div>' +
        '<div class="qstatus">' + (blocked ? 'Bloqueado por camada anterior' : qStatusText(q)) + '</div>' +
        '<div class="qtools editor-only">' +
          '<button type="button" data-action="insert-before">+ antes</button>' +
          '<button type="button" data-action="insert-after">+ depois</button>' +
          '<button type="button" data-action="remove-quad">Excluir</button>' +
        '</div>' +
        '</div>';
    });
    out += '<button type="button" class="add-quad editor-only" data-action="add-quad">+ Quadrante</button>';
    out += '</div>';

    out += '<div class="obs"><textarea placeholder="Observações da camada..." data-f="obs">' + escapeHtml(l.obs || '') + '</textarea>' +
      '<div class="note">Para liberar bloqueios herdados, selecione a camada antiga no Histórico e conclua a OE/OD pendente.</div></div>';
    out += '</div>';
    return out;
  }

  function adButtonHtml(q, org, travado){
    var v = validState(q[org]);
    var em = q[org + 'Em'];
    var nome = org === 'A' ? 'Aterpa' : 'Diefra';
    var title = nome + ': ' + LAB_FULL[v] + (em ? ' em ' + fmtDateTime(em) : '');
    return '<button type="button" class="adbtn ' + v + '" data-action="toggle-test" data-org="' + org + '" title="' + escapeHtml(title) + '"' +
      (travado ? ' disabled data-lock="1"' : '') + '>' + org + '<br><small>' + LAB_FULL[v] + '</small></button>';
  }

  // Quem não fez login não consegue alterar nada (nem pelo teclado): isso é o que
  // garante o "só a sala de controle edita", não apenas esconder botões. O
  // seletor de Histórico continua liberado para todos (é só visualização).
  function applyEditMode(){
    var root = document.getElementById('root');
    var ro = !isEditor;
    root.querySelectorAll('input, textarea').forEach(function(el){ el.readOnly = ro; });
    root.querySelectorAll('select').forEach(function(el){ if(!el.hasAttribute('data-keep-enabled')) el.disabled = ro; });
    root.querySelectorAll('.adbtn, .compact-toggle').forEach(function(el){ el.disabled = ro || el.hasAttribute('data-lock'); });
  }

  /* ==================== pendências de camadas anteriores ==================== */
  function allBacklogs(){
    var rows = [];
    state.faixas.forEach(function(f){
      f.layers.forEach(function(l, li){
        if(li === f.layers.length - 1) return;
        l.quads.forEach(function(q){
          if(isReleased(q)) return;
          rows.push({ f:f, l:l, q:q, lado: q.tipo === 'NUCLEO' ? ('NÚCLEO ' + q.nome) : q.tipo, filtro: q.tipo });
        });
      });
    });
    return rows;
  }
  function renderBacklog(){
    var box = document.getElementById('backlogList');
    if(!box || !state) return;
    var filter = document.getElementById('pendFilter').value;
    var rows = allBacklogs().filter(function(r){ return filter === 'TODAS' || r.filtro === filter; });
    if(!rows.length){ box.innerHTML = '<div class="backlog-empty">Nenhuma pendência antiga de camada.</div>'; return; }
    box.innerHTML = rows.map(function(r){
      return '<div class="backlog-item">' +
        '<b>Faixa ' + escapeHtml(r.f.numero) + '</b>' +
        '<b>Camada ' + escapeHtml(r.l.camada) + '</b>' +
        '<span>' + escapeHtml(r.lado) + ' — ' + qStatusText(r.q) + '</span>' +
        '<button type="button" class="btn sm block" data-open-fid="' + escapeHtml(r.f.id) + '" data-open-lid="' + escapeHtml(r.l.id) + '">Abrir camada</button>' +
        '</div>';
    }).join('');
  }
  function openBacklog(fid, lid){
    viewLayer[fid] = lid;
    render();
    setTimeout(function(){
      var el = document.getElementById('faixa_' + fid);
      if(el) el.scrollIntoView({behavior:'smooth', block:'start'});
    }, 50);
  }

  /* ==================== resumo do dia ==================== */
  function updateStats(){
    var tk = todayKey();
    var todays = [];
    state.faixas.forEach(function(f){
      f.layers.forEach(function(l){
        if(localDayKey(l.createdAt) === tk || l.touchedOn === tk) todays.push({f:f, l:l});
      });
    });
    var faixasHoje = uniq(todays.map(function(x){ return x.f.id; })).length;
    var camadasHoje = todays.filter(function(x){ return localDayKey(x.l.createdAt) === tk; }).length;
    var pendHoje = 0, liberadasHoje = 0;
    todays.forEach(function(x){
      pendHoje += x.l.quads.filter(function(q){ return !isReleased(q); }).length;
      if(layerStatus(x.l) === 'liberado') liberadasHoje++;
    });
    document.getElementById('stats').innerHTML =
      '<span class="stat">' + faixasHoje + ' faixas hoje</span>' +
      '<span class="stat">' + camadasHoje + ' camadas registradas hoje</span>' +
      '<span class="stat">🔴 ' + pendHoje + ' pendências hoje</span>' +
      '<span class="stat">🟢 ' + liberadasHoje + ' camadas liberadas hoje</span>';
    var s = document.getElementById('summaryChip');
    if(s) s.textContent = 'Hoje: ' + faixasHoje + ' faixas • ' + camadasHoje + ' camadas • ' + pendHoje + ' pendências • ' + liberadasHoje + ' liberadas';
  }

  /* ==================== eventos ==================== */
  function ctx(e){
    var card = e.target.closest('[data-fid]');
    if(!card) return null;
    var f = findFaixa(card.getAttribute('data-fid'));
    if(!f) return null;
    var l = findLayer(f, card.getAttribute('data-lid')) || currentLayer(f);
    var quadEl = e.target.closest('[data-qi]');
    var qi = quadEl ? Number(quadEl.getAttribute('data-qi')) : -1;
    return { f:f, l:l, qi:qi, q: qi >= 0 ? l.quads[qi] : null };
  }

  function bindEvents(){
    var root = document.getElementById('root');

    root.addEventListener('input', function(e){
      if(!isEditor || !e.target.matches('[data-f="obs"]')) return;
      var c = ctx(e); if(!c) return;
      c.l.obs = e.target.value;
      changed(c.l, true);
    });

    root.addEventListener('change', function(e){
      var c = ctx(e); if(!c) return;
      var el = e.target;
      if(el.matches('[data-action="switch-layer"]')){
        viewLayer[c.f.id] = el.value;
        render();
        return;
      }
      if(!isEditor) return;
      if(el.matches('[data-f="numero"]')){
        var num = el.value.trim();
        if(num){ c.f.numero = num; changed(null); } else render();
        return;
      }
      if(el.matches('[data-f="volume"]')){ c.l.volume = Number(el.value) || 0; changed(c.l); return; }
      if(el.matches('[data-action="oao"]')){ changeOao(c.f, c.l, el.value); return; }
    });

    root.addEventListener('click', function(e){
      if(!isEditor) return;
      var actionEl = e.target.closest('button[data-action]');
      if(!actionEl || actionEl.disabled) return;
      var c = ctx(e); if(!c) return;
      var action = actionEl.getAttribute('data-action');
      if(action === 'toggle-test') toggleTest(c.f, c.l, c.q, c.qi, actionEl.getAttribute('data-org'));
      else if(action === 'toggle-compact') toggleCompact(c.f, c.l, c.q, c.qi);
      else if(action === 'insert-before') insertQuad(c.l, c.qi);
      else if(action === 'insert-after') insertQuad(c.l, c.qi + 1);
      else if(action === 'add-quad') insertQuad(c.l, c.l.quads.length);
      else if(action === 'remove-quad') removeQuad(c.l, c.qi);
      else if(action === 'move-up') moveFaixa(c.f, -1);
      else if(action === 'move-down') moveFaixa(c.f, 1);
      else if(action === 'new-layer') openNewLayer(c.f);
      else if(action === 'rename-layer') renameLayer(c.f, c.l);
      else if(action === 'remove-faixa') removeFaixa(c.f);
    });

    document.getElementById('backlogList').addEventListener('click', function(e){
      var b = e.target.closest('[data-open-fid]');
      if(b) openBacklog(b.getAttribute('data-open-fid'), b.getAttribute('data-open-lid'));
    });
  }

  /* ==================== ações de edição ==================== */
  function toggleTest(f, l, q, qi, org){
    if(!q || !q.compactado || inheritedBlocksFor(f, l, q, qi).length) return;
    var novo = nextState(q[org]);
    q[org] = novo;
    q[org + 'Em'] = novo === 'pendente' ? null : nowIso();
    changed(l);
  }

  function setOao(f, l, novo, detalhe){
    if(l.oao === novo) return;
    l.oao = novo;
    var texto = novo + (detalhe ? ' — ' + detalhe : '');
    logHistorico(f, l, 'Compactação de Ombreira a Ombreira', null, texto);
    enfileirarPlanilha([sheetsRowEvento(f, l, 'Compactação de Ombreira a Ombreira', texto)]);
  }
  function detalheCompactacao(l){
    var feitos = [], pend = [];
    var nucleo = l.quads.filter(function(q){ return q.tipo === 'NUCLEO'; });
    [['OE', l.quads.filter(function(q){ return q.tipo === 'OE'; })], ['Núcleo', nucleo], ['OD', l.quads.filter(function(q){ return q.tipo === 'OD'; })]].forEach(function(par){
      if(!par[1].length) return;
      (par[1].every(function(q){ return q.compactado; }) ? feitos : pend).push(par[0]);
    });
    return 'compactado: ' + (feitos.join(', ') || 'nenhum') + '; pendente: ' + (pend.join(', ') || 'nenhum');
  }

  function toggleCompact(f, l, q, qi){
    if(!q || inheritedBlocksFor(f, l, q, qi).length) return;
    q.compactado = !q.compactado;
    if(!q.compactado){ q.A = 'pendente'; q.D = 'pendente'; q.AEm = null; q.DEm = null; }
    var tudo = l.quads.every(function(x){ return x.compactado; });
    setOao(f, l, tudo ? 'SIM' : 'NÃO', tudo ? '' : detalheCompactacao(l));
    changed(l);
  }

  function changeOao(f, l, val){
    if(val === 'SIM'){
      l.quads.forEach(function(q){ q.compactado = true; });
      setOao(f, l, 'SIM', '');
      changed(l);
      return;
    }
    modalFaixaId = f.id;
    var n = l.quads.length;
    document.getElementById('chkOE').checked = !!(l.quads[0] && l.quads[0].compactado);
    document.getElementById('chkOD').checked = !!(l.quads[n - 1] && l.quads[n - 1].compactado);
    document.getElementById('chkNucleo').checked = l.quads.slice(1, -1).every(function(q){ return q.compactado; });
    document.getElementById('oaoModal').classList.add('show');
  }
  function closeOaoModal(){
    document.getElementById('oaoModal').classList.remove('show');
    modalFaixaId = null;
    render(); // desfaz o "NÃO" do seletor se a pessoa cancelou
  }
  function applyOaoNao(){
    var f = modalFaixaId && findFaixa(modalFaixaId);
    if(!f){ closeOaoModal(); return; }
    var l = shownLayer(f);
    var oe = document.getElementById('chkOE').checked;
    var nuc = document.getElementById('chkNucleo').checked;
    var od = document.getElementById('chkOD').checked;
    var n = l.quads.length;
    l.quads.forEach(function(q, i){
      q.compactado = i === 0 ? oe : (i === n - 1 ? od : nuc);
      if(!q.compactado){ q.A = 'pendente'; q.D = 'pendente'; q.AEm = null; q.DEm = null; }
    });
    // Mesmo que já estivesse "NÃO", registra as regiões escolhidas agora.
    l.oao = 'SIM';
    setOao(f, l, 'NÃO', detalheCompactacao(l));
    document.getElementById('oaoModal').classList.remove('show');
    modalFaixaId = null;
    changed(l);
  }

  function insertQuad(l, pos){
    l.quads.splice(pos, 0, mkQuad(l.oao === 'SIM'));
    normalizeTypes(l);
    changed(l);
  }
  function removeQuad(l, qi){
    if(l.quads.length <= 2){ alert('Mantenha pelo menos 2 quadrantes para representar OE e OD.'); return; }
    if(!confirm('Excluir este quadrante desta camada?')) return;
    l.quads.splice(qi, 1);
    normalizeTypes(l);
    changed(l);
  }

  function moveFaixa(f, dir){
    var idx = state.faixas.indexOf(f);
    var j = idx + dir;
    if(idx < 0 || j < 0 || j >= state.faixas.length) return;
    state.faixas[idx] = state.faixas[j];
    state.faixas[j] = f;
    changed(null);
  }

  function nextFaixaId(){
    var n = 1;
    while(state.faixas.some(function(f){ return f.id === 'f' + n; })) n++;
    return 'f' + n;
  }
  function addFaixa(){
    if(!isEditor) return;
    var usados = state.faixas.map(function(f){ return Number(f.numero) || 0; });
    var sugestao = usados.length ? Math.max.apply(null, usados) + 1 : 1;
    var num = prompt('Número da nova faixa:', String(sugestao));
    if(num === null || !num.trim()) return;
    var cam = prompt('Número da camada inicial desta faixa:', '1');
    if(cam === null || !cam.trim()) return;
    var id = nextFaixaId();
    var l = mkLayer(cam.trim(), 1, 5);
    state.faixas.push({ id:id, numero:num.trim(), layers:[l] });
    changed(null);
    setTimeout(function(){
      var el = document.getElementById('faixa_' + id);
      if(el) el.scrollIntoView({behavior:'smooth', block:'start'});
    }, 50);
  }
  function removeFaixa(f){
    if(!confirm('Excluir a Faixa ' + f.numero + ' e todo o histórico de camadas dela? Essa ação não pode ser desfeita.')) return;
    state.faixas = state.faixas.filter(function(x){ return x.id !== f.id; });
    delete viewLayer[f.id];
    changed(null);
  }

  // O número da nova camada é sempre digitado (nada vem preenchido), para não
  // criar camada com número errado por engano.
  function openNewLayer(f){
    var cur = currentLayer(f);
    modalFaixaId = f.id;
    document.getElementById('newLayerNum').value = '';
    document.getElementById('newLayerVol').value = 0;
    document.getElementById('newLayerHint').textContent = 'Faixa ' + f.numero + ' — camada atual: ' + cur.camada + '.';
    document.getElementById('newLayerModal').classList.add('show');
    setTimeout(function(){ document.getElementById('newLayerNum').focus(); }, 50);
  }

  function camadaRepetida(f, num, exceto){
    return f.layers.some(function(x){ return x !== exceto && String(x.camada).trim() === num; });
  }

  // Corrige o número da camada selecionada no Histórico (ex.: digitado errado).
  function renameLayer(f, l){
    var num = prompt('Novo número para a Camada ' + l.camada + ' da Faixa ' + f.numero + ':', String(l.camada));
    if(num === null) return;
    num = num.trim();
    if(!num || num === String(l.camada)) return;
    if(camadaRepetida(f, num, l) && !confirm('A Faixa ' + f.numero + ' já tem uma Camada ' + num + '. Usar esse número mesmo assim?')) return;
    var antigo = l.camada;
    l.camada = num;
    logHistorico(f, l, 'Número da camada alterado', null, 'Camada ' + antigo + ' → Camada ' + num);
    enfileirarPlanilha([sheetsRowEvento(f, l, 'Número da camada alterado', 'Camada ' + antigo + ' → Camada ' + num)]);
    changed(l);
    showToast('Camada ' + antigo + ' agora é a Camada ' + num + '.');
  }
  function closeNewLayerModal(){
    document.getElementById('newLayerModal').classList.remove('show');
    modalFaixaId = null;
  }
  function confirmNewLayer(){
    var f = modalFaixaId && findFaixa(modalFaixaId);
    if(!f){ closeNewLayerModal(); return; }
    var num = String(document.getElementById('newLayerNum').value).trim();
    if(!num){ alert('Informe o número da nova camada.'); return; }
    if(camadaRepetida(f, num, null) && !confirm('A Faixa ' + f.numero + ' já tem uma Camada ' + num + '. Criar outra com o mesmo número?')) return;
    // consolida o histórico antes, para não perder mudanças feitas desde o último Salvar.
    commitHistorySnapshot();
    var cur = currentLayer(f);
    var lanc = Math.max.apply(null, f.layers.map(function(x){ return Number(x.lancamento) || 0; })) + 1;
    var nl = mkLayer(num, lanc, cur.quads.length || 5);
    nl.volume = Number(document.getElementById('newLayerVol').value) || 0;
    // Núcleo já compactado; ombreiras (OE/OD) começam pendentes.
    nl.oao = 'NÃO';
    nl.quads.forEach(function(q, i){ q.compactado = i > 0 && i < nl.quads.length - 1; });
    f.layers.push(nl);
    delete viewLayer[f.id];
    logHistorico(f, nl, 'Nova camada', null, 'Camada ' + cur.camada + ' (Lanç. ' + cur.lancamento + ') para histórico — iniciada Camada ' + num);
    enfileirarPlanilha([sheetsRowEvento(f, nl, 'Nova camada', 'Camada ' + cur.camada + ' (Lançamento ' + cur.lancamento + ') para o histórico — iniciada Camada ' + num)]);
    closeNewLayerModal();
    changed(null);
    showToast('Camada ' + num + ' iniciada na Faixa ' + f.numero + '.');
  }

  /* ==================== baixar Excel ==================== */
  var FILL = { aprovado:'C6EFCE', reprovado:'F8CBAD', contraprova:'FFEB9C', pendente:'E7E6E6',
    liberado:'C6EFCE', aguardando:'E7E6E6', sim:'C6EFCE', nao:'E7E6E6' };
  var FONT_COLOR = { aprovado:'0EA968', reprovado:'D42A55', contraprova:'E08A00', pendente:'555555',
    liberado:'0EA968', aguardando:'555555', sim:'0EA968', nao:'555555' };

  function styledCell(value, statusKey){
    var cell = {v: value, t: (typeof value === 'number' ? 'n' : 's')};
    if(statusKey){
      cell.s = {
        fill:{ patternType:'solid', fgColor:{rgb: FILL[statusKey] || 'FFFFFF'} },
        font:{ bold:true, color:{rgb: FONT_COLOR[statusKey] || '000000'} },
        alignment:{ horizontal:'center' }
      };
    }
    return cell;
  }
  function headerRow(cols){
    return cols.map(function(h){ return {v:h, t:'s', s:{font:{bold:true, color:{rgb:'FFFFFF'}}, fill:{patternType:'solid', fgColor:{rgb:'333333'}}}}; });
  }
  function pontoDetailRow(f, l, q){
    var ps = pontoStatusKey(q);
    return [
      {v:'Faixa ' + f.numero, t:'s'},
      {v:String(l.camada), t:'s'},
      {v:'Lançamento ' + l.lancamento, t:'s'},
      {v:nomePonto(q), t:'s'},
      styledCell(LAB_FULL[q.A], q.A),
      {v:fmtDateTime(q.AEm) || '—', t:'s'},
      styledCell(LAB_FULL[q.D], q.D),
      {v:fmtDateTime(q.DEm) || '—', t:'s'},
      styledCell(pontoStatusText(q), ps)
    ];
  }

  function downloadExcel(){
    if(!isEditor){ showToast('Faça login para baixar o Excel.'); return; }
    if(typeof XLSX === 'undefined'){ showToast('Biblioteca de Excel não carregou.'); return; }
    commitHistorySnapshot();

    var resumoRows = [headerRow(['Faixa','Camada atual','Lançamento','Volume (m³)','Quadrantes','Compactação de Ombreira a Ombreira','Status da camada','Pendências de camadas anteriores','Observação'])];
    state.faixas.forEach(function(f){
      var l = currentLayer(f);
      var st = layerStatus(l);
      var pend = unresolvedBefore(f, l);
      var nPend = pend.OE.length + pend.NUCLEO.length + pend.OD.length;
      resumoRows.push([
        {v:'Faixa ' + f.numero, t:'s'},
        {v:String(l.camada), t:'s'},
        {v:'Lançamento ' + l.lancamento, t:'s'},
        {v:Number(l.volume) || 0, t:'n'},
        {v:l.quads.length, t:'n'},
        styledCell(l.oao === 'SIM' ? 'SIM' : 'NÃO', l.oao === 'SIM' ? 'sim' : 'nao'),
        styledCell(LAYER_LABEL[st], st),
        {v:nPend, t:'n'},
        {v:l.obs || '', t:'s'}
      ]);
    });
    var wsResumo = XLSX.utils.aoa_to_sheet(resumoRows);
    wsResumo['!cols'] = [{wch:10},{wch:13},{wch:14},{wch:13},{wch:12},{wch:20},{wch:16},{wch:18},{wch:36}];

    var detRows = [headerRow(['Faixa','Camada','Lançamento','Ponto','Aterpa','Horário Aterpa','Diefra','Horário Diefra','Status do ponto'])];
    state.faixas.forEach(function(f){
      f.layers.forEach(function(l){
        l.quads.forEach(function(q){ detRows.push(pontoDetailRow(f, l, q)); });
      });
    });
    var wsDet = XLSX.utils.aoa_to_sheet(detRows);
    wsDet['!cols'] = [{wch:10},{wch:10},{wch:14},{wch:14},{wch:14},{wch:17},{wch:14},{wch:17},{wch:22}];

    var histRows = [headerRow(['Data/Hora','Faixa','Camada','Lançamento','Ponto','Laboratório','Novo status'])];
    (state.historico || []).forEach(function(h){
      histRows.push([
        {v:fmtDateTime(h.ts), t:'s'},
        {v:'Faixa ' + h.faixa, t:'s'},
        {v:h.camada !== undefined && h.camada !== null ? String(h.camada) : '', t:'s'},
        {v:h.lancamento !== undefined && h.lancamento !== null ? ('Lançamento ' + h.lancamento) : '', t:'s'},
        {v:h.ponto || '', t:'s'},
        {v:h.laboratorio || '', t:'s'},
        {v:h.status || '', t:'s'}
      ]);
    });
    var wsHist = XLSX.utils.aoa_to_sheet(histRows);
    wsHist['!cols'] = [{wch:17},{wch:10},{wch:10},{wch:14},{wch:26},{wch:16},{wch:48}];

    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsResumo, 'Resumo');
    XLSX.utils.book_append_sheet(wb, wsDet, 'Detalhe por ponto');
    XLSX.utils.book_append_sheet(wb, wsHist, 'Histórico');
    XLSX.writeFile(wb, 'Liberacao-de-Camadas_' + todayKey() + '.xlsx');
    showToast('Excel baixado.');
  }

  /* ==================== imprimir / PDF ==================== */
  function printReport(){
    var ta = document.activeElement;
    if(ta && ta.tagName === 'TEXTAREA') ta.blur();
    setTimeout(function(){ window.print(); }, 50);
  }

  /* ==================== boot ==================== */
  function boot(){
    restoreSession();
    applyRoleUI();
    bindEvents();

    document.getElementById('saveSheetsBtn').addEventListener('click', salvarNaPlanilha);
    document.getElementById('excelBtn').addEventListener('click', downloadExcel);
    document.getElementById('printBtn').addEventListener('click', printReport);
    document.getElementById('addFaixaBtn').addEventListener('click', addFaixa);
    document.getElementById('scrollPendBtn').addEventListener('click', function(){
      document.getElementById('backlogPanel').scrollIntoView({behavior:'smooth', block:'start'});
    });
    document.getElementById('pendFilter').addEventListener('change', renderBacklog);
    document.getElementById('loginBtn').addEventListener('click', function(){
      if(isEditor) logout(); else showLoginOverlay();
    });
    document.getElementById('loginSubmitBtn').addEventListener('click', attemptLogin);
    document.getElementById('loginCancelBtn').addEventListener('click', hideLoginOverlay);
    document.getElementById('loginPassInput').addEventListener('keydown', function(e){
      if(e.key === 'Enter') attemptLogin();
    });
    document.getElementById('oaoCancelBtn').addEventListener('click', closeOaoModal);
    document.getElementById('oaoApplyBtn').addEventListener('click', applyOaoNao);
    document.getElementById('newLayerCancelBtn').addEventListener('click', closeNewLayerModal);
    document.getElementById('newLayerConfirmBtn').addEventListener('click', confirmNewLayer);
    document.getElementById('newLayerNum').addEventListener('keydown', function(e){
      if(e.key === 'Enter') confirmNewLayer();
    });

    fetchState().then(function(){
      if(!isEditor) startPolling();
    });
  }

  boot();
})();
