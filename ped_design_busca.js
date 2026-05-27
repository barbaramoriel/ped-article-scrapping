#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const zlib = require("zlib");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");

const BASE_URL = "https://memoriapeddesign.com.br";
const DEFAULT_OUTPUT_DIR = "/Users/barbaramoriel/Documents/FAE/PAIC/P&D Design/Revisao_sistematica";
const BUNDLED_NODE = "/Users/barbaramoriel/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node";
const BUNDLED_PDFJS = "/Users/barbaramoriel/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pdfjs-dist/legacy/build/pdf.mjs";

const ALL_CONGRESSES = [
  {
    edition: "9º Congresso Brasileiro de Pesquisa e Desenvolvimento em Design",
    shortEdition: "9º P&D Design",
    year: 2010,
    url: "https://memoriapeddesign.com.br/editions/9_congresso_brasileiro_de_pesquisa_e_desenvolvimento_em_design/articles",
  },
  {
    edition: "10º Congresso Brasileiro de Pesquisa e Desenvolvimento em Design",
    shortEdition: "10º P&D Design",
    year: 2012,
    url: "https://memoriapeddesign.com.br/editions/10_congresso_brasileiro_de_pesquisa_e_desenvolvimento_em_design/articles",
  },
  {
    edition: "11º Congresso Brasileiro de Pesquisa e Desenvolvimento em Design",
    shortEdition: "11º P&D Design",
    year: 2014,
    url: "https://memoriapeddesign.com.br/editions/11_congresso_brasileiro_de_pesquisa_e_desenvolvimento_em_design/articles",
  },
  {
    edition: "12º Congresso Brasileiro de Pesquisa e Desenvolvimento em Design",
    shortEdition: "12º P&D Design",
    year: 2016,
    url: "https://memoriapeddesign.com.br/editions/12_congresso_brasileiro_de_pesquisa_e_desenvolvimento_em_design/articles",
  },
  {
    edition: "13º Congresso Brasileiro de Pesquisa e Desenvolvimento em Design",
    shortEdition: "13º P&D Design",
    year: 2018,
    url: "https://memoriapeddesign.com.br/editions/13_congresso_pesquisa_e_desenvolvimento_em_design/articles",
  },
  {
    edition: "14º Congresso Brasileiro de Pesquisa e Desenvolvimento em Design",
    shortEdition: "14º P&D Design",
    year: 2022,
    url: "https://memoriapeddesign.com.br/editions/14_congresso_brasileiro_de_pesquisa_e_desenvolvimento_em_design/articles",
  },
  {
    edition: "15º Congresso Brasileiro de Pesquisa e Desenvolvimento em Design",
    shortEdition: "15º P&D Design",
    year: 2024,
    url: "https://memoriapeddesign.com.br/editions/15_congresso_brasileiro_de_pesquisa_e_desenvolvimento_em_design/articles",
  },
];

const DEFAULT_YEARS = [2016, 2018, 2022, 2024];

const CONCEPTS = [
  {
    key: "linguagem_simples",
    label: "Linguagem simples",
    phrases: ["linguagem simples", "plain language"],
  },
  {
    key: "linguagem_visual",
    label: "Linguagem visual",
    phrases: ["linguagem visual", "visual language"],
  },
  {
    key: "design_informacao",
    label: "Design da informação",
    phrases: ["design da informação", "design de informação", "information design"],
  },
  {
    key: "visualizacao_informacao",
    label: "Visualização da informação",
    phrases: [
      "visualização da informação",
      "visualizacao da informacao",
      "information visualization",
    ],
  },
];

const METADATA_FIELDS = ["titulo", "resumo", "abstract", "palavrasChave", "keywords"];
const PDF_FIELDS = ["introducao", "consideracoesFinais", "corpo"];
const ALL_OCCURRENCE_FIELDS = [
  "titulo",
  "resumo",
  "abstract",
  "palavrasChave",
  "keywords",
  "introducao",
  "consideracoesFinais",
  "corpo",
];

const options = parseArgs(process.argv.slice(2));
const outputRoot = path.resolve(options.outDir || DEFAULT_OUTPUT_DIR);
const dataDir = path.join(outputRoot, "data");
const filtro2Dir = path.join(outputRoot, "filtro2");
const filtro3Dir = path.join(filtro2Dir, "filtro3");
const cacheDir = path.resolve(options.cacheDir || path.join(dataDir, "raw_cache"));
const logs = [];

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

