"use client";

/**
 * Configurações → Administração → Relatoria de uso.
 *
 * Cliente dos endpoints `/v1/workspaces/{ws}/admin/usage/*`. A autorização é
 * do servidor (role >= admin); esconder a aba seria cosmético.
 *
 * O que esta tela faz de diferente de um dashboard comum: ela diz **o quanto
 * o número vale**. Custo baixo e custo não medido aparecem iguais em qualquer
 * gráfico — aqui cada linha carrega a sua confiança, e o topo avisa quando o
 * total está incompleto por falta de preço cadastrado.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CircleDollarSign, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { useApp } from "../../lib/store";
import {
  confidenceLabel,
  confidenceOf,
  formatTokens,
  formatUsd,
  personLabel,
  share,
  sumUsd,
  type DailyRow,
  type GroupRow,
  type ModelRow,
  type UsageTotals,
  type UserRow
} from "../../lib/usageReport";

type Breakdown = "users" | "groups" | "models" | "daily";

const TABS: Array<{ id: Breakdown; label: string }> = [
  { id: "users", label: "Por usuário" },
  { id: "groups", label: "Por grupo" },
  { id: "models", label: "Por modelo" },
  { id: "daily", label: "Por dia" }
];

const WINDOWS = [7, 30, 90];

interface PriceRow {
  model: string;
  inputPerMTok: string;
  outputPerMTok: string;
  cacheReadPerMTok: string;
  cacheWritePerMTok: string;
  currency: string;
}

/** Selo de confiança da linha — o que separa "barato" de "não medido". */
function Confidence({ totals }: { totals: UsageTotals }) {
  const level = confidenceOf(totals);
  if (level === "completo") return null;
  return (
    <span className={`usgx-flag usgx-flag--${level}`} title={confidenceLabel(totals)}>
      <AlertTriangle size={10} />
      {level === "sem-medicao" ? "sem medição" : "parcial"}
    </span>
  );
}

function Row({
  label,
  detail,
  totals,
  maxCost
}: {
  label: string;
  detail?: string;
  totals: UsageTotals;
  maxCost: string;
}) {
  return (
    <div className="usgx-row">
      <div className="usgx-row-id">
        <strong>{label}</strong>
        {detail ? <small>{detail}</small> : null}
      </div>
      <div className="usgx-row-bar">
        <i style={{ width: `${Math.round(share(totals.costUsd, maxCost) * 100)}%` }} />
      </div>
      <div className="usgx-row-numbers">
        <span className="usgx-cost">{formatUsd(totals.costUsd)}</span>
        <small>
          {totals.calls} chamada{totals.calls === 1 ? "" : "s"} ·{" "}
          {formatTokens(totals.inputTokens + totals.outputTokens)} tokens
          {totals.cacheReadTokens > 0 ? ` · ${formatTokens(totals.cacheReadTokens)} de cache` : ""}
        </small>
        <Confidence totals={totals} />
      </div>
    </div>
  );
}

