import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, PluginOptions, Register, RenderNode } from 'claude-code'

import type { MiniaturaImagem } from '../types'
import { AMOSTRA, caber, celulas, deBase64, lerPam, realcar, reduzir } from './pixels'
import type { Pixels } from './pixels'
import { numerosDeImagem } from './util'

type Motor = EngineInterface
type Ui = Elements['terminal']
type Modo = 'miniatura' | 'dica' | 'fixa'
type Caixa = { colunas: number; linhas: number }

const MODOS: readonly Modo[] = ['miniatura', 'dica', 'fixa']

const imagens = atom({ plugin: 'miniaturas', key: 'imagens' } as const, {})
const rascunho = atom({ plugin: 'miniaturas', key: 'rascunho' } as const, [])
const ultimas = atom({ plugin: 'miniaturas', key: 'ultimas' } as const, [])

/** Tamanhos máximos das miniaturas, em células. */
const NA_FAIXA: Caixa = { colunas: 90, linhas: 20 }
const NA_DICA: Caixa = { colunas: 90, linhas: 20 }
const NA_MENSAGEM: Caixa = { colunas: 56, linhas: 8 }
const LINHAS_DA_FIXA = 20
/** Lado dos pixels guardados no cache: dá para qualquer miniatura sem voltar ao ffmpeg. */
const LADO_DO_CACHE = 640
/** Lado do PNG reduzido que o kitty e o Ghostty desenham. */
const LADO_DO_PNG = 640
/** O Claude Code grava a imagem enviada logo antes da mensagem: tentativas e intervalo para achá-la. */
const TENTATIVAS_DO_ENVIO = 8
const ESPERA_DO_ENVIO_MS = 250
/** Quantos pixels e desenhos ficam na memória do mod. */
const MAX_NA_MEMORIA = 12
/** Quanto realçar o contorno depois de reduzir (0 desliga). */
const NITIDEZ = 0.4

// A pasta do cache só para a pessoa (as imagens podem ter segredo), e some com as de sessões de mais de 2 dias.
const SCRIPT_PREPARAR = `
mkdir -p -m 700 "$1" && mkdir -p -m 700 "$1/$2" || exit 1
find "$1" -mindepth 1 -maxdepth 1 -type d -mtime +2 -exec rm -rf -- {} + 2>/dev/null
exit 0
`

// Lê a área de transferência como o Claude Code lê ao colar (xclip, senão wl-paste): a imagem,
// ou o caminho de um arquivo de imagem copiado como texto. Logo depois da colagem, é a mesma imagem.
const SCRIPT_COLAGEM = `
destino=$1
tipos=$(xclip -selection clipboard -t TARGETS -o 2>/dev/null || wl-paste -l 2>/dev/null)
if printf '%s\\n' "$tipos" | grep -qE 'image/(png|jpeg|jpg|gif|webp|bmp)'; then
  if { xclip -selection clipboard -t image/png -o 2>/dev/null || wl-paste --type image/png 2>/dev/null || xclip -selection clipboard -t image/bmp -o 2>/dev/null || wl-paste --type image/bmp 2>/dev/null; } > "$destino" && [ -s "$destino" ]; then
    echo arquivo
    exit 0
  fi
fi
texto=$(xclip -selection clipboard -t text/plain -o 2>/dev/null || wl-paste --no-newline 2>/dev/null)
texto=$(printf '%s' "$texto" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e "s/^'\\(.*\\)'$/\\1/" -e 's/^"\\(.*\\)"$/\\1/')
case "$texto" in
  /*.[Pp][Nn][Gg]|/*.[Jj][Pp][Gg]|/*.[Jj][Pp][Ee][Gg]|/*.[Gg][Ii][Ff]|/*.[Ww][Ee][Bb][Pp])
    if [ -f "$texto" ]; then printf 'caminho:%s\\n' "$texto"; exit 0; fi ;;
esac
echo nada
`