async function main() {
  const selectedCongresses = selectCongresses();
  ensureDirectory(dataDir);
  ensureDirectory(cacheDir);
  for (const congress of selectedCongresses) {
    ensureDirectory(path.join(filtro2Dir, String(congress.year)));
    ensureDirectory(path.join(filtro3Dir, String(congress.year)));
  }

  console.error("Iniciando RBS P&D Design");
  console.error(`Edições: ${selectedCongresses.map((item) => item.shortEdition).join(", ")}`);
  console.error(`Saída: ${outputRoot}`);

  const records = [];

  for (const congress of selectedCongresses) {
    console.error(`\n[${congress.year}] Coletando artigos de ${congress.shortEdition}...`);
    const { edition, articles } = await loadEditionArticles(congress);
    const trackLabels = buildTrackLabels(edition);
    const { deduped, excludedDuplicates } = dedupeArticles(articles);

    for (const duplicate of excludedDuplicates) {
      addLog({
        ano: congress.year,
        edicao: congress.shortEdition,
        titulo: getTitle(duplicate),
        url: getArticleLink(duplicate),
        motivo: "duplicado",
        detalhes: "Registro repetido por título normalizado, DOI ou slug.",
      });
    }

    console.error(`[${congress.year}] ${deduped.length} registros únicos. Carregando metadados detalhados...`);
    const details = await enrichWithArticleDetails(deduped, Number(options.concurrency || 6));

    for (const article of details) {
      if (!isCompleteArticle(article)) {
        addLog({
          ano: congress.year,
          edicao: congress.shortEdition,
          titulo: getTitle(article),
          url: getArticleLink(article),
          motivo: "html_nao_padronizado",
          detalhes: incompleteReason(article),
        });
        continue;
      }

      const record = buildArticleRecord(congress, article, trackLabels);
      applyMetadataFilter(record);

      if (!record.filtro1Selecionado) {
        record.motivoExclusao = "fora_do_escopo_filtro1";
        addLog({
          ano: record.ano,
          edicao: record.edicao,
          titulo: record.titulo,
          url: record.articleUrl,
          motivo: "fora_do_escopo_filtro1",
          detalhes: "Nenhum conceito encontrado em título, resumo, abstract, palavras-chave ou keywords.",
        });
      } else if (!record.pdfUrl) {
        record.motivoExclusao = "sem_pdf";
        addLog({
          ano: record.ano,
          edicao: record.edicao,
          titulo: record.titulo,
          url: record.articleUrl,
          motivo: "sem_pdf",
          detalhes: "Artigo selecionado no Filtro 1, mas sem arquivo PDF disponível no payload.",
        });
      }

      records.push(record);
    }

    const selected = records.filter((record) => record.ano === congress.year && record.filtro1Selecionado).length;
    console.error(`[${congress.year}] Filtro 1 selecionou ${selected} artigo(s).`);
  }

  const selectedForPdf = records.filter((record) => record.filtro1Selecionado && record.pdfUrl);
  if (options.skipPdf) {
    console.error("\nFiltro 2 ignorado por --skip-pdf.");
  } else {
    console.error(`\nProcessando Filtro 2 em ${selectedForPdf.length} PDF(s)...`);
    await runLimited(selectedForPdf, Number(options.pdfConcurrency || 2), async (record, index) => {
      console.error(`[PDF ${index + 1}/${selectedForPdf.length}] ${record.ano} - ${record.titulo}`);
      await processPdfRecord(record);
    });
  }

  writeOutputs(records, selectedCongresses);
  console.error(`\nPronto. Resultados gravados em: ${outputRoot}`);
}

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--out-dir") parsed.outDir = args[++i];
    else if (arg === "--cache-dir") parsed.cacheDir = args[++i];
    else if (arg === "--concurrency") parsed.concurrency = args[++i];
    else if (arg === "--pdf-concurrency") parsed.pdfConcurrency = args[++i];
    else if (arg === "--delay-ms") parsed.delayMs = Number(args[++i]);
    else if (arg === "--years") parsed.years = args[++i];
    else if (arg === "--all-editions") parsed.allEditions = true;
    else if (arg === "--refresh-cache") parsed.refreshCache = true;
    else if (arg === "--skip-pdf") parsed.skipPdf = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Uso:
  node ped_design_busca.js [opções]

Opções:
  --out-dir <pasta>         Pasta de saída. Padrão: ${DEFAULT_OUTPUT_DIR}
  --cache-dir <pasta>       Cache de HTML/JSON. Padrão: data/raw_cache dentro da saída
  --years <lista>           Anos separados por vírgula. Padrão: 2016,2018,2022,2024
  --all-editions            Processa 2010, 2012, 2014, 2016, 2018, 2022 e 2024
  --concurrency <n>         Requisições simultâneas para metadados. Padrão: 6
  --pdf-concurrency <n>     PDFs simultâneos no Filtro 2. Padrão: 2
  --delay-ms <n>            Pausa entre requisições sem cache. Padrão: 250
  --refresh-cache           Baixa HTML/JSON novamente, ignorando cache
  --skip-pdf                Gera apenas Filtro 1 e tabelas de metadados
