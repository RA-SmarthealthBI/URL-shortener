export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const CSS = `
:root{--bg:#fff;--fg:#1a1a1a;--muted:#6b6b6b;--line:#e3e3e3;--card:#f7f7f7;--accent:#2563eb;--bar:#3b82f6;--bad:#b91c1c;--badbg:#fdecec;--ok:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eaeaea;--muted:#9a9a9a;--line:#2c2c2c;--card:#1a1a1a;--accent:#7aa2ff;--bar:#5b8def;--bad:#fca5a5;--badbg:#3a1414;--ok:#4ade80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}a{color:var(--accent)}
h1{font-size:22px;margin:0 0 16px}h2{font-size:17px;margin:28px 0 10px}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
form.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;align-items:end}
label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
input{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);width:100%}
button{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
button.ghost{background:transparent;color:var(--accent)}button.danger{border-color:var(--bad);background:transparent;color:var(--bad)}
.table{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}.muted{color:var(--muted)}.trunc{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.spark{display:flex;align-items:flex-end;gap:2px;height:28px}.spark i{display:block;width:6px;background:var(--bar);border-radius:1px;min-height:1px}
.days{display:flex;align-items:flex-end;gap:3px;height:140px;padding-top:8px}.days div{flex:1 1 0;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%}
.days i{display:block;width:100%;background:var(--bar);border-radius:2px 2px 0 0;min-height:1px}.days span{font-size:10px;color:var(--muted);margin-top:4px;white-space:nowrap;overflow:visible}
table.kv{table-layout:fixed}table.kv td:first-child{width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}table.kv td:last-child{width:4.5em}
.hbar{display:flex;align-items:center;gap:8px}.hbar i{display:block;height:10px;background:var(--bar);border-radius:2px}
.err{background:var(--badbg);color:var(--bad);border:1px solid var(--bad);border-radius:8px;padding:12px 14px;margin-bottom:16px;font-weight:600}
.okmsg{border:1px solid var(--ok);color:var(--ok);border-radius:8px;padding:12px 14px;margin-bottom:16px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
.pill{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--line)}.pill.bad{color:var(--bad);border-color:var(--bad)}
code{font-family:ui-monospace,Menlo,monospace;font-size:13px}
`;

export function page(title: string, body: string, nonce: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style nonce="${nonce}">${CSS}</style></head>
<body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; img-src 'self'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    },
  });
}

export function newNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b));
}
