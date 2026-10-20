import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

async function getRuntime() {
    try {
        const { Actor } = await import('apify');
        await Actor.init();
        return {
            isApify: true,
            getInput: async () => (await Actor.getInput()) || {},
            pushData: async (item) => {
                try {
                    await Actor.pushData(item, 'page-converted');
                } catch {
                    await Actor.pushData(item);
                }
            },
            charge: async (eventName, count = 1) => {
                if (typeof Actor.charge === 'function') {
                    try {
                        await Actor.charge({ eventName, count });
                    } catch {
                        // Ignore outside PPE billing
                    }
                }
            },
            exit: async () => Actor.exit(),
        };
    } catch {
        const inputPath = path.resolve(process.cwd(), 'INPUT.json');
        const localInput = fs.existsSync(inputPath)
            ? JSON.parse(fs.readFileSync(inputPath, 'utf8'))
            : {
                  startUrls: ['https://docs.apify.com/platform/actors'],
                  maxPages: 1,
                  chunkSizeTokens: 512,
              };
        const outDir = path.resolve(process.cwd(), 'storage', 'datasets', 'default');
        fs.mkdirSync(outDir, { recursive: true });
        let counter = 1;
        return {
            isApify: false,
            getInput: async () => localInput,
            pushData: async (item) => {
                const file = path.join(outDir, `${String(counter++).padStart(9, '0')}.json`);
                fs.writeFileSync(file, JSON.stringify(item, null, 2), 'utf8');
            },
            charge: async () => {},
            exit: async () => {},
        };
    }
}

function htmlToCleanMarkdown(html) {
    let cleaned = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<svg[\s\S]*?<\/svg>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '');

    const mainMatch =
        cleaned.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
        cleaned.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (mainMatch) {
        cleaned = mainMatch[1];
    }

    cleaned = cleaned
        .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
        .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
        .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
        .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n')
        .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n')
        .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
        .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
        .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\u2014/g, '-')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return cleaned;
}

function buildSemanticChunks(markdown, maxTokensPerChunk = 512) {
    const paragraphs = markdown.split(/\n\n+/);
    const chunks = [];
    let currentText = '';
    let currentTokens = 0;

    for (const para of paragraphs) {
        const paraTokens = Math.ceil(para.length / 4);
        if (currentTokens + paraTokens > maxTokensPerChunk && currentText) {
            chunks.push({
                chunkIndex: chunks.length,
                estimatedTokens: currentTokens,
                content: currentText.trim(),
            });
            currentText = para;
            currentTokens = paraTokens;
        } else {
            currentText = currentText ? `${currentText}\n\n${para}` : para;
            currentTokens += paraTokens;
        }
    }

    if (currentText.trim()) {
        chunks.push({
            chunkIndex: chunks.length,
            estimatedTokens: currentTokens,
            content: currentText.trim(),
        });
    }

    return chunks;
}

function extractSameDomainLinks(html, baseUrl, maxCount = 5) {
    const found = new Set();
    const hrefRegex = /href=["']([^"'#]+)["']/gi;
    let match;
    const baseParsed = new URL(baseUrl);
    while ((match = hrefRegex.exec(html)) !== null) {
        if (found.size >= maxCount) break;
        try {
            const resolved = new URL(match[1], baseUrl);
            if (
                resolved.hostname === baseParsed.hostname &&
                resolved.href !== baseUrl &&
                !resolved.pathname.match(/\.(png|jpg|jpeg|gif|svg|css|js|pdf|zip)$/i)
            ) {
                found.add(resolved.href);
            }
        } catch {
            // Skip invalid URL
        }
    }
    return Array.from(found);
}

async function run() {
    const runtime = await getRuntime();
    const input = await runtime.getInput();

    const startUrls =
        Array.isArray(input.startUrls) && input.startUrls.length > 0
            ? input.startUrls
            : ['https://docs.apify.com/platform/actors'];
    const maxPages = Number(input.maxPages) || 3;
    const chunkSizeTokens = Number(input.chunkSizeTokens) || 512;

    const queue = [...startUrls];
    const visited = new Set();

    console.log(`[AI-Markdown-Crawler] Crawling up to ${maxPages} page(s) into LLM Markdown...`);

    while (queue.length > 0 && visited.size < maxPages) {
        const currentUrl = queue.shift();
        if (!currentUrl || visited.has(currentUrl)) continue;
        visited.add(currentUrl);

        try {
            const res = await fetch(currentUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; ApifyAIMarkdownCrawler/1.0)',
                    Accept: 'text/html,application/xhtml+xml',
                },
            });
            const html = await res.text();
            const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            const title = titleMatch
                ? titleMatch[1].replace(/\s+/g, ' ').replace(/\u2014/g, '-').trim()
                : currentUrl;

            const markdown = htmlToCleanMarkdown(html);
            const words = markdown.split(/\s+/).filter(Boolean).length;
            const estimatedTokens = Math.ceil(markdown.length / 4);
            const ragChunks = buildSemanticChunks(markdown, chunkSizeTokens);

            if (visited.size + queue.length < maxPages) {
                const discovered = extractSameDomainLinks(html, currentUrl, maxPages - visited.size);
                for (const nextLink of discovered) {
                    if (!visited.has(nextLink) && !queue.includes(nextLink)) {
                        queue.push(nextLink);
                    }
                }
            }

            const record = {
                url: currentUrl,
                title,
                wordCount: words,
                estimatedTokens,
                chunksCount: ragChunks.length,
                markdown,
                ragChunks,
                crawledAt: new Date().toISOString(),
            };

            await runtime.pushData(record);
            await runtime.charge('page-converted', 1);
            console.log(
                `[AI-Markdown-Crawler] Converted ${currentUrl} | Tokens: ~${estimatedTokens} | Chunks: ${ragChunks.length}`
            );
        } catch (err) {
            console.error(`[AI-Markdown-Crawler] Failed on ${currentUrl}: ${err.message}`);
        }
    }

    await runtime.exit();
}

run();