`);
}

function selectCongresses() {
  if (options.allEditions) return ALL_CONGRESSES;
  const years = options.years
    ? options.years.split(",").map((item) => Number(item.trim())).filter(Boolean)
    : DEFAULT_YEARS;
  return ALL_CONGRESSES.filter((congress) => years.includes(congress.year));
}

async function loadNuxtPayload(pageUrl, cacheFile) {
  const payloadUrl = `${pageUrl.replace(/\/$/, "")}/_payload.json`;
  const json = await fetchCachedText(payloadUrl, cacheFile);
  return reviveNuxtPayload(JSON.parse(json));
}

async function loadEditionArticles(congress) {
  const externalPayload = await loadNuxtPayload(congress.url, cacheName(`edition-${congress.year}.json`));
  let best = extractEditionArticles(externalPayload);

  const html = await fetchCachedText(congress.url, cacheName(`edition-${congress.year}.html`));
  const embeddedPayload = extractEmbeddedNuxtPayload(html);
  if (embeddedPayload) {
    const embedded = extractEditionArticles(embeddedPayload);
    if (embedded.articles.length > best.articles.length) {
      best = {
        edition: embedded.edition || best.edition,
        articles: embedded.articles,
      };
    }
  }

  return best;
}

function extractEmbeddedNuxtPayload(html) {
  const match = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  return reviveNuxtPayload(JSON.parse(match[1]));
}

async function fetchCachedText(url, cacheFile) {
  const filePath = path.join(cacheDir, cacheFile);
  if (!options.refreshCache && fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf8");
  }
  await sleepBetweenRequests();
  const body = await requestText(url);
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, body, "utf8");
  return body;
}

function requestText(url, redirects = 0) {
  return requestBuffer(url, redirects).then((buffer) => buffer.toString("utf8"));
}

function requestBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const req = client.get(
      url,
      {
        headers: {
          "user-agent": "Mozilla/5.0 ped-design-rbs-script/2.0",
          accept: "application/json,text/html,application/pdf,*/*",
        },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirects > 8) reject(new Error(`Redirecionamentos demais: ${url}`));
          else resolve(requestBuffer(new URL(res.headers.location, url).toString(), redirects + 1));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} em ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      },
    );
    req.setTimeout(30000, () => {
      req.destroy(new Error(`Timeout em ${url}`));
    });
    req.on("error", reject);
  });
}

function reviveNuxtPayload(payload) {
  function reviveIndex(index, seen) {
    if (index === -1) return undefined;
    if (seen.has(index)) return seen.get(index);

    const value = payload[index];
    if (Array.isArray(value)) {
      const marker = value[0];
      if (typeof marker === "string" && ["ShallowReactive", "Reactive", "Ref"].includes(marker)) {
        return reviveIndex(value[1], seen);
      }
      if (marker === "Set") {
        return new Set(value.slice(1).map((item) => reviveAny(item, seen)));
      }
      const array = [];
      seen.set(index, array);
      value.forEach((item) => array.push(reviveAny(item, seen)));
      return array;
    }

    if (value && typeof value === "object") {
      const object = {};
      seen.set(index, object);
      Object.entries(value).forEach(([key, item]) => {
        object[key] = reviveAny(item, seen);
      });
      return object;
    }

    return value;
  }

  function reviveAny(value, seen) {
    return typeof value === "number" ? reviveIndex(value, seen) : value;
  }

  return reviveIndex(0, new Map());
}

function extractEditionArticles(payload) {
  const data = payload && payload.data ? payload.data : {};
  const editionKey = Object.keys(data).find((key) => key.startsWith("edition-"));
  const articlesKey = Object.keys(data).find((key) => key.startsWith("articles-"));
  const articlesBlock = articlesKey ? data[articlesKey] : null;

  const piniaArticles = payload
    && payload.pinia
    && payload.pinia.editions
    && payload.pinia.editions.articles;
  const piniaBlocks = piniaArticles && typeof piniaArticles === "object"
    ? Object.values(piniaArticles).filter(Array.isArray)
    : [];
  const bestPiniaBlock = piniaBlocks.sort((a, b) => b.length - a.length)[0];

  const articles = bestPiniaBlock
    && (!articlesBlock || bestPiniaBlock.length > (articlesBlock.articles || []).length)
    ? bestPiniaBlock
    : articlesBlock && articlesBlock.articles;

  if (!Array.isArray(articles)) {
    throw new Error("Não encontrei a lista de artigos no payload da edição.");
  }

  const piniaEdition = findPiniaEdition(payload, articles[0] && articles[0].parent);

  return {
    edition: editionKey ? data[editionKey].edition || data[editionKey] : piniaEdition,
    articles,
  };
}

function findPiniaEdition(payload, editionId) {
  const editions = payload
    && payload.pinia
    && payload.pinia.editions
    && payload.pinia.editions.list;
  if (!Array.isArray(editions) || !editionId) return null;
  return editions.find((edition) => edition && edition._id === editionId) || null;
}

function dedupeArticles(articles) {
  const seen = new Set();
  const deduped = [];
  const excludedDuplicates = [];
  for (const article of articles) {
    const key = normalizeText(getTitle(article))
      || normalizeText(article.typeData && article.typeData.doi)
      || normalizeText(article.slug || article._id);
    if (seen.has(key)) {
      excludedDuplicates.push(article);
      continue;
    }
    seen.add(key);
    deduped.push(article);
  }
  return { deduped, excludedDuplicates };
}

async function enrichWithArticleDetails(articles, concurrency) {
  const enriched = new Array(articles.length);
  let cursor = 0;

  async function worker() {
    while (cursor < articles.length) {
      const index = cursor;
      cursor += 1;
      const article = articles[index];
      enriched[index] = await loadArticleDetail(article).catch((error) => {
        console.error(`  Aviso: falha ao buscar detalhe de "${getTitle(article)}": ${error.message}`);
        return {
          ...article,
          detailError: error.message,
        };
      });
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  return enriched;
}

async function loadArticleDetail(article) {
  if (!article.slug) return article;
  const url = `${BASE_URL}/articles/${encodeURIComponent(article.slug)}`;
  const payload = await loadNuxtPayload(url, cacheName(`article-${article.slug}.json`));
  const data = payload && payload.data ? payload.data : {};
  const detailKey = Object.keys(data).find((key) => key === article.slug);
  const block = detailKey ? data[detailKey] : null;
  return block && block.article ? mergeArticle(article, block.article) : article;
}

function mergeArticle(listArticle, detailArticle) {
  return {
    ...listArticle,
    ...detailArticle,
    contributors: detailArticle.contributors || listArticle.contributors,
    typeData: { ...(listArticle.typeData || {}), ...(detailArticle.typeData || {}) },
    data: { ...(listArticle.data || {}), ...(detailArticle.data || {}) },
  };
}

function isCompleteArticle(article) {
  const title = getTitle(article);
  const start = article.typeData && article.typeData.startPage;
  const end = article.typeData && article.typeData.endPage;
  const doi = article.typeData && article.typeData.doi;
  const hasFile = article.typeData && article.typeData.has_file;
  return Boolean(title && (hasFile || doi || (Number.isFinite(Number(start)) && Number.isFinite(Number(end)))));
}

function incompleteReason(article) {
  const reasons = [];
  if (!getTitle(article)) reasons.push("sem título");
  const start = article.typeData && article.typeData.startPage;
  const end = article.typeData && article.typeData.endPage;
  const doi = article.typeData && article.typeData.doi;
  const hasFile = article.typeData && article.typeData.has_file;
  if (!hasFile && !doi && !(Number.isFinite(Number(start)) && Number.isFinite(Number(end)))) {
    reasons.push("sem PDF, DOI ou intervalo de páginas");
  }
  if (article.detailError) reasons.push(`falha nos metadados detalhados: ${article.detailError}`);
  return reasons.length > 0 ? reasons.join("; ") : "sem metadados mínimos de artigo completo";
}

function buildArticleRecord(congress, article, trackLabels) {
  const palavrasChave = splitKeywords(getKeywordsByRole(article, "primary"));
  const keywords = splitKeywords(getKeywordsByRole(article, "secondary"));
  const pages = formatPages(article);
  const occurrences = emptyOccurrences();
  return {
    edicao: congress.shortEdition,
    edicaoCompleta: congress.edition,
    ano: congress.year,
    tema: getTrackLabel(article, trackLabels),
    titulo: getTitle(article),
    tituloSecundario: getSecondaryTitle(article),
    autores: formatAuthors(article.contributors || []),
    resumo: getExcerptByRole(article, "primary"),
    abstract: getExcerptByRole(article, "secondary"),
    palavrasChave,
    keywords,
    articleUrl: getArticleLink(article),
    pdfUrl: getPdfApiUrl(article),
    pdfUrlFinal: "",
    pdfLocalPath: "",
    filtro1Selecionado: false,
    filtro2Selecionado: false,
    filtro2Categoria: "",
    secoesIdentificadas: "",
    conceitosEncontrados: [],
    locaisEncontrados: [],
    ocorrencias: occurrences,
    occurrences,
    motivoExclusao: "",
    detalhesExclusao: "",
    doi: article.typeData && article.typeData.doi || "",
    paginas: pages,
    articleId: article._id || "",
    slug: article.slug || "",
    detailError: article.detailError || "",
  };
}

function applyMetadataFilter(record) {
  const fields = {
    titulo: record.titulo,
    resumo: record.resumo,
    abstract: record.abstract,
    palavrasChave: record.palavrasChave.join("; "),
    keywords: record.keywords.join("; "),
  };
  const result = collectOccurrences(fields);
  mergeOccurrenceResult(record, result);
  record.filtro1Selecionado = result.concepts.length > 0;
}

async function processPdfRecord(record) {
  try {
    const pdfPath = await downloadPdf(record);
    record.pdfLocalPath = pdfPath;

    const text = await extractPdfText(pdfPath);
    const cleanText = cleanupPdfText(text);
    if (!normalizeText(cleanText)) {
      record.filtro2Categoria = "erro_pdf";
      record.motivoExclusao = record.motivoExclusao || "erro_pdf";
      addLog({
        ano: record.ano,
        edicao: record.edicao,
        titulo: record.titulo,
        url: record.articleUrl,
        motivo: "erro_pdf",
        detalhes: "Texto extraído do PDF vazio ou ilegível.",
      });
      return;
    }

    const sections = extractSections(cleanText);
    const sectionFields = {
      introducao: sections.introducao,
      consideracoesFinais: sections.consideracoesFinais,
      corpo: cleanText,
    };
    const result = collectOccurrences(sectionFields);
    mergeOccurrenceResult(record, result);

    const introHits = sumOccurrencesForField(record.occurrences, "introducao");
    const conclusionHits = sumOccurrencesForField(record.occurrences, "consideracoesFinais");
    const bodyHits = sumOccurrencesForField(record.occurrences, "corpo");
    const sectionStatus = [
      sections.introducaoEncontrada ? "introducao" : "introducao_nao_identificada",
      sections.conclusaoEncontrada ? "conclusao" : "conclusao_nao_identificada",
    ];
    record.secoesIdentificadas = sectionStatus.join("; ");

    if (introHits > 0 && conclusionHits > 0) {
      record.filtro2Categoria = "introducao_e_conclusao";
      record.filtro2Selecionado = true;
    } else if (introHits > 0) {
      record.filtro2Categoria = "somente_introducao";
      record.filtro2Selecionado = true;
    } else if (conclusionHits > 0) {
      record.filtro2Categoria = "somente_conclusao";
      record.filtro2Selecionado = true;
    } else if (!sections.introducaoEncontrada || !sections.conclusaoEncontrada) {
      record.filtro2Categoria = "secao_nao_identificada";
    } else if (bodyHits > 0) {
      record.filtro2Categoria = "outras_partes";
    } else {
      record.filtro2Categoria = "nao_encontrado_pdf";
    }

    if (record.filtro2Selecionado) {
      copyPdfToFiltro3(record);
    } else {
      const reason = record.filtro2Categoria === "secao_nao_identificada"
        ? "secao_nao_identificada"
        : "fora_do_escopo_filtro2";
      record.motivoExclusao = record.motivoExclusao || reason;
      addLog({
        ano: record.ano,
        edicao: record.edicao,
        titulo: record.titulo,
        url: record.articleUrl,
        motivo: reason,
        detalhes: `Categoria Filtro 2: ${record.filtro2Categoria}`,
      });
    }
  } catch (error) {
    record.filtro2Categoria = "erro_pdf";
    record.motivoExclusao = record.motivoExclusao || "erro_pdf";
    record.detalhesExclusao = error.message;
    addLog({
      ano: record.ano,
      edicao: record.edicao,
      titulo: record.titulo,
      url: record.articleUrl || record.pdfUrl,
      motivo: error.message && error.message.includes("download") ? "erro_download" : "erro_pdf",
      detalhes: error.message,
    });
  }
}

async function downloadPdf(record) {
  const yearDir = path.join(filtro2Dir, String(record.ano));
  ensureDirectory(yearDir);
  const filename = `${record.ano}_${record.edicao.replace(/[^\d]+/g, "")}pd_${slugify(record.titulo || record.slug || record.articleId)}.pdf`;
  const pdfPath = path.join(yearDir, filename);
  if (fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 1024) {
    return pdfPath;
  }

  await sleepBetweenRequests();
  const finalUrl = await resolvePdfDownloadUrl(record.pdfUrl);
  record.pdfUrlFinal = finalUrl;
  await sleepBetweenRequests();
  let buffer = await requestBuffer(finalUrl);
  if (!buffer.slice(0, 5).equals(Buffer.from("%PDF-"))) {
    const alternateUrl = extractPdfUrlFromHtml(buffer.toString("utf8"), finalUrl);
    if (alternateUrl) {
      record.pdfUrlFinal = alternateUrl;
      await sleepBetweenRequests();
      buffer = await requestBuffer(alternateUrl);
    }
  }
  if (!buffer.slice(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error(`erro_download: resposta não parece PDF para ${record.titulo}`);
  }
  fs.writeFileSync(pdfPath, buffer);
  return pdfPath;
}

async function resolvePdfDownloadUrl(apiUrl) {
  const body = await requestText(apiUrl);
  const parsed = JSON.parse(body);
  if (!parsed.file) throw new Error(`erro_download: API sem campo file em ${apiUrl}`);
  return parsed.file;
}

function extractPdfUrlFromHtml(html, baseUrl) {
  const candidates = [
    /<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["']/i,
    /<a[^>]+id=["']pdfDownloadLink["'][^>]+href=["']([^"']+)["']/i,
    /<a[^>]+href=["']([^"']+\.pdf[^"']*)["']/i,
  ];
  for (const pattern of candidates) {
    const match = String(html || "").match(pattern);
    if (match && match[1]) {
      return new URL(decodeHtmlEntities(match[1]), baseUrl).toString();
    }
  }
  return "";
}

function copyPdfToFiltro3(record) {
  if (!record.pdfLocalPath || !fs.existsSync(record.pdfLocalPath)) return;
  const targetDir = path.join(filtro3Dir, String(record.ano));
  ensureDirectory(targetDir);
  const target = path.join(targetDir, path.basename(record.pdfLocalPath));
  if (!fs.existsSync(target)) fs.copyFileSync(record.pdfLocalPath, target);
}

async function extractPdfText(pdfPath) {
  const helperText = extractPdfTextWithPdfjs(pdfPath);
  if (helperText && normalizeText(helperText).length > 20) return helperText;
  return extractPdfTextNaive(pdfPath);
}

function extractPdfTextWithPdfjs(pdfPath) {
  if (!fs.existsSync(BUNDLED_NODE) || !fs.existsSync(BUNDLED_PDFJS)) return "";
  const helperPath = ensurePdfHelper();
  const result = spawnSync(BUNDLED_NODE, [helperPath, pdfPath, BUNDLED_PDFJS], {
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024,
  });
  if (result.status !== 0) return "";
  return result.stdout || "";
}

function ensurePdfHelper() {
  const helperPath = path.join(cacheDir, "pdf_text_helper.mjs");
  if (fs.existsSync(helperPath)) return helperPath;
  const code = `import fs from "node:fs";