// O tamanho original e duas reduções num passo só: pixels RGBA (PAM) para os blocos coloridos
// e um PNG pequeno para os terminais que desenham imagem.
const SCRIPT_FFMPEG = `
ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "file:$1" 2>/dev/null | head -n 1
exec ffmpeg -v error -nostdin -y -i "file:$1" -filter_complex "[0:v]split=2[a][b];[a]scale=w='min(${LADO_DO_CACHE},iw)':h='min(${LADO_DO_CACHE},ih)':force_original_aspect_ratio=decrease:flags=area,format=rgba[m];[b]scale=w='min(${LADO_DO_PNG},iw)':h='min(${LADO_DO_PNG},ih)':force_original_aspect_ratio=decrease[p]" -map "[m]" -frames:v 1 -c:v pam -f image2 "$2" -map "[p]" -frames:v 1 -f image2 "$3"
`

// Onde o Claude Code grava as imagens enviadas nesta sessão: <tmp>/claude-<uid>/<projeto>/<sessão>/images.
const SCRIPT_IMAGENS = `
for pasta in "\${TMPDIR:-/tmp}"/claude-"$(id -u)"/*/"$1"/images; do
  if [ -d "$pasta" ]; then echo "$pasta"; exit 0; fi
done
exit 1
`

// Abre no visualizador de imagens sem prender o Claude Code.
const SCRIPT_ABRIR = `
if command -v xdg-open >/dev/null 2>&1; then
  setsid xdg-open "$1" >/dev/null 2>&1 &
else
  open "$1" >/dev/null 2>&1 &
fi
`

/** O que o mod lembra enquanto está carregado: cada carga (e recarga) começa do zero. */
type Memoria = {
  modo: Modo
  desenho: string
  /** O cache desta sessão, `<XDG_RUNTIME_DIR>/claude-miniaturas/<sessão>`. */
  pasta: string | undefined
  imagensDoClaude: { sessao: string; pasta: string } | undefined
  usaImagem: boolean
  avisouFfmpeg: boolean
  ultimoRascunho: string
  /** Imagens sendo lidas agora, e as que uma mensagem já pediu ao arquivo do Claude Code. */
  lendo: Set<number>
  pedidas: Set<number>
  pixels: Map<string, Pixels>
  desenhos: Map<string, string>
}

function novaMemoria(options: PluginOptions): Memoria {
  return {
    modo: MODOS.find(m => m === options.modo) ?? 'miniatura',
    desenho: typeof options.desenho === 'string' ? options.desenho : 'auto',
    pasta: undefined,
    imagensDoClaude: undefined,
    usaImagem: false,
    avisouFfmpeg: false,
    ultimoRascunho: '',
    lendo: new Set(),
    pedidas: new Set(),
    pixels: new Map(),
    desenhos: new Map(),
  }
}

let mem = novaMemoria({})


function lembrar<T>(mapa: Map<string, T>, chave: string, valor: T): T {
  mapa.set(chave, valor)
  if (mapa.size > MAX_NA_MEMORIA) mapa.delete(mapa.keys().next().value!)

  return valor
}

async function pastaDoCache($: Motor): Promise<string> {
  if (mem.pasta !== undefined) return mem.pasta
  const base = (await $.env.get('XDG_RUNTIME_DIR')) || '/tmp'
  const raiz = `${base}/claude-miniaturas`
  const id = await $.session.id()
  const sessao = /^[\w-]+$/.test(id) ? id : 'sessao'
  await $.process.run(['sh', '-c', SCRIPT_PREPARAR, 'sh', raiz, sessao], { timeoutMs: 10_000 })
  mem.pasta = `${raiz}/${sessao}`

  return mem.pasta
}

