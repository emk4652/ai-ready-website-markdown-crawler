# AI-Ready Website to Clean Markdown & RAG Chunk Crawler

Converts documentation portals, corporate websites, and help centers into clean Markdown stripped of navigation noise, scripts, and trackers, with automatic token estimation and semantic chunking for RAG pipelines (Pinecone, Qdrant, Weaviate, LangChain, LlamaIndex).

## Core Capabilities

- **Semantic Main-Content Extraction**: Isolates `<main>` and `<article>` content while stripping `<nav>`, `<footer>`, `<script>`, and SVG clutter.
- **Deterministic RAG Chunking**: Splits long documents into token-bounded semantic chunks (`chunkSizeTokens`, default `512` tokens) ready for embedding models.
- **Internal Link Discovery**: Crawls up to `maxPages` internal documentation links within the target domain.

## Input Example

```json
{
  "startUrls": ["https://docs.apify.com/platform/actors"],
  "maxPages": 3,
  "chunkSizeTokens": 512
}
```
