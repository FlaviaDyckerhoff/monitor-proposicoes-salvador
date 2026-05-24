const fs = require('fs');

const CASA = 'CMSALVADOR';
const URL = 'https://cmsalvador.sys.inf.br/cl/prop_interna/';
const ARQUIVO_ESTADO = 'estado.json';
const MAX_PAGES = Number(process.env.MAX_PAGES || 8);

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  return { proposicoes_vistas: [], ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

function limparHtml(texto) {
  return String(texto || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(texto) {
  return String(texto ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function campo(html, nome, indice) {
  const re = new RegExp(`id=["']id_sc_field_${nome}_${indice}["'][^>]*>([\\s\\S]*?)<\\/span>`, 'i');
  const match = html.match(re);
  return match ? limparHtml(match[1]) : '';
}

function normalizarProposicao(texto) {
  const match = texto.match(/^([A-Z]+)-([\d.]+)\/(\d{4})/i);
  if (!match) return { tipo: texto, numero: '-', ano: '-' };
  return { tipo: match[1].toUpperCase(), numero: match[2].replace(/\./g, ''), ano: match[3] };
}

function numeroInteiro(p) {
  const n = Number(String(p.numero || '').replace(/\D/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function chaveTipoAno(p) {
  return `${p.tipo || 'OUTROS'}|${p.ano || '-'}`;
}

function calcularUltimosPorTipoAno(proposicoes) {
  const ultimos = {};
  for (const p of proposicoes) {
    const numero = numeroInteiro(p);
    if (!numero || !p.ano || p.ano === '-') continue;
    const chave = chaveTipoAno(p);
    ultimos[chave] = Math.max(ultimos[chave] || 0, numero);
  }
  return ultimos;
}

function detectarSaltos(proposicoes, estado) {
  const anteriores = estado.ultimos_por_tipo_ano || {};
  const atuais = calcularUltimosPorTipoAno(proposicoes);
  const presentes = {};
  for (const p of proposicoes) {
    const numero = numeroInteiro(p);
    if (!numero) continue;
    const chave = chaveTipoAno(p);
    if (!presentes[chave]) presentes[chave] = new Set();
    presentes[chave].add(numero);
  }

  const alertas = [];
  for (const [chave, atual] of Object.entries(atuais)) {
    const anterior = Number(anteriores[chave] || 0);
    if (!anterior || atual <= anterior + 1) continue;
    const faltantes = [];
    for (let n = anterior + 1; n < atual; n++) {
      if (!presentes[chave]?.has(n)) faltantes.push(n);
    }
    if (faltantes.length > 0) {
      const [tipo, ano] = chave.split('|');
      alertas.push({ tipo, ano, anterior, atual, faltantes });
    }
  }
  return { alertas, atuais };
}

function extrairProposicoes(html) {
  const indices = [...html.matchAll(/id=["']id_sc_field_proposicao_(\d+)["']/gi)].map(m => Number(m[1]));
  const itens = [];
  for (const i of indices) {
    const proposicao = campo(html, 'proposicao', i);
    if (!proposicao) continue;
    const norm = normalizarProposicao(proposicao);
    const data = campo(html, 'tra_dt_movimentacao', i);
    const id = `${proposicao}|${data}|${campo(html, 'autorproposicao', i)}`;
    itens.push({
      id,
      tipo: norm.tipo,
      numero: norm.numero,
      ano: norm.ano,
      proposicao,
      autor: campo(html, 'autorproposicao', i),
      data,
      ementa: campo(html, 'pro_ementa', i),
      localizacao: campo(html, 'destino', i),
      situacao: campo(html, 'sit_nome_futuro', i),
      link: URL,
    });
  }
  return itens;
}

function extrairCookie(headers) {
  const setCookie = headers.get('set-cookie');
  if (!setCookie) return '';
  return setCookie.split(',').map(c => c.split(';')[0].trim()).join('; ');
}

function proximoOffset(html) {
  const match = html.match(/nm_gp_rec_fim\s*=\s*["'](\d+)["']/);
  return match ? match[1] : null;
}

async function carregarPagina(offset = null, cookie = '') {
  const headers = { 'User-Agent': 'Mozilla/5.0 Chrome/120', 'Accept': 'text/html' };
  let options = { headers, signal: AbortSignal.timeout(30000) };
  if (offset) {
    const body = new URLSearchParams({
      nmgp_opcao: 'rec',
      rec: offset,
      nm_call_php: '',
      script_case_init: '5750',
    });
    options = {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body,
      signal: AbortSignal.timeout(30000),
    };
  }
  const res = await fetch(URL, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} em Salvador`);
  return { html: await res.text(), cookie: extrairCookie(res.headers) || cookie };
}

async function buscarProposicoes(idsVistos = new Set()) {
  const todas = [];
  const idsPagina = new Set();
  let offset = null;
  let cookie = '';

  for (let pagina = 1; pagina <= MAX_PAGES; pagina++) {
    const resposta = await carregarPagina(offset, cookie);
    cookie = resposta.cookie;
    const itens = extrairProposicoes(resposta.html);
    console.log(`Grade Scriptcase página ${pagina}: ${itens.length} proposições.`);
    if (itens.length === 0) break;

    let paginaTemVisto = false;
    for (const item of itens) {
      if (idsVistos.has(item.id)) paginaTemVisto = true;
      if (!idsPagina.has(item.id)) {
        idsPagina.add(item.id);
        todas.push(item);
      }
    }

    offset = proximoOffset(resposta.html);
    if (!offset) break;
    if (paginaTemVisto && process.env.SEED_ONLY !== '1') break;
  }

  return todas;
}

function renderAlertasSaltos(alertas) {
  if (!alertas.length) return '';
  const itens = alertas.map(a => `<li><strong>${escapeHtml(a.tipo)} ${escapeHtml(a.ano)}</strong>: último visto ${a.anterior}, maior atual ${a.atual}. Possível(is) ausente(s): ${escapeHtml(a.faltantes.join(', '))}</li>`).join('');
  return `<div style="background:#fff4e5;border:1px solid #f59e0b;color:#7c2d12;padding:12px 14px;margin:12px 0;border-radius:4px"><strong>Alerta de sequência:</strong><ul style="margin:8px 0 0 18px;padding:0">${itens}</ul></div>`;
}

async function enviarEmail(novas, alertas = []) {
  if (process.env.DRY_RUN_EMAIL === '1') {
    console.log(`[DRY_RUN_EMAIL] ${novas.length} proposições novas.`);
    novas.slice(0, 10).forEach(p => console.log(`${p.proposicao} - ${p.data} - ${p.autor}`));
    alertas.forEach(a => console.log(`[ALERTA_SEQUENCIA] ${a.tipo}/${a.ano}: ${a.anterior} -> ${a.atual}; faltantes: ${a.faltantes.join(', ')}`));
    return;
  }
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_REMETENTE, pass: process.env.EMAIL_SENHA } });
  const linhas = novas.map(p => `<tr>
    <td style="padding:8px;border-bottom:1px solid #eee"><strong>${escapeHtml(p.proposicao)}</strong><br><span style="font-size:11px;color:#667085">${escapeHtml(p.situacao)}</span></td>
    <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(p.autor)}</td>
    <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap">${escapeHtml(p.data)}</td>
    <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(p.ementa)}</td>
    <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(p.localizacao)}</td>
  </tr>`).join('');
  await transporter.sendMail({
    from: `"Monitor ${CASA}" <${process.env.EMAIL_REMETENTE}>`,
    to: process.env.EMAIL_DESTINO,
    subject: `🏛️ Salvador: ${novas.length} nova(s) proposição(ões)${alertas.length ? ' | alerta sequência' : ''} — ${new Date().toLocaleDateString('pt-BR')}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:980px"><h2>Salvador — ${novas.length} nova(s) proposição(ões)</h2>${renderAlertasSaltos(alertas)}<table style="border-collapse:collapse;width:100%">${linhas}</table><p><a href="${URL}">Fonte oficial</a></p></div>`,
  });
}

(async () => {
  console.log('Iniciando Monitor Proposições Salvador...');
  const estado = carregarEstado();
  const ids = new Set((estado.proposicoes_vistas || []).map(String));
  const proposicoes = await buscarProposicoes(ids);
  const novas = proposicoes.filter(p => !ids.has(p.id));
  const { alertas, atuais } = detectarSaltos(proposicoes, estado);
  console.log(`Total: ${proposicoes.length} | Novas: ${novas.length}`);
  if (alertas.length) {
    alertas.forEach(a => console.log(`ALERTA sequência ${a.tipo}/${a.ano}: ${a.anterior} -> ${a.atual}; faltantes: ${a.faltantes.join(', ')}`));
  }
  if (process.env.SEED_ONLY === '1') {
    proposicoes.forEach(p => ids.add(p.id));
    estado.proposicoes_vistas = Array.from(ids);
    estado.ultimos_por_tipo_ano = { ...(estado.ultimos_por_tipo_ano || {}), ...atuais };
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
    console.log('SEED_ONLY=1 — estado semeado sem envio.');
    return;
  }
  if (novas.length || alertas.length) {
    await enviarEmail(novas, alertas);
    novas.forEach(p => ids.add(p.id));
    estado.proposicoes_vistas = Array.from(ids);
  }
  estado.ultimos_por_tipo_ano = { ...(estado.ultimos_por_tipo_ano || {}), ...atuais };
  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
})();