import { pathToFileURL } from "node:url";

const pdfPath = process.argv[2];
const pdfjsPath = process.argv[3];
const pdfjs = await import(pathToFileURL(pdfjsPath).href);
const data = new Uint8Array(fs.readFileSync(pdfPath));
const loadingTask = pdfjs.getDocument({ data, disableWorker: true, useSystemFonts: true });
const pdf = await loadingTask.promise;
const pages = [];

for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  const lines = [];
  let current = [];
  let lastY = null;
  for (const item of content.items) {
    const text = String(item.str || "");
    if (!text.trim()) continue;
    const transform = item.transform || [];
    const y = Math.round(transform[5] || 0);
    if (lastY !== null && Math.abs(y - lastY) > 2 && current.length > 0) {
      lines.push(current.join(" "));
      current = [];
    }
    current.push(text);
    lastY = y;
  }
  if (current.length > 0) lines.push(current.join(" "));
  pages.push(lines.join("\\n"));
}

process.stdout.write(pages.join("\\n\\n"));
`;
  fs.writeFileSync(helperPath, code, "utf8");
  return helperPath;
}

function extractPdfTextNaive(pdfPath) {
  const buffer = fs.readFileSync(pdfPath);
  const chunks = [buffer.toString("latin1")];
  const raw = buffer.toString("binary");
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;
  while ((match = streamRegex.exec(raw))) {
    const stream = Buffer.from(match[1], "binary");
    for (const inflate of [zlib.inflateSync, zlib.inflateRawSync]) {
      try {
        chunks.push(inflate(stream).toString("utf8"));
        break;
      } catch (_) {
        // Continua tentando outros formatos.
      }
    }
  }
  return decodePdfStrings(chunks.join("\n"));
}

function decodePdfStrings(raw) {
  const pieces = [];
  const literalRegex = /\((?:\\.|[^\\)])*\)\s*(?:Tj|'|"|TJ)/g;
  let literal;
  while ((literal = literalRegex.exec(raw))) {
    pieces.push(decodePdfLiteral(literal[0]));
  }
  const hexRegex = /<([0-9A-Fa-f\s]{4,})>\s*(?:Tj|'|"|TJ)/g;
  let hex;
  while ((hex = hexRegex.exec(raw))) {
    pieces.push(decodePdfHex(hex[1]));
  }
  return pieces.join(" ");
}

function decodePdfLiteral(value) {
  const inner = value.replace(/^\(/, "").replace(/\)\s*(?:Tj|'|"|TJ).*$/, "");
  return inner
    .replace(/\\([nrtbf()\\])/g, (_, token) => {
      const map = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
      return map[token] || token;
    })
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function decodePdfHex(value) {
  const hex = value.replace(/\s+/g, "");
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (Number.isFinite(byte)) bytes.push(byte);
  }
  const buffer = Buffer.from(bytes);
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return buffer.slice(2).toString("utf16le");
  return buffer.toString("utf8");
}

function extractSections(text) {
  const intro = findHeading(text, [
    /(?:^|\n)\s*(?:\d+(?:\.\d+)*\.?\s*)?introdu[cç][aã]o\s*(?:\n|$)/i,
    /(?:^|\n)\s*(?:\d+(?:\.\d+)*\.?\s*)?introduction\s*(?:\n|$)/i,
  ], 0);
  const conclusion = findHeading(text, [
    /(?:^|\n)\s*(?:\d+(?:\.\d+)*\.?\s*)?considera[cç][oõ]es finais\s*(?:\n|$)/i,
    /(?:^|\n)\s*(?:\d+(?:\.\d+)*\.?\s*)?conclus[aã]o\s*(?:\n|$)/i,
    /(?:^|\n)\s*(?:\d+(?:\.\d+)*\.?\s*)?conclus[oõ]es\s*(?:\n|$)/i,
    /(?:^|\n)\s*(?:\d+(?:\.\d+)*\.?\s*)?conclusion[s]?\s*(?:\n|$)/i,
    /(?:^|\n)\s*(?:\d+(?:\.\d+)*\.?\s*)?final considerations\s*(?:\n|$)/i,
  ], intro ? intro.end : 0);
  const references = findHeading(text, [
    /(?:^|\n)\s*(?:\d+(?:\.\d+)*\.?\s*)?refer[eê]ncias(?: bibliogr[aá]ficas)?\s*(?:\n|$)/i,
    /(?:^|\n)\s*(?:\d+(?:\.\d+)*\.?\s*)?references\s*(?:\n|$)/i,
    /(?:^|\n)\s*(?:\d+(?:\.\d+)*\.?\s*)?bibliografia\s*(?:\n|$)/i,
  ], conclusion ? conclusion.end : 0);

  const introducao = intro
    ? text.slice(intro.end, conclusion ? conclusion.index : Math.min(text.length, intro.end + 12000))
    : "";
  const consideracoesFinais = conclusion
    ? text.slice(conclusion.end, references ? references.index : text.length)
    : "";

  return {
    introducao,
    consideracoesFinais,
    introducaoEncontrada: Boolean(intro),
    conclusaoEncontrada: Boolean(conclusion),
  };
}

function findHeading(text, patterns, startIndex) {
  const slice = text.slice(startIndex);
  let best = null;
  for (const pattern of patterns) {
    const match = slice.match(pattern);
    if (!match) continue;
    const index = startIndex + match.index;
    const end = index + match[0].length;
    if (!best || index < best.index) best = { index, end };
  }
  return best;
}

function collectOccurrences(fields) {
  const occurrences = {};
  const concepts = new Set();
  const locals = new Set();

  for (const [field, value] of Object.entries(fields)) {
    occurrences[field] = {};
    const normalized = normalizeText(value);
    for (const concept of CONCEPTS) {
      const count = concept.phrases.reduce((sum, phrase) => sum + countPhrase(normalized, normalizeText(phrase)), 0);
      if (count > 0) {
        occurrences[field][concept.key] = count;
        concepts.add(concept.key);
        locals.add(field);
      }
    }
  }

  return {
    occurrences,
    concepts: Array.from(concepts),
    locals: Array.from(locals),
  };
}

function mergeOccurrenceResult(record, result) {
  for (const field of Object.keys(result.occurrences)) {
    record.occurrences[field] = {
      ...(record.occurrences[field] || {}),
      ...result.occurrences[field],
    };
  }
  record.conceitosEncontrados = unique([
    ...record.conceitosEncontrados,
    ...result.concepts.map(labelForConcept),
  ]);
  record.locaisEncontrados = unique([
    ...record.locaisEncontrados,
    ...result.locals.map(labelForLocation),
  ]);
}

function countPhrase(text, phrase) {
  if (!text || !phrase) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(phrase, index)) !== -1) {
    count += 1;
    index += phrase.length;
  }
  return count;
}

function sumOccurrencesForField(occurrences, field) {
  const data = occurrences && occurrences[field] ? occurrences[field] : {};
  return Object.values(data).reduce((sum, value) => sum + Number(value || 0), 0);
}

function sumOccurrencesForConcept(record, conceptKey, fields) {
  return fields.reduce((sum, field) => sum + Number(record.occurrences[field] && record.occurrences[field][conceptKey] || 0), 0);
}

function emptyOccurrences() {
  return Object.fromEntries(ALL_OCCURRENCE_FIELDS.map((field) => [field, {}]));
}

function writeOutputs(records, congresses) {
  ensureDirectory(dataDir);
  const completeRecords = records;
  const filter1Records = records.filter((record) => record.filtro1Selecionado);
  const filter2Records = filter1Records.filter((record) => record.pdfUrl);

  fs.writeFileSync(path.join(dataDir, "artigos_todos.json"), JSON.stringify(completeRecords, null, 2), "utf8");
  fs.writeFileSync(path.join(dataDir, "artigos_todos.csv"), toCsv(allArticlesRows(completeRecords)), "utf8");
  fs.writeFileSync(path.join(dataDir, "filtro1_artigos_selecionados.csv"), toCsv(filter1Rows(filter1Records)), "utf8");
  fs.writeFileSync(path.join(dataDir, "filtro2_analise_introducao_conclusao.csv"), toCsv(filter2Rows(filter2Records)), "utf8");
  fs.writeFileSync(path.join(dataDir, "resumo_por_ano.csv"), toCsv(summaryRows(completeRecords, congresses)), "utf8");
  fs.writeFileSync(path.join(dataDir, "ranking_palavras_chave.csv"), toCsv(rankingRows(filter1Records)), "utf8");
  fs.writeFileSync(path.join(dataDir, "ocorrencias_por_local.csv"), toCsv(occurrenceRows(filter1Records)), "utf8");
  fs.writeFileSync(path.join(dataDir, "quantidade_conceitos_por_artigo.csv"), toCsv(conceptsPerArticleRows(filter1Records)), "utf8");
  fs.writeFileSync(path.join(dataDir, "conceitos_por_ano_tema.csv"), toCsv(conceptsByYearThemeRows(filter1Records)), "utf8");
  fs.writeFileSync(path.join(dataDir, "log_exclusoes.csv"), toCsv(logs), "utf8");
  fs.writeFileSync(path.join(dataDir, "manifesto_execucao.json"), JSON.stringify(executionManifest(records, congresses), null, 2), "utf8");
  fs.writeFileSync(path.join(outputRoot, "README.md"), readmeText(records, congresses), "utf8");
}

function allArticlesRows(records) {
  return records.map((record) => ({
    "Edição do congresso": record.edicaoCompleta,
    "Ano": record.ano,
    "Tema": record.tema,
    "Título do artigo": record.titulo,
    "Autores": record.autores,
    "Resumo": record.resumo,
    "Abstract": record.abstract,
    "Palavras-chave": record.palavrasChave.join("; "),
    "Keywords": record.keywords.join("; "),
    "Link do artigo": record.articleUrl,
    "Link do PDF": record.pdfUrlFinal || record.pdfUrl,
  }));
}

function filter1Rows(records) {
  return records.map((record) => ({
    "Edição": record.edicao,
    "Ano": record.ano,
    "Tema": record.tema,
    "Título": record.titulo,
    "Autores": record.autores,
    "Palavra-chave/conceito encontrado": record.conceitosEncontrados.join("; "),
    "Local da ocorrência": record.locaisEncontrados.filter((local) => METADATA_FIELDS.map(labelForLocation).includes(local)).join("; "),
    "Número de ocorrências": sumRecordOccurrences(record, METADATA_FIELDS),
    "Link do artigo": record.articleUrl,
    "Link do PDF": record.pdfUrlFinal || record.pdfUrl,
    "Caminho local do PDF": record.pdfLocalPath,
  }));
}

function filter2Rows(records) {
  return records.map((record) => ({
    "Edição": record.edicao,
    "Ano": record.ano,
    "Tema": record.tema,
    "Título": record.titulo,
    "Autores": record.autores,
    "Categoria Filtro 2": record.filtro2Categoria || "",
    "Selecionado Filtro 2": record.filtro2Selecionado ? "sim" : "não",
    "Seções identificadas": record.secoesIdentificadas,
    "Conceitos encontrados": record.conceitosEncontrados.join("; "),
    "Ocorrências na introdução": sumOccurrencesForField(record.occurrences, "introducao"),
    "Ocorrências nas considerações finais/conclusão": sumOccurrencesForField(record.occurrences, "consideracoesFinais"),
    "Ocorrências no corpo do PDF": sumOccurrencesForField(record.occurrences, "corpo"),
    "Link do artigo": record.articleUrl,
    "Link do PDF": record.pdfUrlFinal || record.pdfUrl,
    "Caminho local do PDF": record.pdfLocalPath,
  }));
}

function summaryRows(records, congresses) {
  return congresses.map((congress) => {
    const yearRecords = records.filter((record) => record.ano === congress.year);
    const row = {
      "Edição": congress.shortEdition,
      "Ano": congress.year,
      "Total de artigos": yearRecords.length,
    };
    for (const concept of CONCEPTS) {
      row[concept.label] = yearRecords.filter((record) => sumOccurrencesForConcept(record, concept.key, METADATA_FIELDS) > 0).length;
    }
    return row;
  });
}

function rankingRows(records) {
  return CONCEPTS.map((concept) => ({
    "Palavra-chave/conceito": concept.label,
    "Número de artigos": records.filter((record) => sumOccurrencesForConcept(record, concept.key, ALL_OCCURRENCE_FIELDS) > 0).length,
    "Número de ocorrências": records.reduce((sum, record) => sum + sumOccurrencesForConcept(record, concept.key, ALL_OCCURRENCE_FIELDS), 0),
  }))
    .sort((a, b) => b["Número de artigos"] - a["Número de artigos"] || b["Número de ocorrências"] - a["Número de ocorrências"])
    .map((row, index) => ({ "Posição": index + 1, ...row }));
}

function occurrenceRows(records) {
  const rows = [];
  for (const record of records) {
    for (const field of ALL_OCCURRENCE_FIELDS) {
      for (const concept of CONCEPTS) {
        const count = record.occurrences[field] && record.occurrences[field][concept.key] || 0;
        if (count > 0) {
          rows.push({
            "Edição": record.edicao,
            "Ano": record.ano,
            "Tema": record.tema,
            "Título": record.titulo,
            "Autores": record.autores,
            "Palavra-chave/conceito": concept.label,
            "Local onde foi encontrada": labelForLocation(field),
            "Quantidade de citações": count,
          });
        }
      }
    }
  }
  return rows;
}

function conceptsPerArticleRows(records) {
  return records.map((record) => {
    const concepts = CONCEPTS.filter((concept) => sumOccurrencesForConcept(record, concept.key, ALL_OCCURRENCE_FIELDS) > 0);
    const count = concepts.length;
    return {
      "Edição": record.edicao,
      "Ano": record.ano,
      "Título": record.titulo,
      "1 conceito": count === 1 ? 1 : 0,
      "2 conceitos": count === 2 ? 1 : 0,
      "3 conceitos": count === 3 ? 1 : 0,
      "4 conceitos": count === 4 ? 1 : 0,
      "Conceitos encontrados": concepts.map((concept) => concept.label).join("; "),
    };
  });
}

function conceptsByYearThemeRows(records) {
  const grouped = new Map();
  for (const record of records) {
    for (const concept of CONCEPTS) {
      if (sumOccurrencesForConcept(record, concept.key, ALL_OCCURRENCE_FIELDS) === 0) continue;
      const key = [record.ano, record.tema || "Sem tema informado", concept.label].join("||");
      if (!grouped.has(key)) {
        grouped.set(key, {
          "Ano do congresso": record.ano,
          "Tema do congresso": record.tema || "Sem tema informado",
          "Palavra-chave/conceito": concept.label,
          "Número de artigos": 0,
        });
      }
      grouped.get(key)["Número de artigos"] += 1;
    }
  }
  return Array.from(grouped.values()).sort((a, b) => a["Ano do congresso"] - b["Ano do congresso"]);
}

function executionManifest(records, congresses) {
  return {
    createdAt: new Date().toISOString(),
    methodology: "Revisão Bibliográfica Sistemática com Filtro 1 em metadados e Filtro 2 em introdução/conclusão dos PDFs.",
    congresses,
    concepts: CONCEPTS,
    totals: {
      articles: records.length,
      filtro1: records.filter((record) => record.filtro1Selecionado).length,
      filtro2: records.filter((record) => record.filtro2Selecionado).length,
      logs: logs.length,
    },
    outputRoot,
  };
}

function readmeText(records, congresses) {
  const lines = [];
  lines.push("# Revisão sistemática P&D Design");
  lines.push("");
  lines.push("Este script operacionaliza uma Revisão Bibliográfica Sistemática sobre os conceitos de linguagem simples, linguagem visual, design da informação e visualização da informação nos anais do P&D Design.");
  lines.push("");
  lines.push("O processo segue dois filtros principais: o primeiro verifica título, resumo, abstract e palavras-chave; o segundo analisa a introdução e as considerações finais/conclusão dos PDFs selecionados. Português e inglês são tratados como equivalentes conceituais. Os resultados são exportados em CSV e JSON, preservando critérios de inclusão, exclusão, rastreabilidade e replicabilidade.");
  lines.push("");
  lines.push("## Resumo");
  lines.push("");
  lines.push(toMarkdownTable(summaryRows(records, congresses)));
  lines.push("");
  lines.push("## Arquivos");
  lines.push("");
  lines.push("- `data/artigos_todos.csv`");
  lines.push("- `data/filtro1_artigos_selecionados.csv`");
  lines.push("- `data/filtro2_analise_introducao_conclusao.csv`");
  lines.push("- `data/resumo_por_ano.csv`");
  lines.push("- `data/ranking_palavras_chave.csv`");
  lines.push("- `data/ocorrencias_por_local.csv`");
  lines.push("- `data/quantidade_conceitos_por_artigo.csv`");
  lines.push("- `data/conceitos_por_ano_tema.csv`");
  lines.push("- `data/log_exclusoes.csv`");
  lines.push("- `filtro2/<ano>/`: PDFs selecionados no Filtro 1");
  lines.push("- `filtro2/filtro3/<ano>/`: PDFs aprovados no Filtro 2 para leitura completa/manual");
  return `${lines.join("\n")}\n`;
}

function sumRecordOccurrences(record, fields) {
  return fields.reduce((sum, field) => sum + sumOccurrencesForField(record.occurrences, field), 0);
}

function toMarkdownTable(rows) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${headers.map((header) => String(row[header] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`),
  ].join("\n");
}

