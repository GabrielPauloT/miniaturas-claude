# miniaturas: a imagem colada à vista no Claude Code

Mod do Claude Code (feito na 2.1.308) que troca o `[Image #N]` por uma miniatura que dá para reconhecer:

- **antes de enviar**, acima do prompt, para conferir se você colou a imagem certa;
- **depois de enviar**, embaixo da mensagem, para saber qual imagem era cada `[Image #N]`.

## Os três jeitos de mostrar

| Modo | O que aparece |
| --- | --- |
| `miniatura` (padrão) | miniatura pequena acima do prompt enquanto você escreve, e embaixo de cada mensagem enviada |
| `dica` | só a etiqueta `▣ #N`; a miniatura aparece ao passar o mouse em cima dela |
| `fixa` | a imagem mais recente fica grande acima do prompt o tempo todo, mesmo depois de enviar |

Para trocar: `/miniaturas dica` (ou `miniatura`, `fixa`), ou em `/config` › miniaturas. `/miniaturas` sozinho diz
qual está valendo.

- O modo `dica` precisa do mouse, que o Claude Code só lê com `"tui": "fullscreen"` no `~/.claude/settings.json`.
  Sem isso ele mostra como `miniatura`. No histórico o cartão abre por cima das linhas de cima; numa mensagem colada
  no topo da tela, sem espaço acima, o Claude Code o empurra para baixo e as linhas seguintes ficam por cima dele.
- A etiqueta `#N` abre a imagem inteira no visualizador do sistema: clique nela, ou foque a faixa com ctrl+x tab e
  aperte Enter.

## Como a miniatura é desenhada

- **No kitty e no Ghostty:** a imagem de verdade, pelo protocolo de imagem do kitty.
- **Nos outros terminais** (Ptyxis, GNOME Terminal, Konsole, Warp…): blocos coloridos `▀` em cor verdadeira, dois
  pixels por caractere. Dá para reconhecer a imagem pelo desenho e pelas cores, mas texto pequeno de um print não
  fica legível. Para ver inteira, use a etiqueta.
- A opção `desenho` (`auto`, `blocos`, `imagem`) em `/config` força um dos dois.

## Precisa de

- `ffmpeg` (com `ffprobe`), que reduz a imagem. Sem ele o mod avisa uma vez e não desenha.
- Para a prévia **antes** do envio: Linux com `wl-paste` (Wayland) ou `xclip` (X11), os mesmos que o Claude Code usa
  para colar imagem. Depois do envio a miniatura vem do arquivo que o Claude Code gravou.

## Como funciona, e os limites

- O Claude Code só grava a imagem colada no disco quando você envia. Para mostrar antes, o mod lê a área de
  transferência no instante em que o `[Image #N]` aparece no rascunho, do mesmo jeito que o Claude Code acabou de ler.
- Se você **arrastar** um arquivo de imagem para o terminal em vez de colar, a prévia antes do envio pode mostrar o
  que estiver na área de transferência. Depois do envio ela passa a vir do arquivo que o modelo recebeu.
- O cache fica em `$XDG_RUNTIME_DIR/claude-miniaturas/<sessão>/` (sem essa variável, em `/tmp`), só com permissão
  para você. As pastas de sessões com mais de 2 dias são apagadas sozinhas.
- Mensagens com imagem de antes do mod carregar (uma sessão retomada, por exemplo) ganham a miniatura se o arquivo
  que o Claude Code gravou ainda existir em `/tmp`.

## Instalar

No prompt de uma sessão do Claude Code no terminal:

```
/plugin install miniaturas --marketplace GabrielPauloT/miniaturas-claude
```

Ele pergunta se pode adicionar o marketplace (responda `y`) e depois o escopo (o de usuário vem primeiro; Enter
escolhe). Pelo shell:

```sh
claude plugin install miniaturas --marketplace GabrielPauloT/miniaturas-claude
```

No app desktop, onde o `/plugin` não roda: clique no **+** ao lado da caixa do prompt, depois em **Plugins**,
**Add marketplace** com `GabrielPauloT/miniaturas-claude` e então **Add plugin**. (O mod só desenha no terminal.)

Para desinstalar: `claude plugin uninstall miniaturas@miniaturas-claude`.

## Como mexer

| Arquivo | O quê |
| --- | --- |
| `hooks/register.tsx` | os hooks: captura da colagem, ffmpeg, o desenho na faixa e nas mensagens, o comando |
| `hooks/pixels.ts` | funções puras: ler o PAM do ffmpeg, caber, reduzir, montar as células do `Raster` |
| `hooks/util.ts` | achar os `[Image #N]` de um texto |
| `types/index.d.ts` | o contrato do `$.state` |
| `tests/` | os testes |

Antes de recarregar:

```sh
claude plugin validate ~/projetos/miniaturas-claude
claude plugin test ~/projetos/miniaturas-claude
node ~/projetos/pixel-agents-linux/node_modules/typescript/bin/tsc -p ~/projetos/miniaturas-claude
```

## Instalar de uma pasta local

```sh
claude plugin marketplace add ~/projetos/miniaturas-claude
claude plugin install miniaturas@miniaturas-claude
claude plugin uninstall miniaturas@miniaturas-claude
```

Instalado assim, o Claude Code lê os arquivos desta pasta: editou, rode `/reload-plugins` na sessão.
