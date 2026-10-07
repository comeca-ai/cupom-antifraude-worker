# Cupom Antifraude — API para Cloudflare Workers

Recebe a chave numérica de 44 dígitos de um cupom NF-e/NFC-e e retorna verificações estruturadas. Não precisa de XML. Não há interface web. Esta versão é um motor de triagem, não uma certificação de fraude nem uma aprovação de reembolso.

## O que está implementado

- Validação de formato, dígito verificador módulo 11, UF e mês. Extração de modelo, emitente, série e número.
- Comparação do CNPJ e do **mês** informado com a chave. Isso não valida o cadastro do emitente nem o dia da compra.
- Registro de primeiro uso e identificação de reapresentação em despesas diferentes, com D1 opcional, unicidade e operação atômica. Retry do mesmo par chave/ID é idempotente.
- Cliente SOAP de consulta da situação fiscal em produção, usando certificado no binding `SEFAZ_MTLS`. Endpoints dos modelos 55 e 65 derivados do upstream nas 27 UFs.
- Resultados oficiais separados: `authorized`, `cancelled`, `denied`, `not_found`, `inconclusive`.
- Token obrigatório, limite de payload/retorno, timeout, destinos fixos, proibição de redirects nas consultas, bloqueio de DTD, conferência de chave/ambiente/protocolo e respostas sem cache.

## Limite importante para seu caso

**Só com a chave e sem certificado, esta versão não confirma automaticamente se a nota existe.** O serviço oficial SOAP precisa de certificado aceito pela SEFAZ. As consultas públicas por navegador podem exigir CAPTCHA e não são uma API universal. Por isso, sem `SEFAZ_MTLS`, o retorno é `official.status: "inconclusive"`, junto com `manualConsultationUrl`.

O adaptador mTLS foi testado com respostas sintéticas; não foi validado com um certificado real. Cobertura de endpoints não significa teste de integração nas 27 UFs. A compatibilidade do certificado, cadeia, TLS, disponibilidade e permissões precisa ser validada na implantação. A Cloudflare documenta uma limitação de mTLS para destinos que sejam zonas com proxy da própria Cloudflare. Não há fallback que desabilite a validação TLS.

NFS-e, CF-e-SAT (modelo 59), imagem/OCR, XML e CNPJ alfanumérico não fazem parte desta versão. Um modelo não suportado não será tratado como nota inexistente. Valor, itens, CPF do consumidor e dia da compra não estão na chave; a consulta de protocolo também não fornece esses itens. Mesmo uma nota autorizada pode ser reapresentada ou pertencer a outra pessoa.

## API

`POST /api/check` com `Content-Type: application/json` e `Authorization: Bearer <API_TOKEN>`.

```json
{
  "key": "CHAVE_DE_44_DIGITOS",
  "expenseId": "despesa-2026-001",
  "expected": {
    "issuer": "12345678000195",
    "date": "2026-10-07",
    "amountCents": 15990
  }
}
```

Somente `key` é obrigatório, sempre **string**. Aceita espaços. `issuer` são 14 dígitos sem pontuação; `date` é uma data real no formato `YYYY-MM-DD`; `amountCents` é inteiro positivo (retorna explicitamente `not_verified`). Campos desconhecidos são rejeitados.

`expenseId` aceita 1–100 caracteres entre letras, números, `_`, `.`, `:`, `-`. **Informar esse campo registra o primeiro uso da chave no D1**, se disponível. Sem esse campo, a chamada apenas consulta. Se outra despesa já usa a chave ou o mesmo ID já usa outra chave, retorna conflito sem substituir o registro original. A API não é um livro completo de auditoria: guarda apenas primeiro uso, ID e data. Cada implantação corresponde a uma organização; não compartilhar o mesmo token/banco entre clientes independentes. Reutilizar o mesmo ID em despesas diferentes impede a identificação correta de reapresentação.

Exemplo de chamada (substitua a chave e configure variáveis no seu backend):

```sh
curl "$WORKER_URL/api/check" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"key":"CHAVE_DE_44_DIGITOS","expenseId":"despesa-001"}'
```

As consultas retornam HTTP 200 também para inconsistências fiscais: leia o JSON. Erros: 400 entrada inválida, 401 autenticação, 403 origem de navegador diferente, 413 corpo maior que 8 KiB, 415 formato, 429 limite de consultas se configurado, 503 token não configurado, 500 erro interno. Chamadas entre servidores sem `Origin` são aceitas; não há CORS público.

| Campo | Significado |
| --- | --- |
| `assessment` | `review_required` se existem sinais; `inconclusive` se não existem. Não há aprovação automática. |
| `official.status` | Situação fiscal recebida do serviço oficial, ou `inconclusive`. |
| `official.checkedAt` | Momento da consulta com resposta válida; `null` se ela não foi concluída. |
| `official.source` | Endpoint consultado, ou `null`. Sua presença sozinha não indica sucesso. |
| `signals` | Códigos e motivos para revisão. Não são probabilidades de fraude. |
| `duplicate.status` | `not_requested`, `unavailable`, `registered`, `same_expense` ou `conflict`. |
| `checks.amount` | `not_verified` quando valor declarado; nunca confirmado só pela chave. |
| `checks.date` | `month_only` quando data declarada. |
| `manualConsultationUrl` | Link de consulta pública, não evidência nem tentativa de scraping. |