export function UsageReport() {
  const session = useApp((state) => state.session);
  const [tab, setTab] = useState<Breakdown>("users");
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [users, setUsers] = useState<UserRow[]>([]);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [ungrouped, setUngrouped] = useState<UsageTotals | null>(null);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [daily, setDaily] = useState<DailyRow[]>([]);

  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [missingPrices, setMissingPrices] = useState<string[]>([]);
  const [priceDraft, setPriceDraft] = useState({ model: "", input: "", output: "", cacheRead: "", cacheWrite: "" });

  const base = session
    ? `${session.baseUrl.replace(/\/$/, "")}/v1/workspaces/${session.workspaceId}/admin`
    : null;

  const call = useCallback(
    async (path: string, init: RequestInit = {}) => {
      if (!base || !session) throw new Error("sem sessão com o gateway");
      const response = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {})
        }
      });
      if (!response.ok) {
        // 403 aqui é o portão real funcionando, não um bug da tela.
        throw new Error(
          response.status === 403
            ? "sem permissão de administrador neste workspace"
            : `gateway respondeu ${response.status}`
        );
      }
      return response;
    },
    [base, session]
  );

  /**
   * Cada busca carrega o número da vez.
   *
   * Trocar o chip de janela (7 → 90 dias) dispara uma busca nova sem esperar
   * a anterior. Se a resposta de 7 dias chegasse por último, ela populava a
   * tela inteira enquanto o chip mostrava "90 dias" — o admin lia o custo da
   * janela errada sem nenhum sinal. Resposta de uma volta velha agora é
   * descartada.
   */
  const voltaRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!base) return;
    const volta = voltaRef.current + 1;
    voltaRef.current = volta;
    setLoading(true);
    setError("");
    try {
      const [u, g, m, d, p] = await Promise.all([
        call(`/usage/users?days=${days}`),
        call(`/usage/groups?days=${days}`),
        call(`/usage/models?days=${days}`),
        call(`/usage/daily?days=${days}`),
        call("/prices")
      ]);
      const usuarios = ((await u.json()) as { items: UserRow[] }).items ?? [];
      const groupBody = (await g.json()) as { items: GroupRow[]; ungrouped: UsageTotals };
      const modelos = ((await m.json()) as { items: ModelRow[] }).items ?? [];
      const diario = ((await d.json()) as { items: DailyRow[] }).items ?? [];
      const priceBody = (await p.json()) as { items: PriceRow[]; missingPrices: string[] };
      if (voltaRef.current !== volta) return;
      setUsers(usuarios);
      setGroups(groupBody.items ?? []);
      setUngrouped(groupBody.ungrouped ?? null);
      setModels(modelos);
      setDaily(diario);
      setPrices(priceBody.items ?? []);
      setMissingPrices(priceBody.missingPrices ?? []);
    } catch (cause) {
      if (voltaRef.current !== volta) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (voltaRef.current === volta) setLoading(false);
    }
  }, [base, call, days]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Preço digitado → número, aceitando a vírgula decimal.
   *
   * `Number("3,75")` é NaN e o `|| 0` transformava isso em ZERO sem avisar:
   * o modelo saía da lista de "sem preço", todo o uso dele passava a custar
   * nada e o relatório — cuja proposta é justamente separar "barato" de "não
   * medido" — passava a subnotificar o gasto como se estivesse completo.
   * Campo inválido agora RECUSA a gravação.
   */
  function parsePreco(bruto: string): number | null {
    const limpo = bruto.trim().replace(",", ".");
    if (!limpo) return 0;
    const valor = Number(limpo);
    return Number.isFinite(valor) && valor >= 0 ? valor : null;
  }

  async function savePrice() {
    const model = priceDraft.model.trim();
    if (!model) return;
    const campos = {
      inputPerMTok: parsePreco(priceDraft.input),
      outputPerMTok: parsePreco(priceDraft.output),
      cacheReadPerMTok: parsePreco(priceDraft.cacheRead),
      cacheWritePerMTok: parsePreco(priceDraft.cacheWrite)
    };
    if (Object.values(campos).some((valor) => valor === null)) {
      setError("Preço inválido: use apenas número (vírgula ou ponto), sem símbolo de moeda.");
      return;
    }
    try {
      await call("/prices", {
        method: "PUT",
        body: JSON.stringify({ model, ...campos })
      });
      setPriceDraft({ model: "", input: "", output: "", cacheRead: "", cacheWrite: "" });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function removePrice(model: string) {
    try {
      await call(`/prices/${encodeURIComponent(model)}`, { method: "DELETE" });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (!session) {
    return <p className="setx-hint">Conecte-se ao gateway para ver a relatoria de uso.</p>;
  }

  // O total do workspace vem da quebra por USUÁRIO, não da por grupo: quem
  // está em duas áreas conta nas duas, e somar grupos passaria do total.
  const totalCost = sumUsd(users.map((row) => row.costUsd));
  const totalCalls = users.reduce((sum, row) => sum + row.calls, 0);
  const unmeasured = users.reduce((sum, row) => sum + (row.calls - row.measuredCalls), 0);

  const rows = (() => {
    switch (tab) {
      case "users": {
        const max = users[0]?.costUsd ?? "0";
        return users.map((row) => (
          <Row key={row.userId} label={personLabel(row)} detail={row.name ?? undefined} totals={row} maxCost={max} />
        ));
      }
      case "groups": {
        const max = groups[0]?.costUsd ?? "0";
        return (
          <>
            {groups.map((row) => (
              <Row key={row.groupId} label={row.name} totals={row} maxCost={max} />
            ))}
            {ungrouped && ungrouped.calls > 0 ? (
              <Row
                label="Sem grupo"
                detail="usuários fora de qualquer grupo cadastrado"
                totals={ungrouped}
                maxCost={max}
              />
            ) : null}
          </>
        );
      }
      case "models": {
        const max = models[0]?.costUsd ?? "0";
        return models.map((row) => (
          <Row
            key={`${row.model}-${row.mode}`}
            label={row.model}
            detail={row.hasPrice ? row.mode : `${row.mode} · sem preço cadastrado`}
            totals={row}
            maxCost={max}
          />
        ));
      }
      case "daily": {
        const max = daily.reduce((top, row) => (Number(row.costUsd) > Number(top) ? row.costUsd : top), "0");
        return daily.map((row) => (
          <Row
            key={row.day}
            label={row.day}
            detail={`${row.activeUsers} usuário(s) ativo(s)`}
            totals={row}
            maxCost={max}
          />
        ));
      }
    }
  })();

  return (
    <div className="usgx">
      <div className="usgx-toolbar">
        <div className="usgx-windows">
          {WINDOWS.map((value) => (
            <button
              key={value}
              className={`lg-chip ${days === value ? "active" : ""}`}
              onClick={() => setDays(value)}
            >
              {value} dias
            </button>
          ))}
        </div>
        <button className="lg-button" onClick={() => void refresh()} disabled={loading}>
          {loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}
          Atualizar
        </button>
      </div>

      {error ? <p className="usgx-error">{error}</p> : null}

      <div className="usgx-summary">
        <div>
          <small>Custo no período</small>
          <strong>{formatUsd(totalCost)}</strong>
        </div>
        <div>
          <small>Chamadas</small>
          <strong>{totalCalls}</strong>
        </div>
        <div>
          <small>Usuários com uso</small>
          <strong>{users.length}</strong>
        </div>
      </div>

      {/* Avisos que impedem o total de ser lido como verdade completa. */}
      {missingPrices.length > 0 ? (
        <p className="usgx-warn">
          <AlertTriangle size={12} />
          {missingPrices.length} modelo(s) em uso sem preço cadastrado ({missingPrices.slice(0, 3).join(", ")}
          {missingPrices.length > 3 ? "…" : ""}) — o custo acima está <strong>incompleto</strong>.
        </p>
      ) : null}
      {unmeasured > 0 ? (
        <p className="usgx-warn">
          <AlertTriangle size={12} />
          {unmeasured} chamada(s) sem contagem de token do provedor — não entram no custo.
        </p>
      ) : null}

      <div className="usgx-tabs">
        {TABS.map((item) => (
          <button
            key={item.id}
            className={`usgx-tab ${tab === item.id ? "active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="usgx-rows">
        {rows && (Array.isArray(rows) ? rows.length > 0 : true) ? (
          rows
        ) : (
          <p className="setx-hint">Nenhum uso registrado nesta janela.</p>
        )}
      </div>

      {tab === "groups" && groups.length > 1 ? (
        <p className="setx-hint">
          Quem pertence a mais de um grupo conta em cada um — por isso a soma das áreas pode passar do total do
          workspace.
        </p>
      ) : null}

      {/* Preço é dado do admin: sem ele não há custo, e o relatório diz isso. */}
      <section className="usgx-prices">
        <header>
          <CircleDollarSign size={13} />
          <div>
            <strong>Preço por modelo</strong>
            <small>Valor por milhão de tokens. Sem preço, o modelo aparece como “sem preço” e não como custo zero.</small>
          </div>
        </header>
        <div className="usgx-price-form">
          <input
            list="usgx-missing"
            placeholder="modelo"
            value={priceDraft.model}
            onChange={(event) => setPriceDraft({ ...priceDraft, model: event.target.value })}
          />
          <datalist id="usgx-missing">
            {missingPrices.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
          <input
            placeholder="entrada"
            inputMode="decimal"
            value={priceDraft.input}
            onChange={(event) => setPriceDraft({ ...priceDraft, input: event.target.value })}
          />
          <input
            placeholder="saída"
            inputMode="decimal"
            value={priceDraft.output}
            onChange={(event) => setPriceDraft({ ...priceDraft, output: event.target.value })}
          />
          <input
            placeholder="cache leitura"
            inputMode="decimal"
            value={priceDraft.cacheRead}
            onChange={(event) => setPriceDraft({ ...priceDraft, cacheRead: event.target.value })}
          />
          <input
            placeholder="cache escrita"
            inputMode="decimal"
            value={priceDraft.cacheWrite}
            onChange={(event) => setPriceDraft({ ...priceDraft, cacheWrite: event.target.value })}
          />
          <button className="lg-button primary" onClick={() => void savePrice()} disabled={!priceDraft.model.trim()}>
            Salvar
          </button>
        </div>
        {prices.map((price) => (
          <div className="usgx-price-row" key={price.model}>
            <strong>{price.model}</strong>
            <small>
              entrada {price.inputPerMTok} · saída {price.outputPerMTok} · cache {price.cacheReadPerMTok}/
              {price.cacheWritePerMTok} · {price.currency}
            </small>
            <button className="usgx-price-del" onClick={() => void removePrice(price.model)} title="Remover preço">
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
