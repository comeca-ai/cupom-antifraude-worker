import { XMLParser, XMLValidator } from 'fast-xml-parser';
import endpoints from './worker-endpoints.json' with { type: 'json' };

const UFS = {'11':'RO','12':'AC','13':'AM','14':'RR','15':'PA','16':'AP','17':'TO','21':'MA','22':'PI','23':'CE','24':'RN','25':'PB','26':'PE','27':'AL','28':'SE','29':'BA','31':'MG','32':'ES','33':'RJ','35':'SP','41':'PR','42':'SC','43':'RS','50':'MS','51':'MT','52':'GO','53':'DF'};
const headers = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'};
const json = (body, status=200) => Response.json(body, {status, headers});
class InputError extends Error { constructor(message, status=400) { super(message); this.status=status; } }

export function checkDigit(first43) {
  let sum=0, weight=2;
  for (let i=42;i>=0;i--) { sum+=Number(first43[i])*weight; weight=weight===9?2:weight+1; }
  const result=11-(sum%11);
  return String(result>=10?0:result);
}

export function inspectKey(input, now=new Date()) {
  if (typeof input!=='string' || input.length>100 || !/^[\d\s]+$/.test(input)) throw new InputError('Informe a chave numérica, com ou sem espaços.');
  const key=input.replace(/\s/g,'');
  if (key.length!==44) throw new InputError('A chave precisa ter 44 dígitos.');
  const signals=[];
  const flag=(code,message) => signals.push({code,message});
  const data={uf:UFS[key.slice(0,2)]??null, model:key.slice(20,22), issuer:key.slice(6,20), yearMonth:`20${key.slice(2,4)}-${key.slice(4,6)}`, series:key.slice(22,25), number:key.slice(25,34), emissionType:key[34]};
  if (checkDigit(key.slice(0,43))!==key[43]) flag('INVALID_CHECK_DIGIT','O dígito verificador não corresponde à chave. Confira a digitação.');
  if (!data.uf) flag('INVALID_UF','Código de estado desconhecido.');
  const month=Number(key.slice(4,6));
  if (month<1 || month>12) flag('INVALID_MONTH','Mês inválido na chave.');
  const currentParts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit'}).formatToParts(now);
  const currentYM=currentParts.find(x=>x.type==='year').value+'-'+currentParts.find(x=>x.type==='month').value;
  if (month>=1 && month<=12 && data.yearMonth>currentYM) flag('FUTURE_MONTH','A chave indica mês futuro; confira os dados.');
  const supported=['55','65'].includes(data.model);
  if (!supported) flag('UNSUPPORTED_MODEL',`Modelo ${data.model} fora do escopo NF-e/NFC-e desta versão.`);
  return {key,data,signals,valid:!signals.some(s=>['INVALID_CHECK_DIGIT','INVALID_UF','INVALID_MONTH'].includes(s.code)),supported};
}

export async function readLimited(stream, limit) {
  if (!stream) return '';
  const reader=stream.getReader(); const chunks=[]; let size=0;
  try {
    while (true) { const {value,done}=await reader.read(); if(done) break; size+=value.byteLength; if(size>limit) { await reader.cancel(); throw new InputError('Conteúdo maior que o limite permitido.',413); } chunks.push(value); }
  } finally {reader.releaseLock();}
  const bytes=new Uint8Array(size); let offset=0;
  for(const chunk of chunks) {bytes.set(chunk,offset); offset+=chunk.byteLength;}
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}

export function parseSefaz(xml, key) {
  if (xml.length>262144 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml)!==true) throw new Error('Invalid XML');
  const parser=new XMLParser({removeNSPrefix:true,parseTagValue:false,ignoreAttributes:true,processEntities:false});
  const document=parser.parse(xml);
  const body=document.Envelope?.Body;
  if (!body || body.Fault) throw new Error('SOAP fault');
  let result=body.nfeResultMsg?.retConsSitNFe ?? body.nfeConsultaNFResponse?.nfeConsultaNFResult?.retConsSitNFe;
  // Some SOAP services encode the XML inside the result string.
  if (!result) {
    const encoded=body.nfeResultMsg??body.nfeConsultaNFResponse?.nfeConsultaNFResult;
    if(typeof encoded==='string') {
      const decoded=encoded.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
      if(/<!DOCTYPE|<!ENTITY/i.test(decoded)||XMLValidator.validate(decoded)!==true) throw new Error('Invalid inner XML');
      result=parser.parse(decoded).retConsSitNFe;
    }
  }
  if (!result || Array.isArray(result) || result.tpAmb!=='1' || result.chNFe!==key || !/^\d{3}$/.test(result.cStat)) throw new Error('Unbound response');
  const cStat=result.cStat;
  let status='inconclusive';
  if (['100','150','120'].includes(cStat)) {
    const protocol=result.protNFe?.infProt;
    if(!protocol || protocol.chNFe!==key || protocol.tpAmb!=='1' || !['100','150','120'].includes(protocol.cStat) || !/^\d{15}$/.test(protocol.nProt??'')) throw new Error('Invalid authorization protocol');
    status='authorized';
  } else if (['101','151','155'].includes(cStat)) status='cancelled';
  else if (['110','301','302','303','205'].includes(cStat)) status='denied';
  else if (cStat==='217') status='not_found';
  return {status,cStat,reason:typeof result.xMotivo==='string'?result.xMotivo.slice(0,500):'',protocol:result.protNFe?.infProt?.nProt??null};
}

