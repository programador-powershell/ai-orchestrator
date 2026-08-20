// REGRESSÃO (relato do dono, 2026-08-20): nova conversa → voltar ao histórico
// → o conteúdo não aparecia. Gateway e store provados corretos nesta sequência;
// Sequência provada CORRETA no gateway pelo fio (ready+replay integral);
// os envelopes abaixo são VERBATIM do log real s17872307374282.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const GATEWAY = { url: 'ws://127.0.0.1:8799/v1/stream', token: 'segredo' };
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => GATEWAY) }));
import { useApp, initialAppData } from './store';

const sockets: FakeSocket[] = [];
class FakeSocket {
  static readonly OPEN = 1;
  readyState = FakeSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { sockets.push(this); }
  send(): void {}
  close(): void {}
}

const LOG: unknown[] = [
  {"v":1,"id":"e-1787230746423-2","ts":"2026-08-20T12:59:06.4235311Z","seq":1,"session":"s17872307374282","turn":"t-1787230746418-1","kind":"message","from":{"kind":"user"},"payload":{"role":"user","text":"criar codigo html simples"}},
  {"v":1,"id":"e-1787230747810-5","ts":"2026-08-20T12:59:07.810928Z","seq":2,"session":"s17872307374282","turn":"t-1787230746418-1","kind":"delegate","from":{"kind":"supervisor","id":"master"},"payload":{"from":"master","to":"code","goal":"criar codigo html simples","reason":"o pedido é trabalho da especialidade dele","depth":1,"session":"s17872307374282-code"}},
  {"v":1,"id":"e-1787230758463-7","ts":"2026-08-20T12:59:18.4635429Z","seq":3,"session":"s17872307374282","turn":"t-1787230746418-1","kind":"tool.call","from":{"kind":"specialist","id":"code","specialist":"code"},"payload":{"callId":"c-1787230758463-6","tool":"fs.list","args":{"path":"."},"digest":"c8e0cba58af23f42"}},
  {"v":1,"id":"e-1787230758466-8","ts":"2026-08-20T12:59:18.4662327Z","seq":4,"session":"s17872307374282","turn":"t-1787230746418-1","kind":"tool.result","from":{"kind":"specialist","id":"code","specialist":"code"},"payload":{"callId":"c-1787230758463-6","tool":"fs.list","ok":false,"error":"esta sessão não tem pasta de projeto definida"}},
  {"v":1,"id":"e-1787230764980-9","ts":"2026-08-20T12:59:24.9804156Z","seq":5,"session":"s17872307374282","turn":"t-1787230746418-1","kind":"delegate","from":{"kind":"supervisor","id":"master"},"payload":{"from":"master","to":"code","goal":"criar codigo html simples","reason":"o pedido é trabalho da especialidade dele","depth":1,"done":true,"result":"Entendi — não há projeto aberto ainda.\n\nVou criar um arquivo HTML simples e básico para você. Se precisar de algo diferente depois, é só avisar:\n\n```html\n\u003c!DOCTYPE html\u003e\n\u003chtml lang=\"pt-BR\"\u003e\n\u003chead\u003e\n    \u003cmeta charset=\"UTF-8\"\u003e\n    \u003cmeta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\"\u003e\n    \u003ctitle\u003ePágina Simples\u003c/title\u003e\n    \u003cstyle\u003e\n        body {\n            font-family: Arial, sans-serif;\n            margin: 0;\n            padding: 20px;\n            background-color: #f5f5f5;\n        }\n        .container {\n            max-width: 800px;\n            margin: 0 auto;\n            background-color: white;\n            padding: 30px;\n            border-radius: 8px;\n            box-shadow: 0 2px 4px rgba(0,0,0,0.1);\n        }\n        h1 {\n            color: #333;\n        }\n        p {\n            color: #666;\n            line-height: 1.6;\n        }\n    \u003c/style\u003e\n\u003c/head\u003e\n\u003cbody\u003e\n    \u003cdiv class=\"container\"\u003e\n        \u003ch1\u003eBem-vindo!\u003c/h1\u003e\n        \u003cp\u003eEsta é uma página HTML simples e pronta para customizar.\u003c/p\u003e\n        \u003cp\u003eAdicione seu conteúdo aqui.\u003c/p\u003e\n    \u003c/div\u003e\n\u003c/body\u003e\n\u003c/html\u003e\n```\n\n**Para usar:** copie o código acima e salve em um arquivo `.html` (ex: `index.html`), depois abra no navegador.\n\nQuer que eu altere algo? Cores, conteúdo, estrutura?","session":"s17872307374282-code"}},
  {"v":1,"id":"e-1787230764990-12","ts":"2026-08-20T12:59:24.9901991Z","seq":6,"session":"s17872307374282","turn":"t-1787230746418-1","kind":"done","from":{"kind":"supervisor"},"payload":{"turn":"t-1787230746418-1"}},
  {"v":1,"id":"e-1787230997074-18","ts":"2026-08-20T13:03:17.0744814Z","seq":7,"session":"s17872307374282","turn":"t-1787230997070-17","kind":"message","from":{"kind":"user"},"payload":{"role":"user","text":"crie um front end pra ele"}},
  {"v":1,"id":"e-1787230998620-21","ts":"2026-08-20T13:03:18.6202491Z","seq":8,"session":"s17872307374282","turn":"t-1787230997070-17","kind":"delegate","from":{"kind":"supervisor","id":"master"},"payload":{"from":"master","to":"design","goal":"crie um front end pra ele","reason":"o pedido é trabalho da especialidade dele","depth":1,"session":"s17872307374282-design"}},
  {"v":1,"id":"e-1787231005531-22","ts":"2026-08-20T13:03:25.5314246Z","seq":9,"session":"s17872307374282","turn":"t-1787230997070-17","kind":"delegate","from":{"kind":"supervisor","id":"master"},"payload":{"from":"master","to":"design","goal":"crie um front end pra ele","reason":"o pedido é trabalho da especialidade dele","depth":1,"done":true,"result":"Preciso de um pouco mais de contexto antes de sair criando tokens e telas — \"ele\" aqui é o quê? Um produto/serviço já existente (tem API, backend, marca?) ou algo do zero?\n\nMe diga rapidinho:\n\n1. **O que é** — nome/propósito do produto (ex: SaaS de gestão, landing page, dashboard, app mobile?)\n2. **Referência visual** — tem algum site/app cujo estilo você gosta? (posso extrair o sistema de tokens dele com `design.replicate`)\n3. **Escopo** — quantas telas/páginas você imagina pra essa primeira entrega?\n4. **Stack** — tem preferência técnica (React, Vue, HTML puro) ou fica a critério?\n\nCom isso eu já defino a paleta, espaçamento, tipografia e raio como tokens (light + dark) e monto os componentes em cima disso, sem gambiarra pixel-a-pixel.","session":"s17872307374282-design"}},
  {"v":1,"id":"e-1787231005539-25","ts":"2026-08-20T13:03:25.5396564Z","seq":10,"session":"s17872307374282","turn":"t-1787230997070-17","kind":"done","from":{"kind":"supervisor"},"payload":{"turn":"t-1787230997070-17"}},
  {"v":1,"id":"e-1787231027430-27","ts":"2026-08-20T13:03:47.4303834Z","seq":11,"session":"s17872307374282","turn":"t-1787231027426-26","kind":"message","from":{"kind":"user"},"payload":{"role":"user","text":"landing page, pode ser simples"}},
  {"v":1,"id":"e-1787231028483-30","ts":"2026-08-20T13:03:48.4837201Z","seq":12,"session":"s17872307374282","turn":"t-1787231027426-26","kind":"delegate","from":{"kind":"supervisor","id":"master"},"payload":{"from":"master","to":"design","goal":"landing page, pode ser simples","reason":"o pedido é trabalho da especialidade dele","depth":1,"session":"s17872307374282-design"}},
  {"v":1,"id":"e-1787231068638-31","ts":"2026-08-20T13:04:28.6387885Z","seq":13,"session":"s17872307374282","turn":"t-1787231027426-26","kind":"delegate","from":{"kind":"supervisor","id":"master"},"payload":{"from":"master","to":"design","goal":"landing page, pode ser simples","reason":"o pedido é trabalho da especialidade dele","depth":1,"done":true,"session":"s17872307374282-design"}},
  {"v":1,"id":"e-1787231068645-34","ts":"2026-08-20T13:04:28.6450494Z","seq":14,"session":"s17872307374282","turn":"t-1787231027426-26","kind":"done","from":{"kind":"supervisor"},"payload":{"turn":"t-1787231027426-26"}}
];

