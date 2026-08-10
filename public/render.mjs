// Tiny markdown renderer: escapes HTML first, then code blocks, inline code,
// bold, links, [n] citations, paragraphs. Enough for model output.
// A plain ES module (not bundled) so it's both loadable by the browser as a
// static asset and importable directly in scripts/eval-format.test.mjs.
export function renderMarkdown(md, sources) {
  let h = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const blocks = [];
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => { blocks.push(code); return `\x00${blocks.length - 1}\x00`; });
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>")
       .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
       .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
       .replace(/\[(\d+)\]/g, (_, n) => {
         const s = sources && sources[n - 1];
         return s ? `<sup class="cite" onclick="window.open('${s.url}','_blank')" title="${(s.title||"").replace(/"/g,"&quot;")}">[${n}]</sup>` : `[${n}]`;
       })
       .replace(/^[-*] (.+)$/gm, "<li>$1</li>")
       .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>");
  h = h.split(/\n{2,}/).map((p) => /^<(ul|pre)/.test(p.trim()) ? p : `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
  h = h.replace(/\x00(\d+)\x00/g, (_, i) => `<pre><code>${blocks[i]}</code></pre>`);
  return h;
}
