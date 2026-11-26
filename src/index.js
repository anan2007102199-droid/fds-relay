const VERSION = "0.1.0";
const CALL_TIMEOUT_MS = 110000;

const TOOLS = [
  {
    name: "screen_read",
    description: "读取手机当前屏幕：返回正在前台的应用和屏幕上的文字/可点元素。操作前后都可以用它看结果。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "读屏", readOnlyHint: true },
  },
  {
    name: "screen_tap",
    description: "点手机屏幕。优先给 text（屏幕上看得到的文字，如“电池”）；找不到文字时才用 x、y 像素坐标。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要点的文字" },
        x: { type: "number" },
        y: { type: "number" },
      },
      additionalProperties: false,
    },
    annotations: { title: "点击", readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "open_app",
    description: "打开手机上的应用，name 填应用名（如“设置”）或包名。",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "应用名或包名" } },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { title: "打开应用", readOnlyHint: false, destructiveHint: false },
  },
];

function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return new Response("FDS relay " + VERSION);
    const [kind, secret] = parts;
    if (!env.FDS_SECRET || env.FDS_SECRET.length < 16) {
      return new Response("FDS_SECRET missing (16+ chars)", { status: 500 });
    }
    if (!sameSecret(secret || "", env.FDS_SECRET)) return new Response("not found", { status: 404 });
    const hub = env.HUB.get(env.HUB.idFromName("phone"));
    if (kind === "phone" || kind === "status") return hub.fetch(request);
    if (kind === "mcp") return handleMcp(request, hub);
    return new Response("not found", { status: 404 });
  },
};

async function handleMcp(request, hub) {
  if (request.method === "GET") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  let body;
  try { body = await request.json(); } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const batch = Array.isArray(body);
  const out = [];
  for (const m of batch ? body : [body]) {
    const r = await handleRpc(m, hub);
    if (r) out.push(r);
  }
  if (out.length === 0) return new Response(null, { status: 202 });
  return json(batch ? out : out[0]);
}

async function handleRpc(m, hub) {
  if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  if (m.id === undefined || m.id === null) return null;
  const ok = (result) => ({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize": {
      const asked = m.params && m.params.protocolVersion;
      const supported = ["2025-06-18", "2025-03-26", "2024-11-05"];
      return ok({
        protocolVersion: supported.includes(asked) ? asked : supported[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "FDS 手机", version: VERSION },
        instructions:
          "这是用户自己的安卓手机（通过 FDS）。每个操作都会在手机上弹窗等用户点允许，被拒绝就停下问用户。" +
          "先 screen_read 看屏幕，再决定点哪里；每步之后再读一次确认结果。不要输入密码，不要付款或发送消息。",
      });
    }
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS });
    case "tools/call": {
      const name = m.params && m.params.name;
      const args = (m.params && m.params.arguments) || {};
      if (!TOOLS.some((t) => t.name === name)) {
        return { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "没有这个工具: " + name } };
      }
      const res = await hub.fetch("https://hub/call", { method: "POST", body: JSON.stringify({ tool: name, args }) });
      const r = await res.json();
      return ok({ content: [{ type: "text", text: String(r.text || "") }], isError: !r.ok });
    }
    case "resources/list": return ok({ resources: [] });
    case "prompts/list": return ok({ prompts: [] });
    default:
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found: " + m.method } };
  }
}

export class PhoneHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.pending = new Map();
    this.seq = 0;
  }

  phone() {
    const list = this.ctx.getWebSockets("phone");
    return list.length ? list[list.length - 1] : null;
  }

  async fetch(request) {
    const kind = new URL(request.url).pathname.split("/").filter(Boolean)[0];

    if (kind === "phone") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("need websocket", { status: 426 });
      for (const old of this.ctx.getWebSockets("phone")) { try { old.close(4000, "replaced"); } catch {} }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["phone"]);
      pair[1].serializeAttachment({ since: Date.now() });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (kind === "status") {
      const ws = this.phone();
      const since = ws ? (ws.deserializeAttachment() || {}).since : null;
      return json({
        relay: VERSION,
        phone_connected: !!ws,
        connected_since: since ? new Date(since).toISOString() : null,
        waiting_calls: this.pending.size,
      });
    }

    if (kind === "call") {
      const { tool, args } = await request.json();
      const ws = this.phone();
      if (!ws) return json({ ok: false, text: "手机没连上中转站：请在手机上打开 FDS，确认“Claude 连接”开着。" });
      const id = "c" + Date.now().toString(36) + "-" + ++this.seq;
      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          resolve({ ok: false, text: "手机超过 " + CALL_TIMEOUT_MS / 1000 + " 秒没回应（可能没点允许）。" });
        }, CALL_TIMEOUT_MS);
        this.pending.set(id, { resolve, timer });
        try {
          ws.send(JSON.stringify({ type: "call", id, tool, args }));
        } catch (e) {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve({ ok: false, text: "发给手机失败：" + e });
        }
      });
      return json(result);
    }

    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws, message) {
    let m;
    try { m = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)); } catch { return; }
    if (m.type === "ping") { ws.send(JSON.stringify({ type: "pong", t: Date.now() })); return; }
    if (m.type === "result" && m.id) {
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      p.resolve({ ok: !!m.ok, text: String(m.text ?? "") });
    }
  }

  async webSocketClose(ws) {
    if (this.ctx.getWebSockets("phone").some((w) => w !== ws)) return;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, text: "手机在操作途中断开了。" });
    }
    this.pending.clear();
  }

  async webSocketError(ws) {
    return this.webSocketClose(ws);
  }
}