async function pastaDoClaude($: Motor): Promise<string | undefined> {
  const sessao = await $.session.id()
  if (mem.imagensDoClaude?.sessao === sessao) return mem.imagensDoClaude.pasta
  const r = await $.process.run(['sh', '-c', SCRIPT_IMAGENS, 'sh', sessao], { timeoutMs: 10_000 })
  const achada = r.exitCode === 0 ? r.stdout.trim() : ''
  if (achada === '') return undefined
  mem.imagensDoClaude = { sessao, pasta: achada }

  return achada
}

async function terminalDesenhaImagem($: Motor): Promise<boolean> {
  if (mem.desenho === 'imagem' || mem.desenho === 'blocos') return mem.desenho === 'imagem'
  const term = (await $.env.get('TERM')) ?? ''
  const programa = (await $.env.get('TERM_PROGRAM')) ?? ''
  const kitty = await $.env.get('KITTY_WINDOW_ID')

  return term === 'xterm-kitty' || term === 'xterm-ghostty' || programa === 'ghostty' || kitty !== undefined
}

async function guardar($: Motor, n: number, parcial: Partial<MiniaturaImagem>): Promise<void> {
  await update($, imagens, (mapa): Record<string, MiniaturaImagem> => ({
    ...mapa,
    [String(n)]: { estado: 'lendo', versao: 0, ...mapa[String(n)], ...parcial, n },
  }))
}

/** Reduz a imagem com o ffmpeg e guarda onde estão os mem.pixels; false quando não deu. */
async function processar($: Motor, n: number, fonte: string, origem: 'colagem' | 'enviada'): Promise<boolean> {
  const dir = await pastaDoCache($)
  const pam = `${dir}/${n}-${origem}.pam`
  const png = `${dir}/${n}-${origem}-mini.png`
  const r = await $.process.run(['sh', '-c', SCRIPT_FFMPEG, 'sh', fonte, pam, png], { timeoutMs: 30_000 })
  if (r.exitCode !== 0) {
    if (r.exitCode === 127 && !mem.avisouFfmpeg) {
      mem.avisouFfmpeg = true
      void $.ui.toast('miniaturas: instale o ffmpeg para ver as miniaturas das imagens')
    }
    await guardar($, n, { estado: 'erro', motivo: r.stderr.trim().slice(0, 200) || `o ffmpeg saiu com ${r.exitCode}` })

    return false
  }
  const [largura, altura] = r.stdout.trim().split('x').map(Number)
  const versao = await $.clock.now()
  await guardar($, n, {
    estado: 'pronta',
    origem,
    arquivo: fonte,
    pixels: pam,
    png,
    largura: largura! > 0 ? largura : undefined,
    altura: altura! > 0 ? altura : undefined,
    versao,
  })

  return true
}

/** Pega a imagem que acabou de ser colada, da área de transferência. */
async function capturar($: Motor, n: number): Promise<void> {
  try {
    const dir = await pastaDoCache($)
    await guardar($, n, { estado: 'lendo' })
    const destino = `${dir}/${n}-colagem.png`
    const r = await $.process.run(['sh', '-c', SCRIPT_COLAGEM, 'sh', destino], { timeoutMs: 10_000 })
    const saida = r.stdout.trim()
    if (saida === 'arquivo') await processar($, n, destino, 'colagem')
    else if (saida.startsWith('caminho:')) await processar($, n, saida.slice('caminho:'.length), 'colagem')
    else await guardar($, n, { estado: 'sem-previa' })
  } catch (erro) {
    await guardar($, n, { estado: 'erro', motivo: String(erro).slice(0, 200) })
  } finally {
    mem.lendo.delete(n)
  }
}