function toCsv(rows) {
  if (!rows || rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvEscape(value) {
  const text = value === undefined || value === null ? "" : Array.isArray(value) ? value.join("; ") : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function addLog({ ano, edicao, titulo, url, motivo, detalhes }) {
  logs.push({
    "Ano": ano || "",
    "Edição": edicao || "",
    "Título": titulo || "",
    "URL": url || "",
    "Motivo": motivo || "",
    "Detalhes": detalhes || "",
  });
}

function getArticleData(article, role) {
  const data = article.data || {};
  if (data[role]) return data[role];
  if (role === "primary") return data.pt || data.primary || data[article.langs && article.langs[0]] || data.title && data || {};
  if (role === "secondary") return data.en || data.secondary || data[article.langs && article.langs[1]] || {};
  return {};
}

function getTitle(article) {
  const primary = getArticleData(article, "primary");
  return stripHtml(primary.title || article.data && article.data.title || "");
}

function getSecondaryTitle(article) {
  return stripHtml(getArticleData(article, "secondary").title || "");
}

function getExcerptByRole(article, role) {
  return stripHtml(getArticleData(article, role).excerpt || "");
}

function getKeywordsByRole(article, role) {
  return stripHtml(getArticleData(article, role).keywords || "");
}

function splitKeywords(value) {
  return stripHtml(value)
    .split(/;|,|\|/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getArticleLink(article) {
  return article.slug ? `${BASE_URL}/articles/${article.slug}/` : "";
}

function getPdfApiUrl(article) {
  if (!(article.typeData && article.typeData.has_file) || !article._id) return "";
  return `${BASE_URL}/api/articles/download?id=${encodeURIComponent(article._id)}`;
}

function buildTrackLabels(edition) {
  const labels = new Map();
  const candidates = [
    edition && edition.typeData && edition.typeData.tracks,
    edition && edition.tracks,
  ];

  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const id = value.id || value._id;
    const label = getLocalizedLabel(value);
    if (id && label) labels.set(String(id), label);
    Object.values(value).forEach(visit);
  }

  candidates.forEach(visit);
  return labels;
}

function getLocalizedLabel(value) {
  if (!value || typeof value !== "object") return "";
  if (value.label) return stripHtml(value.label);
  const langs = value.langs || value.data;
  if (!langs || typeof langs !== "object") return "";
  const localized = langs.pt || langs.primary || langs.en || langs.secondary;
  return localized && localized.label ? stripHtml(localized.label) : "";
}

function getTrackLabel(article, trackLabels) {
  const track = article.typeData && article.typeData.track;
  if (!track) return "";
  return trackLabels.get(String(track)) || String(track);
}

function formatAuthors(contributors) {
  return contributors
    .map((author) => [author.name, author.lastName].filter(Boolean).join(" ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("; ");
}

function formatPages(article) {
  const start = article.typeData && article.typeData.startPage;
  const end = article.typeData && article.typeData.endPage;
  if (!start && !end) return "";
  return start === end ? String(start) : `${start}-${end}`;
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value || ""))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function cleanupPdfText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/-\s*\n\s*/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeText(text) {
  return stripHtml(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value) {
  const slug = normalizeText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return slug || "artigo";
}

function labelForConcept(key) {
  const concept = CONCEPTS.find((item) => item.key === key);
  return concept ? concept.label : key;
}

function labelForLocation(key) {
  const labels = {
    titulo: "titulo",
    resumo: "resumo",
    abstract: "abstract",
    palavrasChave: "palavras-chave",
    keywords: "keywords",
    introducao: "introducao",
    consideracoesFinais: "consideracoes_finais",
    corpo: "corpo_do_artigo",
  };
  return labels[key] || key;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cacheName(name) {
  return name.replace(/[^a-z0-9._-]+/gi, "_");
}

function sleepBetweenRequests() {
  const delay = Number.isFinite(options.delayMs) ? options.delayMs : 250;
  return delay > 0 ? new Promise((resolve) => setTimeout(resolve, delay)) : Promise.resolve();
}

async function runLimited(items, concurrency, fn) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
}
