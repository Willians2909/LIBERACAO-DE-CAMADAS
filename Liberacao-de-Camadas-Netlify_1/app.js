(function(){
  "use strict";

  var API_BASE = window.LC_API_BASE || '/api';
  var POLL_MS = 5000;
  var SAVE_DEBOUNCE_MS = 700;
  var SAVE_RETRY_MS = 4000;
  // Intervalo de consolidação do histórico de ensaios (a cada 10 min, por padrão).
  // Ajustável via window.LC_SNAPSHOT_MS só para testes automatizados.
  var SNAPSHOT_INTERVAL_MS = window.LC_SNAPSHOT_MS || (10 * 60 * 1000);

  var STATUS_LABEL = { liberado:'Liberado', contraprova:'Contraprova', reprovado:'Reprovado', aguardando:'Aguardando', semdados:'Sem pontos' };
  var LAB_LETTER = {aterpa:'A', diefra:'D'};
  var LAB_FULL = {pendente:'Pendente', aprovado:'Aprovado', reprovado:'Reprovado', contraprova:'Contraprova'};
  var LAB_NAME = {aterpa:'Aterpa', diefra:'Diefra'};
  var LAB_ORDER = ['pendente','aprovado','reprovado','contraprova'];

  var DEFAULT_STATE = { meta:{ savedAt:null, updatedBy:null }, faixas:[], historico:[], lancamentosArquivados:[], histSnapshot:{} };

  var state = null;
  var isEditor = false;
  var editorName = null;
  var editorPassword = null;
  var pollTimer = null;
  var saveTimer = null;
  var snapshotTimer = null;

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

  function normalizeState(parsed){
    if(parsed && Array.isArray(parsed.faixas)){
      if(!Array.isArray(parsed.historico)) parsed.historico = [];
      if(!Array.isArray(parsed.lancamentosArquivados)) parsed.lancamentosArquivados = [];
      if(!parsed.histSnapshot || typeof parsed.histSnapshot !== 'object') parsed.histSnapshot = {};
      if(!parsed.meta || typeof parsed.meta !== 'object') parsed.meta = {};
      return parsed;
    }
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
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
      state = normalizeState(data);
      render();
      if(!isEditor) updateSyncBadge('ao vivo · atualizado ' + fmtTime(new Date().toISOString()), 'ok');
    }).catch(function(err){
      console.error('falha ao buscar estado', err);
      if(!isEditor) updateSyncBadge('sem conexão — tentando de novo', 'error');
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
    document.getElementById('loginOverlay').style.display = 'flex';
    var input = document.getElementById('loginPassInput');
    input.value = '';
    document.getElementById('loginError').classList.remove('show');
    input.focus();
  }
  function hideLoginOverlay(){
    document.getElementById('loginOverlay').style.display = 'none';
  }

  function attemptLogin(){
    var input = document.getElementById('loginPassInput');
    var pwd = input.value;
    var errEl = document.getElementById('loginError');
    errEl.classList.remove('show');
    if(!pwd) return;
    api('/login', { method:'POST', body:{ password: pwd } }).then(function(res){
      isEditor = true;
      editorName = res.name;
      editorPassword = pwd;
      try{ sessionStorage.setItem('lc_editor', JSON.stringify({ name:editorName, password:editorPassword })); }catch(e){}
      hideLoginOverlay();
      stopPolling();
      applyRoleUI();
      startSnapshotTimer();
      fetchState().then(function(){
        var saudacao = editorName === 'Aline' ? 'Bem-vinda' : 'Bem-vindo';
        showToast(saudacao + ' ' + editorName + '! Modo de edição ativado.');
      });
    }).catch(function(err){
      errEl.textContent = err.status === 401 ? 'Senha incorreta.' : 'Não foi possível entrar agora. Tente de novo em instantes.';
      errEl.classList.add('show');
      input.select();
    });
  }

  function logout(){
    if(isEditor){
      // consolida qualquer mudança de ensaio pendente (dentro da janela de 10 min)
      // antes de sair, para não perder registro por causa do fim da sessão.
      commitHistorySnapshot();
      clearTimeout(saveTimer);
      pushState();
    }
    stopSnapshotTimer();
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
    updateLoginButton();
  }
  function updateLoginButton(){
    var btn = document.getElementById('loginBtn');
    if(!btn) return;
    btn.textContent = isEditor ? ('👋 Sair (' + editorName + ')') : '🔒 Login';
  }

  /* ==================== regras de negócio (faixas / ensaios) ==================== */
  function ensaiosNecessarios(f){ return pontosOf(f).length; }
  function ensaiosFromVolume(vol){ var v = Number(vol)||0; return v > 0 ? Math.ceil(v/500) : 0; }

  // Rótulos padrão ao abrir/gerar os pontos de uma faixa: OE.<faixa>, os pontos do
  // meio numerados em sequência (1, 2, 3...), e OD.<faixa> no final. Continuam
  // 100% editáveis depois de criados.
  function defaultPontosForCount(n, faixaNum){
    n = Math.max(0, n|0);
    if(n === 0) return [];
    var pontos = [];
    if(n === 1){ pontos.push({label:'OE.'+faixaNum}); }
    else{
      var middleCount = n - 2;
      pontos.push({label:'OE.'+faixaNum});
      for(var i=0; i<middleCount; i++){
        pontos.push({label: String(i+1)});
      }
      pontos.push({label:'OD.'+faixaNum});
    }
    return pontos.map(function(p){ return {label:p.label, aterpa:'pendente', diefra:'pendente', aterpaEm:null, diefraEm:null}; });
  }

  function syncPontosToVolume(f){
    var target = ensaiosFromVolume(f.volumeM3);
    var pontos = pontosOf(f);
    if(pontos.length === 0 && target > 0){
      f.pontos = defaultPontosForCount(target, f.numero);
      return;
    }
    if(pontos.length < target){
      for(var i = pontos.length; i < target; i++){
        pontos.push({label:'P'+(i+1), aterpa:'pendente', diefra:'pendente', aterpaEm:null, diefraEm:null});
      }
    } else if(pontos.length > target){
      while(pontos.length > target){
        var last = pontos[pontos.length-1];
        var intocado = last.aterpa === 'pendente' && last.diefra === 'pendente' && !last.aterpaEm && !last.diefraEm;
        if(!intocado) break;
        pontos.pop();
      }
    }
    f.pontos = pontos;
  }

  function pontosOf(f){ return Array.isArray(f.pontos) ? f.pontos : []; }

  // Número da camada é editável à parte do número da faixa e do contador de
  // lançamento; se ainda não foi definido, mostra o número da faixa como ponto
  // de partida (mas sem "travar" os dois — dá pra editar de forma independente).
  function camadaValue(f){
    return (f.camada !== undefined && f.camada !== null && String(f.camada).trim() !== '') ? f.camada : f.numero;
  }

  function pontoStatus(p){
    if(!p) return 'pendente';
    if(p.aterpa === 'reprovado' || p.diefra === 'reprovado') return 'reprovado';
    if(p.aterpa === 'contraprova' || p.diefra === 'contraprova') return 'contraprova';
    if(p.aterpa === 'aprovado' && p.diefra === 'aprovado') return 'aprovado';
    return 'pendente';
  }

  // Status 100% automático a partir do mapa de ensaios — a escolha manual de
  // Compactação de Ombreira a Ombreira NÃO libera a faixa por si só.
  function faixaStatus(f){
    var pontos = pontosOf(f);
    if(!pontos.length) return 'semdados';
    var statuses = pontos.map(pontoStatus);
    if(statuses.indexOf('reprovado') >= 0) return 'reprovado';
    if(statuses.indexOf('contraprova') >= 0) return 'contraprova';
    if(statuses.every(function(s){ return s === 'aprovado'; })) return 'liberado';
    return 'aguardando';
  }

  function logHistorico(faixa, pontoLabel, lab, novoStatus){
    if(!Array.isArray(state.historico)) state.historico = [];
    state.historico.push({
      ts: new Date().toISOString(),
      faixa: faixa.numero,
      ponto: pontoLabel || '',
      laboratorio: LAB_NAME[lab] || lab,
      status: LAB_FULL[novoStatus] || novoStatus
    });
  }

  function logHistoricoOao(faixa, novoValor){
    if(!Array.isArray(state.historico)) state.historico = [];
    state.historico.push({
      ts: new Date().toISOString(),
      faixa: faixa.numero,
      ponto: 'Compactação de Ombreira a Ombreira',
      laboratorio: editorName || 'Sala de controle',
      status: novoValor ? 'SIM' : 'NÃO'
    });
  }

  function logHistoricoLancamento(f, de, para, voltou){
    if(!Array.isArray(state.historico)) state.historico = [];
    state.historico.push({
      ts: new Date().toISOString(),
      faixa: f.numero,
      ponto: voltou ? 'Voltar Lançamento' : 'Novo Lançamento',
      laboratorio: editorName || 'Sala de controle',
      status: voltou
        ? ('Voltou do Lançamento ' + de + ' para o Lançamento ' + para + ' (mapa anterior restaurado)')
        : ('Lançamento ' + de + ' arquivado — iniciado Lançamento ' + para)
    });
  }

  // ===== histórico de ensaios: consolidado a cada SNAPSHOT_INTERVAL_MS =====
  // Em vez de gravar uma linha no histórico a cada clique (o que lotaria o
  // registro com correções de cliques errados da Aline/João), guardamos o
  // resultado "ao vivo" normalmente, e só a cada 10 minutos comparamos com a
  // última fotografia salva (state.histSnapshot) e gravamos no histórico só o
  // que realmente mudou desde então — incluindo reprovações, mesmo que depois
  // sejam corrigidas (a reprovação já fica registrada na janela em que ocorreu).
  function pontoHistKey(faixaId, label){ return faixaId + '::' + (label || ''); }

  function commitHistorySnapshot(){
    if(!state || !isEditor) return;
    if(!state.histSnapshot || typeof state.histSnapshot !== 'object') state.histSnapshot = {};
    state.faixas.forEach(function(f){
      pontosOf(f).forEach(function(p){
        var key = pontoHistKey(f.id, p.label);
        var curA = LAB_ORDER.indexOf(p.aterpa) >= 0 ? p.aterpa : 'pendente';
        var curD = LAB_ORDER.indexOf(p.diefra) >= 0 ? p.diefra : 'pendente';
        var last = state.histSnapshot[key];
        if(!last){
          // primeira vez que vemos este ponto: só grava a base, sem lançar registro
          state.histSnapshot[key] = {aterpa:curA, diefra:curD};
          return;
        }
        if(curA !== last.aterpa) logHistorico(f, p.label, 'aterpa', curA);
        if(curD !== last.diefra) logHistorico(f, p.label, 'diefra', curD);
        state.histSnapshot[key] = {aterpa:curA, diefra:curD};
      });
    });
    scheduleSave();
  }

  function startSnapshotTimer(){
    stopSnapshotTimer();
    snapshotTimer = setInterval(commitHistorySnapshot, SNAPSHOT_INTERVAL_MS);
  }
  function stopSnapshotTimer(){
    if(snapshotTimer){ clearInterval(snapshotTimer); snapshotTimer = null; }
  }

  function escapeHtml(s){
    return String(s==null?'':s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

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
  function relTime(iso){
    if(!iso) return 'sem registro';
    var d = new Date(iso);
    if(isNaN(d)) return 'sem registro';
    var mins = Math.round((Date.now() - d.getTime())/60000);
    if(mins < 1) return 'agora mesmo';
    if(mins < 60) return 'há ' + mins + ' min';
    var hrs = Math.round(mins/60);
    if(hrs < 24) return 'há ' + hrs + 'h';
    var days = Math.round(hrs/24);
    if(days === 1) return 'ontem';
    if(days < 30) return 'há ' + days + ' dias';
    return d.toLocaleDateString('pt-BR');
  }

  function touch(f){ f.atualizadoEm = new Date().toISOString(); scheduleSave(); }

  function showToast(msg){
    var t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function(){ t.classList.remove('show'); }, 2600);
  }

  /* ==================== render ==================== */
  function render(){
    var root = document.getElementById('tableRoot');
    // Ordem sempre igual à do array state.faixas — não é reordenada automaticamente
    // pelo número da faixa (dá pra posicionar manualmente com os botões ▲▼).
    var faixas = state.faixas;

    var liberadas = faixas.filter(function(f){ return faixaStatus(f) === 'liberado'; }).length;
    document.getElementById('summaryChip').innerHTML = '<b>' + liberadas + '</b> de ' + faixas.length + ' faixas liberadas';

    if(!faixas.length){
      root.innerHTML = '<div class="empty-state">Nenhuma faixa cadastrada ainda.</div>' + addRowHtml();
    } else {
      root.innerHTML = faixas.map(function(f, idx){ return faixaCardHtml(f, idx, faixas.length); }).join('') + addRowHtml();
    }
    bindEvents();
    applyEditModeToControls();
  }

  function addRowHtml(){
    return '<button class="add-row editor-only" data-action="add-faixa" type="button"><span style="font-size:17px;line-height:1">+</span> Nova faixa</button>';
  }

  function faixaCardHtml(f, idx, total){
    var st = faixaStatus(f);
    var pontos = pontosOf(f);
    var oao = !!f.compOmbreiraOmbreira;
    var isFirst = idx === 0;
    var isLast = idx === (total - 1);
    var temArquivo = (state.lancamentosArquivados||[]).some(function(l){ return l.faixaId === f.id; });

    var out = '<div class="faixa-card status-' + st + '" data-id="' + escapeHtml(f.id) + '">';
    out += '<div class="faixa-row">';
    out += '<div class="meta-block">';
    out += '<div class="cell-faixa"><input class="faixa-num-input" type="text" inputmode="numeric" data-f="numero" value="' + escapeHtml(f.numero) + '">' +
      '<span class="status-pill status-' + st + '">' + STATUS_LABEL[st] + '</span>' +
      '<span class="camada-lanc-row">' +
        '<span class="camada-wrap">Camada <input class="camada-input" type="text" data-f="camada" value="' + escapeHtml(camadaValue(f)) + '"></span>' +
        '<span class="lancamento-badge">Lançamento ' + (f.lancamento||1) + '</span>' +
      '</span></div>';
    out += '<div class="cell-volume"><input class="cell-input" type="number" min="0" step="1" data-f="volumeM3" value="' + (f.volumeM3||'') + '"></div>';
    out += '<div class="cell-ensaios"><span class="computed-box" data-computed="ensaios">' + ensaiosNecessarios(f) + '</span></div>';
    out += '<div class="cell-oao">' +
      '<div class="oao-toggle" data-computed="oaoToggle">' +
        '<button type="button" class="oao-btn sim' + (oao?' active':'') + '" data-action="oao-sim">SIM</button>' +
        '<button type="button" class="oao-btn nao' + (!oao?' active':'') + '" data-action="oao-nao">NÃO</button>' +
      '</div>' +
      '</div>';
    out += '</div>';
    out += '<div class="mapa-block" data-mapa="1">';
    out += pontos.map(function(p, idx2){ return pontoChipHtml(p, idx2); }).join('');
    out += '<button type="button" class="add-ponto-chip editor-only" data-action="add-ponto">+ ensaio</button>';
    out += '</div>';
    out += '<div class="row-actions editor-only">' +
      '<button type="button" class="novo-lancamento-btn" data-action="novo-lancamento" title="Novo Lançamento — arquiva este lançamento e recomeça o mapa">🔁</button>' +
      '<button type="button" class="voltar-lancamento-btn" data-action="voltar-lancamento" title="Voltar ao lançamento anterior — desfaz o último Novo Lançamento"' + (temArquivo ? '' : ' disabled') + '>↩️</button>' +
      '<button type="button" data-action="move-up" title="Mover faixa para cima"' + (isFirst ? ' disabled' : '') + '>▲</button>' +
      '<button type="button" data-action="move-down" title="Mover faixa para baixo"' + (isLast ? ' disabled' : '') + '>▼</button>' +
      '<button type="button" class="remove-faixa-btn" data-action="remove-faixa" title="Remover faixa">×</button>' +
      '</div>';
    out += '</div>';
    out += lancamentosAnterioresHtml(f);
    out += '<div class="obs-row"><div class="obs-row-label">Observação (opcional)</div><textarea data-f="observacao">' + escapeHtml(f.observacao||'') + '</textarea></div>';
    out += '<div class="row-footer"><span>' + relTime(f.atualizadoEm) + '</span></div>';
    out += '</div>';
    return out;
  }

  // Lista, de forma só-leitura e visível para todos (não é editor-only), os
  // lançamentos já arquivados desta faixa — assim quem só acompanha também
  // consegue ver como ficou o fechamento de um lançamento anterior.
  function historyPontoChipHtml(p){
    var a = LAB_ORDER.indexOf(p.aterpa) >= 0 ? p.aterpa : 'pendente';
    var d = LAB_ORDER.indexOf(p.diefra) >= 0 ? p.diefra : 'pendente';
    var titleA = 'Aterpa: ' + LAB_FULL[a] + (p.aterpaEm ? ' em ' + fmtDateTime(p.aterpaEm) : '');
    var titleD = 'Diefra: ' + LAB_FULL[d] + (p.diefraEm ? ' em ' + fmtDateTime(p.diefraEm) : '');
    return '<span class="hist-chip"><b>' + escapeHtml(p.label||'') + '</b>' +
      '<span class="hist-l st-' + a + '" title="' + escapeHtml(titleA) + '">A</span>' +
      '<span class="hist-l st-' + d + '" title="' + escapeHtml(titleD) + '">D</span></span>';
  }

  function lancamentosAnterioresHtml(f){
    var arquivados = (state.lancamentosArquivados||[]).filter(function(l){ return l.faixaId === f.id; });
    if(!arquivados.length) return '';
    var itens = arquivados.slice().reverse().map(function(l){
      var camadaTxt = (l.camada !== undefined && l.camada !== null && String(l.camada).trim() !== '') ? (' · Camada ' + escapeHtml(l.camada)) : '';
      return '<div class="lanc-hist-item">' +
        '<div class="lanc-hist-head">Lançamento ' + l.lancamento + camadaTxt +
        '<span class="lanc-hist-meta">arquivado em ' + fmtDateTime(l.arquivadoEm) + ' · Compact. Ombr-Ombr: ' + (l.compOmbreiraOmbreira ? 'SIM' : 'NÃO') + '</span></div>' +
        '<div class="lanc-hist-map">' + l.pontos.map(historyPontoChipHtml).join('') + '</div>' +
        '</div>';
    }).join('');
    return '<details class="lanc-history"><summary>Ver lançamentos anteriores (' + arquivados.length + ')</summary>' + itens + '</details>';
  }

  function pontoChipHtml(p, idx){
    return '<div class="ponto-chip" data-idx="' + idx + '">' +
      '<input class="ponto-label" type="text" data-ponto-label="1" data-idx="' + idx + '" value="' + escapeHtml(p.label||'') + '">' +
      letterSelectHtml(p.aterpa, 'aterpa', idx, p) +
      letterSelectHtml(p.diefra, 'diefra', idx, p) +
      '<button type="button" class="chip-remove editor-only" data-action="remove-ponto" data-idx="' + idx + '" title="Remover ensaio">×</button>' +
      '</div>';
  }

  function letterSelectHtml(value, lab, idx, p){
    var v = LAB_ORDER.indexOf(value) >= 0 ? value : 'pendente';
    var em = p ? p[lab + 'Em'] : null;
    var titleTxt = LAB_NAME[lab] + ': ' + LAB_FULL[v] + (em ? ' em ' + fmtDateTime(em) : '') + ' (toque para escolher)';
    var opts = LAB_ORDER.map(function(s){
      return '<option value="' + s + '"' + (s === v ? ' selected' : '') + '>' + LAB_FULL[s] + '</option>';
    }).join('');
    return '<span class="letter-wrap" title="' + escapeHtml(titleTxt) + '">' +
      '<span class="letter-badge st-' + v + '" data-lab="' + lab + '">' + LAB_LETTER[lab] + '</span>' +
      '<select class="letter-select" data-lab="' + lab + '" data-idx="' + idx + '" title="' + escapeHtml(titleTxt) + '">' + opts + '</select>' +
      '</span>';
  }

  function findFaixa(id){ return state.faixas.find(function(f){ return f.id === id; }); }

  function refreshRowVisuals(cardEl, f){
    var st = faixaStatus(f);
    cardEl.className = 'faixa-card status-' + st;
    var pill = cardEl.querySelector('.status-pill');
    if(pill){ pill.className = 'status-pill status-' + st; pill.textContent = STATUS_LABEL[st]; }
    var ensaiosEl = cardEl.querySelector('[data-computed="ensaios"]');
    if(ensaiosEl) ensaiosEl.textContent = ensaiosNecessarios(f);
  }

  function renderMapa(cardEl, f){
    var mapa = cardEl.querySelector('[data-mapa]');
    var pontos = pontosOf(f);
    mapa.innerHTML = pontos.map(function(p, idx){ return pontoChipHtml(p, idx); }).join('') +
      '<button type="button" class="add-ponto-chip editor-only" data-action="add-ponto">+ ensaio</button>';
    applyEditModeToControls();
  }

  // Aplica de verdade (não só via CSS) o modo somente-leitura: quem não fez login
  // não consegue interagir com nada do mapa, mesmo pelo teclado — isso é o que
  // garante o "só uma pessoa edita", não apenas esconder botões.
  function applyEditModeToControls(){
    var ro = !isEditor;
    var root = document.getElementById('tableRoot');
    if(!root) return;
    root.querySelectorAll('input, textarea').forEach(function(el){ el.readOnly = ro; });
    root.querySelectorAll('select').forEach(function(el){ el.disabled = ro; });
    root.querySelectorAll('.oao-btn').forEach(function(el){ el.disabled = ro; });
  }

  /* ==================== eventos ==================== */
  function bindEvents(){
    var root = document.getElementById('tableRoot');

    root.oninput = function(e){
      if(!isEditor) return;
      var card = e.target.closest('[data-id]');
      if(!card) return;
      var f = findFaixa(card.getAttribute('data-id'));
      if(!f) return;
      var el = e.target;
      if(el.matches('[data-f="numero"]')){ f.numero = el.value; touch(f); return; }
      if(el.matches('[data-f="camada"]')){ f.camada = el.value; touch(f); return; }
      if(el.matches('[data-f="volumeM3"]')){ f.volumeM3 = el.value === '' ? 0 : Number(el.value); touch(f); refreshRowVisuals(card, f); return; }
      if(el.matches('[data-f="observacao"]')){ f.observacao = el.value; touch(f); return; }
      if(el.matches('[data-ponto-label]')){
        var idx = Number(el.getAttribute('data-idx'));
        var p = pontosOf(f)[idx];
        if(p){ p.label = el.value; touch(f); }
        return;
      }
    };

    root.onchange = function(e){
      if(!isEditor) return;
      var card = e.target.closest('[data-id]');
      if(!card) return;
      var f = findFaixa(card.getAttribute('data-id'));
      if(!f) return;
      if(e.target.matches('[data-f="volumeM3"]')){
        syncPontosToVolume(f);
        touch(f);
        renderMapa(card, f);
        refreshRowVisuals(card, f);
        return;
      }
      if(e.target.matches('.letter-select')){
        var idx2 = Number(e.target.getAttribute('data-idx'));
        var lab2 = e.target.getAttribute('data-lab');
        var p2 = pontosOf(f)[idx2];
        if(!p2) return;
        var novo = LAB_ORDER.indexOf(e.target.value) >= 0 ? e.target.value : 'pendente';
        var atual = LAB_ORDER.indexOf(p2[lab2]) >= 0 ? p2[lab2] : 'pendente';
        if(novo === atual) return; // mesma escolha: não gera registro no histórico
        var nowIso = new Date().toISOString();
        p2[lab2] = novo;
        p2[lab2 + 'Em'] = novo === 'pendente' ? null : nowIso;
        // O resultado "ao vivo" muda na hora (todo mundo já vê isso na tela);
        // o registro no histórico de ensaios (para o Excel) é consolidado a
        // cada 10 min por commitHistorySnapshot(), pra não lotar o histórico
        // com cliques errados que são corrigidos na sequência.
        var wrap = e.target.closest('.letter-wrap');
        var badge = wrap.querySelector('.letter-badge');
        var novoTitle = LAB_NAME[lab2] + ': ' + LAB_FULL[novo] + (p2[lab2+'Em'] ? ' em ' + fmtDateTime(p2[lab2+'Em']) : '') + ' (toque para escolher)';
        badge.className = 'letter-badge st-' + novo;
        wrap.title = novoTitle;
        e.target.title = novoTitle;
        touch(f);
        refreshRowVisuals(card, f);
      }
    };

    root.onclick = function(e){
      if(!isEditor){
        // mesmo sem editor, o clique de fato não faz nada (defesa em profundidade —
        // além dos controles já virem desabilitados/somente-leitura)
        return;
      }
      var addFaixaBtn = e.target.closest('[data-action="add-faixa"]');
      if(addFaixaBtn){ addFaixa(); return; }

      var card = e.target.closest('[data-id]');
      if(!card) return;
      var f = findFaixa(card.getAttribute('data-id'));
      if(!f) return;

      var actionEl = e.target.closest('[data-action]');
      if(!actionEl) return;
      var action = actionEl.getAttribute('data-action');

      if(action === 'oao-sim' || action === 'oao-nao'){
        var novoOao = (action === 'oao-sim');
        if(novoOao !== !!f.compOmbreiraOmbreira){
          f.compOmbreiraOmbreira = novoOao;
          logHistoricoOao(f, novoOao);
          touch(f);
          var toggle = card.querySelector('[data-computed="oaoToggle"]');
          toggle.querySelector('.sim').classList.toggle('active', f.compOmbreiraOmbreira);
          toggle.querySelector('.nao').classList.toggle('active', !f.compOmbreiraOmbreira);
          refreshRowVisuals(card, f);
        }
      } else if(action === 'add-ponto'){
        var pontos = pontosOf(f);
        pontos.push({label:'P' + (pontos.length+1), aterpa:'pendente', diefra:'pendente', aterpaEm:null, diefraEm:null});
        f.pontos = pontos;
        touch(f);
        renderMapa(card, f);
        refreshRowVisuals(card, f);
      } else if(action === 'remove-ponto'){
        var ridx = Number(actionEl.getAttribute('data-idx'));
        f.pontos = pontosOf(f).filter(function(_, i){ return i !== ridx; });
        touch(f);
        renderMapa(card, f);
        refreshRowVisuals(card, f);
      } else if(action === 'remove-faixa'){
        if(confirm('Remover a Faixa ' + f.numero + '? Essa ação não pode ser desfeita.')){
          state.faixas = state.faixas.filter(function(x){ return x.id !== f.id; });
          scheduleSave();
          render();
        }
      } else if(action === 'move-up'){
        moveFaixa(f.id, -1);
      } else if(action === 'move-down'){
        moveFaixa(f.id, 1);
      } else if(action === 'novo-lancamento'){
        novoLancamento(f);
      } else if(action === 'voltar-lancamento'){
        voltarLancamentoAnterior(f);
      }
    };
  }

  function moveFaixa(id, dir){
    var idx = state.faixas.findIndex(function(f){ return f.id === id; });
    if(idx < 0) return;
    var swapIdx = idx + dir;
    if(swapIdx < 0 || swapIdx >= state.faixas.length) return;
    var tmp = state.faixas[idx];
    state.faixas[idx] = state.faixas[swapIdx];
    state.faixas[swapIdx] = tmp;
    scheduleSave();
    render();
  }

  function nextFaixaId(){
    var n = 1;
    while(state.faixas.some(function(f){ return f.id === 'f' + n; })) n++;
    return 'f' + n;
  }

  function addFaixa(){
    var used = state.faixas.map(function(f){ return Number(f.numero)||0; });
    var suggestion = used.length ? Math.max.apply(null, used) + 1 : 1;
    var num = prompt('Número da nova faixa:', String(suggestion));
    if(num === null) return;
    num = num.trim();
    if(!num) return;
    var id = nextFaixaId();
    state.faixas.push({
      id:id, numero:num, camada:num, volumeM3:0, compOmbreiraOmbreira:false, lancamento:1,
      pontos: defaultPontosForCount(5, num),
      observacao:'', atualizadoEm:new Date().toISOString()
    });
    scheduleSave();
    render();
  }

  // "Novo Lançamento": a camada atual já foi compactada e ensaiada; arquiva o
  // mapa e os horários desse lançamento (fica preservado no Excel/histórico) e
  // recomeça o mapa em branco para o próximo lançamento na mesma faixa, no
  // mesmo dia. A Compactação de Ombreira a Ombreira volta para NÃO, porque é
  // uma camada nova, com sua própria compactação a ser conferida.
  function novoLancamento(f){
    var atual = f.lancamento || 1;
    var jaLiberado = faixaStatus(f) === 'liberado';
    var aviso = jaLiberado ? '' : '\n\nAtenção: nem todos os ensaios deste lançamento estão aprovados ainda.';
    var msg = 'Iniciar um novo lançamento na Faixa ' + f.numero + '?\n\n' +
      'O mapa de ensaios do Lançamento ' + atual + ' fica arquivado (com os horários de cada aprovação) e um mapa novo começa para o Lançamento ' + (atual+1) + '.' + aviso;
    if(!confirm(msg)) return;

    // consolida o histórico de ensaios deste lançamento antes de arquivar,
    // pra não perder nenhuma mudança pendente na janela de 10 minutos.
    commitHistorySnapshot();

    if(!Array.isArray(state.lancamentosArquivados)) state.lancamentosArquivados = [];
    state.lancamentosArquivados.push({
      faixaId: f.id,
      faixaNumero: f.numero,
      camada: camadaValue(f),
      lancamento: atual,
      volumeM3: f.volumeM3,
      compOmbreiraOmbreira: !!f.compOmbreiraOmbreira,
      pontos: JSON.parse(JSON.stringify(pontosOf(f))),
      arquivadoEm: new Date().toISOString()
    });
    logHistoricoLancamento(f, atual, atual + 1);

    var count = pontosOf(f).length || ensaiosFromVolume(f.volumeM3) || 5;
    f.lancamento = atual + 1;
    f.pontos = defaultPontosForCount(count, f.numero);
    f.compOmbreiraOmbreira = false;
    touch(f);
    render();
    showToast('Lançamento ' + (atual+1) + ' iniciado na Faixa ' + f.numero + '.');
  }

  // "Voltar Lançamento Anterior": desfaz o último Novo Lançamento desta faixa,
  // restaurando o mapa de ensaios (e a camada/compactação de ombreira) do
  // lançamento arquivado mais recente, para conferir ou corrigir o fechamento
  // anterior. O lançamento arquivado sai da lista (volta a ser o mapa "ao vivo").
  function voltarLancamentoAnterior(f){
    var arquivados = state.lancamentosArquivados || [];
    var idx = -1;
    for(var i = arquivados.length - 1; i >= 0; i--){
      if(arquivados[i].faixaId === f.id){ idx = i; break; }
    }
    if(idx < 0){ showToast('Não há lançamento anterior arquivado nesta faixa.'); return; }
    var arq = arquivados[idx];
    var atual = f.lancamento || 1;
    var msg = 'Voltar a Faixa ' + f.numero + ' para o Lançamento ' + arq.lancamento + '?\n\n' +
      'O mapa atual do Lançamento ' + atual + ' será substituído pelo mapa arquivado do Lançamento ' + arq.lancamento + ', para você conferir ou corrigir o fechamento anterior.';
    if(!confirm(msg)) return;

    commitHistorySnapshot();
    logHistoricoLancamento(f, atual, arq.lancamento, true);

    f.lancamento = arq.lancamento;
    f.pontos = JSON.parse(JSON.stringify(arq.pontos));
    f.compOmbreiraOmbreira = !!arq.compOmbreiraOmbreira;
    if(arq.volumeM3 !== undefined && arq.volumeM3 !== null) f.volumeM3 = arq.volumeM3;
    if(arq.camada !== undefined && arq.camada !== null) f.camada = arq.camada;
    arquivados.splice(idx, 1);

    touch(f);
    render();
    showToast('Faixa ' + f.numero + ' voltou para o Lançamento ' + arq.lancamento + '.');
  }

  /* ==================== baixar Excel ==================== */
  var FILL = { aprovado:'C6EFCE', reprovado:'F8CBAD', contraprova:'FFEB9C', pendente:'E7E6E6',
    liberado:'C6EFCE', aguardando:'E7E6E6', semdados:'E7E6E6', sim:'C6EFCE', nao:'E7E6E6' };
  var FONT_COLOR = { aprovado:'0EA968', reprovado:'D42A55', contraprova:'E08A00', pendente:'555555',
    liberado:'0EA968', aguardando:'555555', semdados:'555555', sim:'0EA968', nao:'555555' };

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

  function pontoDetailRow(faixaNumero, camada, lancamentoLabel, p){
    var ps = pontoStatus(p);
    return [
      {v:'Faixa '+faixaNumero, t:'s'},
      {v: camada !== undefined && camada !== null ? String(camada) : '', t:'s'},
      {v:lancamentoLabel, t:'s'},
      {v:p.label||'', t:'s'},
      styledCell(LAB_FULL[p.aterpa]||'Pendente', p.aterpa||'pendente'),
      {v:fmtDateTime(p.aterpaEm) || '—', t:'s'},
      styledCell(LAB_FULL[p.diefra]||'Pendente', p.diefra||'pendente'),
      {v:fmtDateTime(p.diefraEm) || '—', t:'s'},
      styledCell(STATUS_LABEL[ps] || ps, ps)
    ];
  }

  function downloadExcel(){
    if(!isEditor){ showToast('Faça login para baixar o Excel.'); return; }
    if(typeof XLSX === 'undefined'){ showToast('Biblioteca de Excel não carregou.'); return; }
    // consolida qualquer mudança de ensaio pendente antes de gerar a planilha,
    // pra o download sempre sair com o histórico mais atualizado possível.
    commitHistorySnapshot();
    var faixas = state.faixas;

    var resumoRows = [headerRow(['Faixa','Camada','Lançamento atual','Volume (m³)','Ensaios (pontos no mapa)','Compactação de Ombreira a Ombreira','Status da faixa','Observação'])];
    faixas.forEach(function(f){
      var st = faixaStatus(f);
      var oao = !!f.compOmbreiraOmbreira;
      resumoRows.push([
        {v:'Faixa '+f.numero, t:'s'},
        {v:String(camadaValue(f)), t:'s'},
        {v:'Lançamento ' + (f.lancamento||1), t:'s'},
        {v:Number(f.volumeM3)||0, t:'n'},
        {v:ensaiosNecessarios(f), t:'n'},
        styledCell(oao ? 'SIM' : 'NÃO', oao ? 'sim' : 'nao'),
        styledCell(STATUS_LABEL[st], st),
        {v:f.observacao||'', t:'s'}
      ]);
    });
    var wsResumo = XLSX.utils.aoa_to_sheet(resumoRows);
    wsResumo['!cols'] = [{wch:10},{wch:10},{wch:16},{wch:13},{wch:16},{wch:20},{wch:16},{wch:36}];

    var detRows = [headerRow(['Faixa','Camada','Lançamento','Ponto','Aterpa','Horário Aterpa','Diefra','Horário Diefra','Status do ponto'])];
    faixas.forEach(function(f){
      (state.lancamentosArquivados||[]).filter(function(l){ return l.faixaId === f.id; }).forEach(function(l){
        l.pontos.forEach(function(p){ detRows.push(pontoDetailRow(f.numero, l.camada !== undefined && l.camada !== null ? l.camada : f.numero, 'Lançamento ' + l.lancamento, p)); });
      });
      pontosOf(f).forEach(function(p){ detRows.push(pontoDetailRow(f.numero, camadaValue(f), 'Lançamento ' + (f.lancamento||1), p)); });
    });
    var wsDet = XLSX.utils.aoa_to_sheet(detRows);
    wsDet['!cols'] = [{wch:10},{wch:10},{wch:14},{wch:12},{wch:14},{wch:17},{wch:14},{wch:17},{wch:18}];

    // Histórico acumulado — cada aprovação/reprovação/contraprova, cada escolha de
    // Compactação de Ombreira a Ombreira e cada Novo Lançamento fica registrado
    // aqui, com data e hora, e vai se acumulando enquanto o sistema for usado.
    var histRows = [headerRow(['Data/Hora','Faixa','Ponto','Laboratório','Novo status'])];
    (state.historico||[]).forEach(function(h){
      histRows.push([
        {v:fmtDateTime(h.ts), t:'s'},
        {v:'Faixa '+h.faixa, t:'s'},
        {v:h.ponto||'', t:'s'},
        {v:h.laboratorio||'', t:'s'},
        {v:h.status||'', t:'s'}
      ]);
    });
    var wsHist = XLSX.utils.aoa_to_sheet(histRows);
    wsHist['!cols'] = [{wch:17},{wch:10},{wch:26},{wch:16},{wch:40}];

    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsResumo, 'Resumo');
    XLSX.utils.book_append_sheet(wb, wsDet, 'Detalhe por ponto');
    XLSX.utils.book_append_sheet(wb, wsHist, 'Histórico');
    XLSX.writeFile(wb, 'Liberacao-de-Camadas_' + todayStr() + '.xlsx');
    showToast('Excel baixado.');
  }

  function pad2(n){ return n < 10 ? '0'+n : ''+n; }
  function todayStr(){
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth()+1) + '-' + pad2(d.getDate());
  }

  /* ==================== imprimir / PDF (1 folha A4 retrato) ==================== */
  function pontoPrintChip(p){
    var a = LAB_ORDER.indexOf(p.aterpa) >= 0 ? p.aterpa : 'pendente';
    var d = LAB_ORDER.indexOf(p.diefra) >= 0 ? p.diefra : 'pendente';
    return '<span class="pp-chip"><b>' + escapeHtml(p.label||'') + '</b>' +
      '<span class="pp-l st-' + a + '">A</span><span class="pp-l st-' + d + '">D</span></span>';
  }

  function buildPrintTable(){
    var faixas = state.faixas;
    var html = '<table class="print-table"><thead><tr>' +
      '<th>Faixa</th><th>Camada</th><th>Lanç.</th><th>Volume (m³)</th><th>Ensaios</th><th>Compact. Ombr-Ombr</th><th>Status</th><th>Mapa de ensaios (A=Aterpa, D=Diefra)</th>' +
      '</tr></thead><tbody>';
    faixas.forEach(function(f){
      var st = faixaStatus(f);
      var oao = !!f.compOmbreiraOmbreira;
      html += '<tr class="pt-status-' + st + '">' +
        '<td class="pt-num">' + escapeHtml(f.numero) + '</td>' +
        '<td>' + escapeHtml(camadaValue(f)) + '</td>' +
        '<td>' + (f.lancamento||1) + '</td>' +
        '<td>' + (f.volumeM3 ? Number(f.volumeM3).toLocaleString('pt-BR') : '—') + '</td>' +
        '<td>' + ensaiosNecessarios(f) + '</td>' +
        '<td>' + (oao ? 'SIM' : 'NÃO') + '</td>' +
        '<td><span class="pt-pill status-' + st + '">' + STATUS_LABEL[st] + '</span></td>' +
        '<td>' + pontosOf(f).map(pontoPrintChip).join(' ') + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('printTable').innerHTML = html;
  }

  function printPage(){
    var now = new Date();
    document.getElementById('printHeader').textContent =
      'Liberação de Camadas — Maravilhas III — gerado em ' + fmtDateTime(now.toISOString());
    buildPrintTable();
    window.print();
  }

  /* ==================== boot ==================== */
  function boot(){
    restoreSession();
    applyRoleUI();
    if(isEditor) startSnapshotTimer();

    document.getElementById('excelBtn').addEventListener('click', downloadExcel);
    document.getElementById('printBtn').addEventListener('click', printPage);
    document.getElementById('loginBtn').addEventListener('click', function(){
      if(isEditor) logout(); else showLoginOverlay();
    });
    document.getElementById('loginSubmitBtn').addEventListener('click', attemptLogin);
    document.getElementById('loginCancelBtn').addEventListener('click', hideLoginOverlay);
    document.getElementById('loginPassInput').addEventListener('keydown', function(e){
      if(e.key === 'Enter') attemptLogin();
    });

    fetchState().then(function(){
      if(!isEditor) startPolling();
    });
  }

  boot();
})();