export async function queryOfficial(inspected, env, now=new Date()) {
  const base={status:'inconclusive',checkedAt:null,source:null,reason:'Consulta automática não configurada. Confira no portal oficial.'};
  if(!inspected.valid || !inspected.supported) return {...base,reason:'A consulta não foi executada: confira a chave e o modelo.'};
  if(!env.SEFAZ_MTLS) return base;
  const endpoint=endpoints.soap[inspected.data.model]?.[inspected.data.uf];
  if(!endpoint || !endpoint.startsWith('https://')) return {...base,reason:'Não há endpoint HTTPS configurado para este modelo e UF.'};
  const ns='http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4';
  const body=`<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><nfeDadosMsg xmlns="${ns}"><consSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>1</tpAmb><xServ>CONSULTAR</xServ><chNFe>${inspected.key}</chNFe></consSitNFe></nfeDadosMsg></soap12:Body></soap12:Envelope>`;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  try {
    const response=await env.SEFAZ_MTLS.fetch(endpoint,{method:'POST',headers:{'Content-Type':`application/soap+xml; charset=utf-8; action="${ns}/nfeConsultaNF"`},body,redirect:'manual',signal:controller.signal});
    if(!response.ok) { await response.body?.cancel(); throw new Error('HTTP failure'); }
    const result=parseSefaz(await readLimited(response.body,262144),inspected.key);
    return {...result,checkedAt:now.toISOString(),source:endpoint};
  } catch {return {...base,source:endpoint,reason:'Não foi possível obter uma resposta oficial válida. Tente novamente ou consulte o portal.'};}
  finally {clearTimeout(timer);}
}

export function publicPortal(data) {
  if(data.model==='55') return 'https://www.nfe.fazenda.gov.br/portal/consulta.aspx?tipoConsulta=resumo';
  if(data.model!=='65' || !data.uf) return null;
  const target=endpoints.public[data.uf];
  if(!target) return null;
  // Links are navigation hints from upstream, not evidence that a note exists.
  return /^https?:\/\//.test(target)?target:`https://${target}`;
}

function validatePayload(body) {
  if(!body || typeof body!=='object' || Array.isArray(body)) throw new InputError('JSON inválido.');
  if(Object.keys(body).some(k=>!['key','expected','expenseId'].includes(k))) throw new InputError('Campo desconhecido.');
  if(body.expenseId!==undefined && (typeof body.expenseId!=='string'|| !/^[A-Za-z0-9_.:-]{1,100}$/.test(body.expenseId))) throw new InputError('ID de despesa inválido.');
  const e=body.expected??{};
  if(typeof e!=='object'||Array.isArray(e)||Object.keys(e).some(k=>!['issuer','date','amountCents'].includes(k))) throw new InputError('Dados esperados inválidos.');
  if(e.issuer!==undefined && (typeof e.issuer!=='string'||!/^\d{14}$/.test(e.issuer))) throw new InputError('O CNPJ esperado deve ter 14 dígitos.');
  if(e.date!==undefined && (typeof e.date!=='string'||!/^20\d{2}-\d{2}-\d{2}$/.test(e.date)||Number.isNaN(Date.parse(e.date+'T12:00:00Z'))||new Date(e.date+'T12:00:00Z').toISOString().slice(0,10)!==e.date)) throw new InputError('Data inválida.');
  if(e.amountCents!==undefined && (!Number.isSafeInteger(e.amountCents)||e.amountCents<=0||e.amountCents>1e12)) throw new InputError('Informe o valor em centavos inteiros positivos.');
  return e;
}

