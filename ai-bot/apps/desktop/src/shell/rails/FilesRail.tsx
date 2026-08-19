/**
 * Rail do especialista de Código: a árvore REAL do projeto da sessão.
 *
 * Substitui o placeholder permanente do Rail.tsx ("a árvore aparece aqui…" sem
 * nenhum caminho de código que a enchesse). O dado vem do gateway por
 * fs.list na rota /v1/tools/call — expansão preguiçosa: cada pasta só é
 * listada quando alguém a abre, porque cada nível é um POST.
 *
 * Regra herdada do Rail: vazio HONESTO. Sem gateway não há árvore, e a coluna
 * diz isso com todas as letras — inventar arquivos de exemplo aqui faria a
 * pessoa clicar num arquivo que não existe.
 */
import { useEffect, type CSSProperties, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Database,
  File,
  FileCode2,
  FileCog,
  FileImage,
  FileJson,
  FileTerminal,
  FileText,
  Folder,
  FolderOpen,
  Palette,
  RefreshCw,
  WifiOff,
  type LucideIcon
} from "lucide-react";
import { useApp } from "../../lib/store";
import {
  abrirArquivo,
  alternarPasta,
  bootstrapArvore,
  recarregarArvore,
  sincronizarSessao,
  useIde
} from "../../lib/ide/ideStore";
import { tipoDoArquivo, type TipoDeArquivo } from "../../lib/ide/projeto";

/** A família (regra pura em lib/ide/projeto) vira ícone AQUI — quem desenha decide. */
const ICONE_POR_TIPO: Record<TipoDeArquivo, LucideIcon> = {
  codigo: FileCode2,
  json: FileJson,
  texto: FileText,
  estilo: Palette,
  imagem: FileImage,
  dados: Database,
  config: FileCog,
  shell: FileTerminal,
  outro: File
};

export function IconeDoArquivo({ name }: { name: string }): ReactNode {
  const Icone = ICONE_POR_TIPO[tipoDoArquivo(name)];
  return <Icone size={13} aria-hidden />;
}

/** Mesma marcação do RailEmpty do Rail.tsx (que não é exportado). */
function Vazio({ icon: Icon, titulo, hint, children }: {
  icon: LucideIcon;
  titulo: string;
  hint: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="rail-empty">
      <Icon size={18} aria-hidden />
      <p className="rail-empty-title">{titulo}</p>
      <p className="rail-empty-hint">{hint}</p>
      {children}
    </div>
  );
}

export function FilesRail(): ReactNode {
  const status = useApp((state) => state.status);
  const session = useApp((state) => state.session);
  const tree = useIde((state) => state.tree);
  const expanded = useIde((state) => state.expanded);
  const files = useIde((state) => state.files);
  const activePath = useIde((state) => state.activePath);

  // A árvore é POR SESSÃO: adotar a sessão nova zera a anterior, e a primeira
  // carga só dispara com o gateway pronto — pedir fs.list offline é gastar um
  // erro para desenhar o que a mensagem de vazio já diz.
  useEffect(() => {
    sincronizarSessao(session ?? "");
    if (status === "ready" && session) bootstrapArvore();
  }, [session, status]);

  if (status !== "ready" || !session) {
    return (
      <Vazio
        icon={WifiOff}
        titulo="Sem conexão com o gateway."
        hint="A árvore mostra o projeto REAL da sessão — sem gateway não há o que listar. Ela volta sozinha quando a conexão voltar."
      />
    );
  }

  const raiz = tree[""];

  if (raiz && raiz.erro !== "") {
    return (
      <Vazio icon={FolderOpen} titulo="A árvore não carregou." hint={raiz.erro}>
        <button type="button" className="rail-stencil" onClick={recarregarArvore}>
          <RefreshCw size={12} aria-hidden />
          Tentar de novo
        </button>
      </Vazio>
    );
  }

  function renderEntradas(sub: string, profundidade: number): ReactNode {
    const pasta = tree[sub];
    const recuo = { "--depth": profundidade } as CSSProperties;
    if (!pasta) {
      return (
        <span className="files-tree-note" style={recuo} key={`${sub}#carregando`}>
          carregando…
        </span>
      );
    }
    if (pasta.erro !== "") {
      // A falha aparece NO LUGAR da pasta, com o motivo — nunca some nem vira
      // uma pasta "vazia" de mentira.
      return (
        <span className="files-tree-note files-tree-erro" style={recuo} key={`${sub}#erro`} title={pasta.erro}>
          {pasta.erro}
        </span>
      );
    }
    if (pasta.entradas.length === 0) {
      return (
        <span className="files-tree-note" style={recuo} key={`${sub}#vazio`}>
          vazio
        </span>
      );
    }
    return pasta.entradas.map((entrada) => {
      if (entrada.isDir) {
        const aberta = expanded.has(entrada.path);
        return (
          <div key={entrada.path}>
            <button
              type="button"
              className="files-tree-row"
              style={recuo}
              onClick={() => alternarPasta(entrada.path)}
              title={entrada.path}
            >
              {aberta ? <ChevronDown size={11} aria-hidden /> : <ChevronRight size={11} aria-hidden />}
              {aberta ? <FolderOpen size={13} aria-hidden /> : <Folder size={13} aria-hidden />}
              <span className="files-tree-name">{entrada.name}</span>
            </button>
            {aberta && renderEntradas(entrada.path, profundidade + 1)}
          </div>
        );
      }
      const aba = files.find((arquivo) => arquivo.path === entrada.path);
      return (
        <button
          type="button"
          key={entrada.path}
          className="files-tree-row"
          data-active={activePath === entrada.path}
          style={recuo}
          onClick={() => void abrirArquivo(entrada)}
          title={entrada.path}
        >
          <IconeDoArquivo name={entrada.name} />
          <span className="files-tree-name">{entrada.name}</span>
          {aba?.dirty ? (
            <i className="files-dirty" aria-label="com edições não salvas" />
          ) : (
            <small>{Math.max(1, Math.round(entrada.size / 1024))}k</small>
          )}
        </button>
      );
    });
  }

  return (
    <>
      <div className="files-rail-tools">
        <span className="rail-note">projeto da sessão</span>
        <button
          type="button"
          className="icon-button"
          onClick={recarregarArvore}
          title="Recarregar a árvore"
          aria-label="Recarregar a árvore"
        >
          <RefreshCw size={12} aria-hidden />
        </button>
      </div>
      <div className="files-tree">{renderEntradas("", 0)}</div>
    </>
  );
}

export default FilesRail;