/** Troca a miniatura pela do arquivo que o Claude Code enviou, que é a imagem que o modelo leu. */
async function conferirEnviadas($: Motor, numeros: number[], tentativas: number): Promise<void> {
  const dir = await pastaDoClaude($)
  const faltam: number[] = []
  for (const n of numeros) {
    const arquivo = dir === undefined ? undefined : `${dir}/${n}.png`
    if (arquivo === undefined || !(await $.fs.exists(arquivo))) {
      faltam.push(n)
      continue
    }
    const atual = (await read($, imagens))[String(n)]
    if (atual?.origem !== 'enviada' || atual.arquivo !== arquivo) await processar($, n, arquivo, 'enviada')
  }
  if (faltam.length > 0 && tentativas > 1) {
    $.clock.after(ESPERA_DO_ENVIO_MS, () => void conferirEnviadas($, faltam, tentativas - 1))
  }
}

async function observar($: Motor, texto: string): Promise<void> {
  const numeros = numerosDeImagem(texto)
  const chave = numeros.join(',')
  if (chave === mem.ultimoRascunho) return
  mem.ultimoRascunho = chave
  await update($, rascunho, (): number[] => numeros)
  const conhecidas = await read($, imagens)
  for (const n of numeros) {
    if (conhecidas[String(n)] !== undefined || mem.lendo.has(n)) continue
    mem.lendo.add(n)
    $.clock.after(0, () => void capturar($, n))
  }
}

async function carregar($: Motor, img: MiniaturaImagem): Promise<Pixels | undefined> {
  if (img.estado !== 'pronta' || img.pixels === undefined) return undefined
  const chave = `${img.n}@${img.versao}@${img.pixels}`
  const guardado = mem.pixels.get(chave)
  if (guardado !== undefined) return guardado
  try {
    const lido = await $.fs.read(img.pixels, { as: 'bytes' })
    const px = lerPam(deBase64(lido.base64))

    return px === undefined ? undefined : lembrar(mem.pixels, chave, px)
  } catch {
    return undefined
  }
}

/** A miniatura de uma imagem pronta, dentro de `max`: imagem de verdade ou blocos coloridos. */
async function figura($: Motor, ui: Ui, img: MiniaturaImagem, max: Caixa): Promise<RenderNode | undefined> {
  if (img.estado !== 'pronta') return undefined
  const { Image, Raster } = ui
  if (mem.usaImagem && img.png !== undefined && img.largura !== undefined && img.altura !== undefined) {
    const { colunas, linhas } = caber(img.largura, img.altura, max.colunas, max.linhas)

    return (
      <Image
        key={`i${img.n}`}
        source={{ file: img.png, format: 'png', generation: img.versao }}
        columns={colunas}
        rows={linhas}
        alt={`imagem #${img.n}`}
      />
    )
  }
  const px = await carregar($, img)
  if (px === undefined) return undefined
  const { colunas, linhas } = caber(img.largura ?? px.largura, img.altura ?? px.altura, max.colunas, max.linhas)
  const chave = `${img.n}@${img.versao}:${colunas}x${linhas}`
  const cells = mem.desenhos.get(chave) ?? lembrar(mem.desenhos, chave, celulas(realcar(reduzir(px, colunas * AMOSTRA, linhas * AMOSTRA), NITIDEZ)))

  return <Raster key={`r${img.n}`} columns={colunas} rows={linhas} cells={cells} />
}

function situacao(img: MiniaturaImagem | undefined): string {
  if (img === undefined || img.estado === 'lendo') return 'lendo…'
  if (img.estado === 'sem-previa') return 'sem prévia antes do envio'
  if (img.estado === 'erro') return 'não deu para ler'

  return ''
}

function etiqueta($: Motor, ui: Ui, n: number, img: MiniaturaImagem | undefined, marca = '') {
  const { Button, Text } = ui
  const tamanho = img?.largura !== undefined && img.altura !== undefined ? ` ${img.largura}×${img.altura}` : ''
  const extra = situacao(img)
  const arquivo = img?.arquivo
  if (arquivo === undefined) {
    return (
      <Text dimColor>
        {`${marca}#${n}`} {extra}
      </Text>
    )
  }

  return (
    <Button key={`abrir-${n}`} label={`abrir a imagem #${n}`} plain dimColor onPress={() => abrir($, arquivo)}>
      {`${marca}#${n}`}
      <Text dimColor>{tamanho || ` ${extra}`}</Text>
    </Button>
  )
}

