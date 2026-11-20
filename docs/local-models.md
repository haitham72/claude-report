# Local models

Claude Report can write the full report on a model running on your computer. Local mode supports LM Studio and Ollama.

## Turn it on

1. Start LM Studio's local server (default port 1234) or Ollama (port 11434), and load a model.
2. Open the **Connect** tab, find **Report model**, and switch **Run on** from **Cloud** to **Local**.
3. Pick the engine with the **LM Studio | Ollama** swap and a model from the list. The loaded one is used when you pick none.
4. Create a report as usual. The Report tab shows the selected model.

Local runs the project summaries and overview on your computer. It processes one project at a time. Open **Enhance report** from a saved report's menu to choose a local engine and model for that revision. Thinking is Off by default where the model can disable it. On requests Low when the model offers that setting, or On when that is the supported control.

If the local server or selected model is unavailable, the Report tab shows the error. The run stays in Local mode.

## What the model list shows

For each model, the list shows quantization, size on disk, whether it is loaded, and **the estimated context it fits on your GPU**.

1. The GPU's total memory comes from `nvidia-smi`.
2. The model's layer count, key-value heads and head size are read from its GGUF file header (or from Ollama's model info).
3. The key-value cache costs `2 × layers × kv heads × head size × 2 bytes` per token.
4. Max context = (GPU memory − the weights − about 1.2 GB overhead) ÷ cache bytes per token, rounded down, and never above what the model supports.

For example Qwen3 4B (36 layers, 8 key-value heads, head size 128) costs 144 KiB per token, so on a 16 GB card it fits about 90k tokens.

For new loads, Claude Report estimates the context from currently free VRAM, with 10% of total VRAM reserved. It subtracts the weights and estimated runtime overhead before sizing the token cache. It reuses the active context of a model you already loaded. **Low VRAM** means a new load would exceed the estimated budget. The run's **Runtime log** shows the selected model and context when available.

Without an NVIDIA card the limits show as unknown. Everything else works.

## How requests are made

Claude Report uses the LM Studio or Ollama native chat API when the server exposes it. Older servers can use their OpenAI-compatible endpoint. The extension validates the returned report JSON.

A local project request uses up to 32 sampled prompts within a character budget. If the response is empty, invalid, or reaches a model limit, the extension can retry with up to 16 prompts. The report history keeps the larger redacted sample of up to 60 prompts per project for future revisions. See [Report history and evidence](reports.md#manage-a-saved-report).

## Review a local report

Cards written locally are marked **local draft**. Open a card to review its examples and supporting evidence. A partial report lists failed projects. Its menu lets you retry them or enhance the whole report with a different model while keeping the original run available.