const ready = (session: string, seq: number) => ({
  v: 1, id: 'r'+session+seq, ts: 't', seq: 0, session, kind: 'ready',
  from: { kind: 'supervisor' },
  payload: { session, seq, specialists: ['chat','code','design'], activeSpecialist: '', sessions: [
    { id: 's17872307374282', title: 'criar codigo html simples', specialist: '', turns: 3, lastSeq: 14 }
  ] }
});

describe('nova conversa e volta ao histórico', () => {
  beforeEach(() => { vi.stubGlobal('WebSocket', FakeSocket); useApp.setState(initialAppData()); });
  afterEach(() => { vi.unstubAllGlobals(); sockets.length = 0; });

  it('o replay reconstrói as linhas depois do desvio pela conversa nova', async () => {
    useApp.getState().connect();
    await vi.waitFor(() => { if (sockets.length === 0) throw new Error('sem socket'); });
    const socket = sockets[0]!;
    socket.onopen?.();
    const manda = (e: unknown) => socket.onmessage?.({ data: JSON.stringify(e) });

    manda(ready('s-boot', 0));
    expect(useApp.getState().session).toBe('s-boot');

    useApp.getState().newSession();
    manda(ready('s-nova', 0));
    expect(useApp.getState().session).toBe('s-nova');

    useApp.getState().openSession('s17872307374282');
    manda(ready('s17872307374282', 14));
    for (const envelope of LOG) manda(envelope);

    expect(useApp.getState().session).toBe('s17872307374282');
    expect(useApp.getState().lines.length).toBeGreaterThan(0);
    expect(useApp.getState().lines.some((l) => l.role === 'user')).toBe(true);
  });
});