async function abrir($: Motor, arquivo: string): Promise<void> {
  const r = await $.process.run(['sh', '-c', SCRIPT_ABRIR, 'sh', arquivo], { timeoutMs: 10_000 })
  if (r.exitCode !== 0) void $.ui.toast('miniaturas: não consegui abrir a imagem no visualizador')
}

/** Miniaturas lado a lado, cada uma com a etiqueta embaixo (que abre a imagem inteira). */
async function lado(
  $: Motor,
  ui: Ui,
  numeros: number[],
  mapa: Record<string, MiniaturaImagem>,
  max: Caixa,
): Promise<RenderNode> {
  const { Box } = ui
  const itens = await Promise.all(numeros.map(async n => ({ n, img: mapa[String(n)], fig: await figuraDe($, ui, mapa[String(n)], max) })))

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {itens.map(({ n, img, fig }) => (
        <Box key={`m${n}`} flexDirection="column">
          {fig}
          {etiqueta($, ui, n, img)}
        </Box>
      ))}
    </Box>
  )
}

/**
 * Só as etiquetas; a miniatura aparece ao passar o mouse, acima da etiqueta, dentro de `max`.
 * Na faixa, `max` tem de caber na altura dela: revelada maior, a faixa rola, a etiqueta sai de
 * baixo do mouse e a miniatura some de novo.
 */
async function dicas(
  $: Motor,
  ui: Ui,
  numeros: number[],
  mapa: Record<string, MiniaturaImagem>,
  flutuante: boolean,
  max: Caixa,
): Promise<RenderNode> {
  const { Box } = ui
  const itens = await Promise.all(numeros.map(async n => ({ n, img: mapa[String(n)], fig: await figuraDe($, ui, mapa[String(n)], max) })))

  return (
    <Box flexDirection="row" alignItems="flex-end" columnGap={2}>
      {itens.map(({ n, img, fig }) =>
        flutuante ? (
          <Box key={`dica-${n}`} flexDirection="column">
            {etiqueta($, ui, n, img, '▣ ')}
            {fig !== undefined && (
              <Box position="absolute" bottom={1} left={0} display="none" hover={{ display: 'flex' }} borderStyle="round" borderDimColor>
                {fig}
              </Box>
            )}
          </Box>
        ) : (
          <Box key={`dica-${n}`} flexDirection="column">
            {fig !== undefined && (
              <Box display="none" hover={{ display: 'flex' }}>
                {fig}
              </Box>
            )}
            {etiqueta($, ui, n, img, '▣ ')}
          </Box>
        ),
      )}
    </Box>
  )
}

async function figuraDe($: Motor, ui: Ui, img: MiniaturaImagem | undefined, max: Caixa): Promise<RenderNode | undefined> {
  return img === undefined ? undefined : figura($, ui, img, max)
}

