# Context Monitor (Antigravity Plugin)

Interactive MCP App plugin for Antigravity showing live context window usage by component (`messages`, `memory_files`, `system_prompt`, `skills`, `system_tools`, `custom_agents`, `mcp_instructions`), turn-by-turn growth, cache hit rate, compaction events, and optimization hints.

---

## Cài đặt / Installation

```bash
git clone https://github.com/abm-dungtq/antigravity-context-monitor.git
cd antigravity-context-monitor
npm install
npm run build
ln -sfn "$(pwd)" ~/.gemini/config/plugins/context-monitor
```

Link or install this directory as an Antigravity plugin (containing `plugin.json`, `mcp_config.json`, `bin/context-monitor-server`, `skills/context-monitor/SKILL.md`, and `dist/`).

## 3 Điểm truy cập / Entrypoints

1. **Side Pane (`+`)** — Mở bảng **Context Monitor** từ nút `+` ở thanh phụ (`aux_pane`), hỗ trợ click vào tệp memory/skill để mở nhanh file view.
2. **Left Sidebar (`global`)** — Mở **Context Monitor** ở thanh bên trái để duyệt và so sánh tất cả hội thoại gần đây.
3. **Slash / Prompt (`/context-monitor`)** — Gọi skill `context-monitor` hoặc hỏi trực tiếp trong chat để mở card tương tác inline.

## Độ chính xác dữ liệu / Data Accuracy

- **Exact (Đo thật từ transcript):** Tổng token thực tế từng lượt, `cacheRead`, `input`, `output`, tỷ lệ `cacheHit`, và các điểm compaction được đọc trực tiếp từ `transcript_full.jsonl` / `transcript.jsonl` và Language Server (`ListConversations`, `GetAllPlugins`).
- **Calibrated (Ước lượng hiệu chuẩn):** Vì transcript chỉ ghi tổng token mỗi lượt chứ không tách riêng từng phần trong system prompt, các mục như `messages`, `system_prompt`, `system_tools` được hiệu chuẩn từ baseline lượt 1 kết hợp kích thước thực tế trên đĩa của `memory_files`, `skills`, `custom_agents`, và `mcp_instructions` — luôn đảm bảo tổng 7 nhóm khớp đúng `totalUsedTokens`.

## Phát triển / Development

```bash
npm run typecheck   # Type-check UI (tsconfig.json) & server/analyzer (tsconfig.server.json)
npm run build       # Build single-file UI (dist/ui/app.html) & bundled MCP server (dist/server/index.js)
npm test            # Run Vitest unit tests
```