export async function checkReceipt(body, env, now=new Date()) {
  const expected=validatePayload(body);
  const inspected=inspectKey(body.key,now);
  const signals=[...inspected.signals];
  if(expected.issuer && expected.issuer!==inspected.data.issuer) signals.push({code:'ISSUER_MISMATCH',message:'O CNPJ informado difere do identificador na chave.'});
  if(expected.date && expected.date.slice(0,7)!==inspected.data.yearMonth) signals.push({code:'MONTH_MISMATCH',message:'O mês informado difere do mês de emissão na chave.'});
  let duplicate={status:body.expenseId?'unavailable':'not_requested'};
  if(body.expenseId && env.DB && inspected.valid && inspected.supported) {
    try {
      // An atomic batch plus both uniqueness constraints prevents concurrent double claims.
      const results=await env.DB.batch([
        env.DB.prepare('INSERT INTO receipts (access_key, expense_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(inspected.key,body.expenseId,now.toISOString()),
        env.DB.prepare('SELECT access_key, expense_id FROM receipts WHERE access_key = ? OR expense_id = ?').bind(inspected.key,body.expenseId)
      ]);
      const rows=results[1].results;
      if(!results.every(x=>x.success) || !Array.isArray(rows)) throw new Error('Storage error');
      const same=rows.some(r=>r.access_key===inspected.key && r.expense_id===body.expenseId);
      duplicate={status:same?(results[0].meta.changes>0?'registered':'same_expense'):'conflict'};
      if(!same) signals.push({code:'DUPLICATE_OR_ID_CONFLICT',message:'Este cupom já foi registrado para outra despesa, ou o ID já está ligado a outro cupom. Revise o histórico.'});
    } catch {duplicate={status:'unavailable'};}
  }
  const official=await queryOfficial(inspected,env,now);
  if(['cancelled','denied','not_found'].includes(official.status)) signals.push({code:`OFFICIAL_${official.status.toUpperCase()}`,message:official.status==='not_found'?'A SEFAZ não localizou a nota nesta consulta. Confira contingência, prazo e digitação antes de concluir.':`Situação fiscal retornada pela SEFAZ: ${official.status==='cancelled'?'cancelada':'denegada'}.`});
  return {
    checkedAt:now.toISOString(),key:inspected.key,document:inspected.data,
    assessment:signals.length?'review_required':'inconclusive',
    summary:signals.length?'Há inconsistências que precisam de revisão.':'Nenhuma inconsistência local encontrada. Isso não comprova a despesa.',
    official,signals,duplicate,manualConsultationUrl:publicPortal(inspected.data),
    checks:{keyStructure:inspected.valid?'consistent':'invalid',modelSupported:inspected.supported,issuer:expected.issuer?'compared_with_key':'not_requested',date:expected.date?'month_only':'not_requested',amount:expected.amountCents?'not_verified':'not_requested'},
    limitations:['A chave não contém valor, itens ou dia da compra.','Uma nota autorizada não comprova que a despesa pertence ao solicitante.','Esta versão não valida XML, assinatura do XML ou imagem do cupom.','Sem resposta oficial válida, a existência da nota permanece inconclusiva.']
  };
}

async function authorized(request,token) {
  if(typeof token!=='string'||token.length<32) return false;
  const auth=request.headers.get('authorization')??'';
  if(auth.length>512) return false;
  const encode=new TextEncoder();
  const [a,b]=await Promise.all([crypto.subtle.digest('SHA-256',encode.encode(auth)),crypto.subtle.digest('SHA-256',encode.encode(`Bearer ${token}`))]);
  const aa=new Uint8Array(a),bb=new Uint8Array(b); let diff=0;
  for(let i=0;i<aa.length;i++) diff|=aa[i]^bb[i];
  return diff===0;
}

export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(url.pathname==='/' && request.method==='GET') {
      return json({name:'cupom-antifraude',version:'0.1.0',checkEndpoint:'POST /api/check',docs:'https://github.com/comeca-ai/cupom-antifraude-worker/blob/master/README-WORKER.md'});
    }
    if(url.pathname==='/health' && request.method==='GET') return json({ok:true,version:'0.1.0'});
    if(url.pathname!=='/api/check') return json({error:'Não encontrado.'},404);
    if(request.method!=='POST') return json({error:'Use POST.'},405);
    if(!env.API_TOKEN || env.API_TOKEN.length<32) return json({error:'Configure API_TOKEN com pelo menos 32 caracteres.'},503);
    if(!await authorized(request,env.API_TOKEN)) return json({error:'Não autorizado.'},401);
    if(request.headers.get('origin') && request.headers.get('origin')!==url.origin) return json({error:'Origem não permitida.'},403);
    if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??'')) return json({error:'Use application/json.'},415);
    try {
      if(env.RATE_LIMITER) {const limit=await env.RATE_LIMITER.limit({key:request.headers.get('CF-Connecting-IP')??'shared'}); if(!limit.success) return json({error:'Limite de consultas. Aguarde e tente novamente.'},429);}
      let body;
      const content=await readLimited(request.body,8192);
      try {body=JSON.parse(content);} catch {throw new InputError('JSON inválido.');}
      return json(await checkReceipt(body,env));
    } catch(error) {return json({error:error instanceof InputError?error.message:'Falha interna. Tente novamente.'},error instanceof InputError?error.status:500);}
  }
};
