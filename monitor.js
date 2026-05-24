const fs = require('fs');

const CASA = 'CMSALVADOR';
const URL = 'https://cmsalvador.sys.inf.br/cl/prop_interna/';
const ARQUIVO_ESTADO = 'estado.json';

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

async function buscarProposicoes() {
  const res = await fetch(URL, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120', 'Accept': 'text/html' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} em Salvador`);
  const html = await res.text();
  const itens = extrairProposicoes(html);
  console.log(`Grade Scriptcase: ${itens.length} proposições na primeira página.`);
  return itens;
}

async function enviarEmail(novas) {
  if (process.env.DRY_RUN_EMAIL === '1') {
    console.log(`[DRY_RUN_EMAIL] ${novas.length} proposições novas.`);
    novas.slice(0, 10).forEach(p => console.log(`${p.proposicao} - ${p.data} - ${p.autor}`));
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
    subject: `🏛️ Salvador: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:980px"><h2>Salvador — ${novas.length} nova(s) proposição(ões)</h2><table style="border-collapse:collapse;width:100%">${linhas}</table><p><a href="${URL}">Fonte oficial</a></p></div>`,
  });
}

(async () => {
  console.log('Iniciando Monitor Proposições Salvador...');
  const estado = carregarEstado();
  const ids = new Set((estado.proposicoes_vistas || []).map(String));
  const proposicoes = await buscarProposicoes();
  const novas = proposicoes.filter(p => !ids.has(p.id));
  console.log(`Total: ${proposicoes.length} | Novas: ${novas.length}`);
  if (process.env.SEED_ONLY === '1') {
    proposicoes.forEach(p => ids.add(p.id));
    estado.proposicoes_vistas = Array.from(ids);
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
    console.log('SEED_ONLY=1 — estado semeado sem envio.');
    return;
  }
  if (novas.length) {
    await enviarEmail(novas);
    novas.forEach(p => ids.add(p.id));
    estado.proposicoes_vistas = Array.from(ids);
  }
  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
})();