`not_found` é o código 217 retornado pela SEFAZ naquela consulta. Pode exigir revisão por prazo de transmissão, contingência ou erro de digitação; não é sinônimo de fraude. `authorized` exige chave, ambiente de produção e protocolo de autorização correspondentes. Retorno malformado, timeout, erro HTTP, CAPTCHA ou código desconhecido é inconclusivo. Não se deve aprovar uma despesa só porque `keyStructure` é `consistent` ou porque não há `signals`.

`GET /health` retorna saúde do processo. Não confirma disponibilidade da SEFAZ. `GET /` fornece descoberta da API. Contrato: [worker-openapi.json](worker-openapi.json).

## Desenvolvimento e publicação

Requer Node.js 22.13+ (testes usam SQLite nativo) e npm. O Worker de produção usa Web APIs e não depende de Node/PHP.

```sh
npm ci
npm test
npm run build
```

`build` usa esbuild em WebAssembly e gera `dist/worker.mjs`. `npm run check:deploy` faz a validação adicional pelo Wrangler. No ambiente desta entrega, o binário nativo do esbuild usado pelo Wrangler foi encerrado pelo sistema; por isso esse dry-run não foi concluído. O bundle WebAssembly e os testes foram executados separadamente. Isso não equivale a validação no runtime Cloudflare.

Para executar localmente, crie `.dev.vars` (ignorado pelo Git):

```text
API_TOKEN=coloque-um-segredo-aleatorio-de-pelo-menos-32-caracteres
```

```sh
npm run dev
```

Para publicar na sua conta Cloudflare:

```sh
npx wrangler login
npx wrangler secret put API_TOKEN
npm run deploy
```

A API recusa consultas até que exista token com pelo menos 32 caracteres. Guarde esse segredo no backend consumidor, não em frontend público. Nenhuma credencial, certificado real ou conta Cloudflare foi configurada nesta entrega.

### D1: detectar duplicidade

```sh
npx wrangler d1 create cupom-antifraude
```

Acrescente ao `wrangler.jsonc` usando o ID retornado:

```json
"d1_databases": [{"binding":"DB","database_name":"cupom-antifraude","database_id":"ID_RETORNADO"}]
```

```sh
npx wrangler d1 execute cupom-antifraude --remote --file=worker-schema.sql
```

Para desenvolvimento use `--local`. Sem D1, `duplicate.status` será `unavailable` quando registro for solicitado. Uma falha de banco também é `unavailable`, nunca ausência de duplicidade. O banco guarda chave completa e ID, sem exposição em endpoints de listagem. A retenção deve ser definida pelo operador. IDs de despesa não devem conter dados pessoais.

### Consulta oficial via certificado

É opcional para triagem local e **necessária para confirmar a situação fiscal automaticamente nesta implementação**. Use certificado ICP-Brasil aceito pelos serviços consultados. Faça a gestão do certificado e da chave privada fora do repositório.

```sh
npx wrangler mtls-certificate upload --cert /caminho/cert.pem --key /caminho/key.pem --name sefaz
```

Acrescente o binding usando o ID retornado:

```json
"mtls_certificates": [{"binding":"SEFAZ_MTLS","certificate_id":"ID_RETORNADO"}]
```

Republique e teste com notas conhecidas (autorizada e cancelada) em cada UF/modelo que for operar, usando um ambiente de implantação controlado. A API usa somente produção (`tpAmb=1`) e não assina nem emite notas. Não aceita URL de destino fornecida pelo cliente.

Opcionalmente configure um binding Workers Rate Limiting chamado `RATE_LIMITER`; se presente, a API o consulta antes de processar. Sem ele, não há limitação de frequência na aplicação. Os retornos têm `Cache-Control: no-store` e o Worker não registra corpo/token/chave em logs. Observabilidade está desabilitada por padrão.

## Testes e origem

Os testes cobrem dígito conhecido do upstream, entradas inválidas, divergências, códigos fiscais, chave/ambiente/protocolo incompatíveis, falhas de consulta, autenticação, limite de corpo, retries e unicidade usando SQLite real. As respostas SOAP são fixtures sintéticas; não são notas reais.

Fork de [nfephp-org/sped-nfe](https://github.com/nfephp-org/sped-nfe), commit `346c14d5b7e59ab9aab92e7a77c499a19d462fba`. `worker-endpoints.json` foi derivado dos arquivos `storage/autorizadores.json`, `storage/wsnfe_4.00_mod55.xml`, `storage/wsnfe_4.00_mod65.xml` e `storage/uri_consulta_nfce.json`. Os links públicos vêm desse snapshot e podem mudar. A biblioteca original e sua licença permanecem no repositório; este Worker não executa o PHP. Novos arquivos desta implementação são disponibilizados sob a licença MIT reproduzida em `LICENSE-WORKER.txt`; os dados derivados e o upstream mantêm suas licenças originais.

Referências: [consulta por chave do NFePHP](https://github.com/nfephp-org/sped-nfe/blob/master/docs/metodos/ConsultaChave.md), [mTLS Cloudflare](https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/), [D1](https://developers.cloudflare.com/d1/worker-api/), [MOC NF-e](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=J+I+v4eN00E%3D).

Validação de dependências nesta entrega: `npm audit --omit=dev` não encontrou vulnerabilidades. A árvore de ferramentas de desenvolvimento do Wrangler apresentou aviso alto transitivo em `sharp`/librsvg (GHSA-wq5f-xc86-pv6w), fora do bundle de produção; revisar a atualização do Wrangler antes de usar funções de processamento de imagens no desenvolvimento.