export const register: Register = (on, options) => {
  mem = novaMemoria(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'miniaturas',
      description: 'Mostra ou troca o jeito de ver as miniaturas das imagens coladas',
      argumentHint: '[miniatura|dica|fixa]',
    })
    mem.usaImagem = await terminalDesenhaImagem($)
    await pastaDoCache($)

    return next(e)
  })

  on('command.run', { command: 'miniaturas' }, async ($, e) => {
    const pedido = e.args.trim().toLowerCase()
    if (pedido === '') {
      return { text: `As miniaturas estão no modo ${mem.modo}. Troque com /miniaturas miniatura, dica ou fixa (ou em /config).` }
    }
    const novo = MODOS.find(m => m === pedido)
    if (novo === undefined) return { text: `Modo desconhecido: ${pedido}. Use miniatura, dica ou fixa.` }
    const r = await $.config.set({ key: 'miniaturas.modo', value: novo })
    if (r.deny !== undefined) return { text: `Não deu para trocar daqui (${r.deny}). Troque em /config › miniaturas.` }

    return { text: `Miniaturas no modo ${novo}.` }
  })

  on('prompt.edit', async ($, e, next) => {
    const r = await next(e)
    await observar($, r.text)

    return r
  })

  on('prompt.change', async ($, e, next) => {
    const r = await next(e)
    await observar($, e.text)

    return r
  })

  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    const numeros = numerosDeImagem(e.text)
    if (numeros.length > 0 && r.drop === undefined && e.command === undefined) {
      await update($, ultimas, (): number[] => numeros)
      $.clock.after(ESPERA_DO_ENVIO_MS, () => void conferirEnviadas($, numeros, TENTATIVAS_DO_ENVIO))
    }

    return r
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, imagens, (): Record<string, MiniaturaImagem> => ({}))
      await update($, rascunho, (): number[] => [])
      await update($, ultimas, (): number[] => [])
      mem.pixels.clear()
      mem.desenhos.clear()
      mem.pedidas.clear()
      mem.ultimoRascunho = ''
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const noRascunho = await read($, rascunho)
    const numeros = noRascunho.length === 0 && mem.modo === 'fixa' ? await read($, ultimas) : noRascunho
    if (numeros.length === 0) return next(e)

    const mapa = await read($, imagens)
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const abaixo = await next(e)
    const largura = e.props.bodyColumns
    const altura = Math.max(2, e.props.maxRows - 1)
    let faixa: RenderNode
    if (mem.modo === 'dica' && e.viewport?.isFullscreen !== false) {
      faixa = await dicas($, ui, numeros, mapa, false, { colunas: Math.min(NA_DICA.colunas, largura), linhas: Math.min(NA_DICA.linhas, altura) })
    } else if (mem.modo === 'fixa') {
      const cada = Math.max(8, Math.floor((largura - 2 * (numeros.length - 1)) / numeros.length))
      faixa = await lado($, ui, numeros, mapa, { colunas: cada, linhas: Math.min(LINHAS_DA_FIXA, altura) })
    } else {
      faixa = await lado($, ui, numeros, mapa, { colunas: Math.min(NA_FAIXA.colunas, largura), linhas: Math.min(NA_FAIXA.linhas, altura) })
    }

    return (
      <Box flexDirection="column">
        {abaixo}
        {faixa}
      </Box>
    )
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || mem.modo === 'fixa') return next(e)
    const numeros = numerosDeImagem(e.props.text)
    if (numeros.length === 0) return next(e)

    const mapa = await read($, imagens)
    const desconhecidas = numeros.filter(n => mapa[String(n)] === undefined && !mem.pedidas.has(n))
    if (desconhecidas.length > 0) {
      for (const n of desconhecidas) mem.pedidas.add(n)
      $.clock.after(0, () => void conferirEnviadas($, desconhecidas, TENTATIVAS_DO_ENVIO))
    }
    const prontas = numeros.filter(n => mapa[String(n)]?.estado === 'pronta')
    if (prontas.length === 0) return next(e)

    const ui = $.ui.resolve(e)
    const { Box } = ui
    const proprio = await next(e)
    const largura = Math.max(10, (e.viewport?.columns ?? 80) - 4)
    const extra =
      mem.modo === 'dica' && e.viewport?.isFullscreen !== false
        ? await dicas($, ui, prontas, mapa, true, { colunas: Math.min(NA_DICA.colunas, largura), linhas: NA_DICA.linhas })
        : await lado($, ui, prontas, mapa, { colunas: Math.min(NA_MENSAGEM.colunas, largura), linhas: NA_MENSAGEM.linhas })

    return (
      <Box flexDirection="column">
        {proprio}
        <Box paddingLeft={2}>{extra}</Box>
      </Box>
    )
  })
}
