import type { On, PromptChangeInput, PromptEditInput, RenderElement, RenderNode } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { paraBase64 } from '../hooks/pixels'

const PASTA = '/run/user/1000/claude-miniaturas/sessao-teste'
const IMAGENS_DO_CLAUDE = '/tmp/claude-1000/-projeto/sessao-teste/images'

/** 4×2 pixels: a linha de cima vermelha, a de baixo azul. */
const PAM = (() => {
  const cabecalho = 'P7\nWIDTH 4\nHEIGHT 2\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n'
  const dados = [...Array(4).fill([255, 0, 0, 255]).flat(), ...Array(4).fill([0, 0, 255, 255]).flat()]
  const bytes = new Uint8Array(cabecalho.length + dados.length)
  for (let i = 0; i < cabecalho.length; i++) bytes[i] = cabecalho.charCodeAt(i)
  bytes.set(dados, cabecalho.length)

  return bytes
})()

const FAIXA = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
} as const

const TELA = { columns: 100, rows: 40, isFullscreen: true } as const

type Mundo = {
  relogio: MockClock
  comandos: string[][]
  toasts: string[]
  configs: { key: string; value: unknown }[]
}

function saida(stdout: string, exitCode = 0) {
  return { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

/**
 * O mundo debaixo do mod: o terminal, a área de transferência com uma imagem, o ffmpeg, o cache
 * e o próprio Claude Code, que aceita a edição do prompt e desenha "engine" onde o mod deixa.
 */
function mundo(on: On, variaveis: Record<string, string> = {}, ffmpeg: 'ok' | 'ausente' = 'ok'): Mundo {
  mock.env(on, { XDG_RUNTIME_DIR: '/run/user/1000', TERM: 'xterm-256color', ...variaveis })
  const relogio = mock.clock(on, { now: 1_000 })
  const comandos: string[][] = []
  const toasts: string[] = []
  const configs: { key: string; value: unknown }[] = []

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sessao-teste' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('process.run', (_, e) => {
    comandos.push([...e.argv])
    const script = e.argv[0] === 'sh' ? (e.argv[2] ?? '') : ''
    if (script.includes('wl-paste')) return { value: saida('arquivo\n') }
    if (script.includes('ffmpeg')) return { value: ffmpeg === 'ok' ? saida('40x20\n') : saida('', 127) }
    if (script.includes('images')) return { value: saida(`${IMAGENS_DO_CLAUDE}\n`) }

    return { value: saida('') }
  })
  on('fs.read', () => ({ value: { base64: paraBase64(PAM) } }))
  on('fs.exists', () => ({ value: true }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('config.set', (_, e) => {
    configs.push({ key: e.key, value: e.value })

    return { value: e.value }
  })
  on('prompt.edit', (_, e) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)

    return { text, cursor: e.start + e.inputText.length }
  })
  on('prompt.change', (_, e) => ({ text: e.text }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  return { relogio, comandos, toasts, configs }
}

async function comecar($: Engine): Promise<void> {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

/**
 * A caixa do prompt. O `$` do teste dispara `prompt.edit` e `prompt.change`, mas a tabela de tipos
 * dele só lista as chamadas que um plugin faz em `$.prompt`, daí a conversão.
 */
type CaixaDoPrompt = {
  edit: (e: PromptEditInput) => Promise<unknown>
  change: (e: PromptChangeInput) => Promise<unknown>
}

function caixa($: Engine): CaixaDoPrompt {
  return $.prompt as unknown as CaixaDoPrompt
}

/** A pessoa cola uma imagem: o Claude Code põe o marcador no rascunho. */
async function colar($: Engine, n: number, antes = ''): Promise<void> {
  await caixa($).edit({
    origin: { kind: 'composer' },
    text: antes,
    cursor: antes.length,
    start: antes.length,
    end: antes.length,
    inputText: `[Image #${n}] `,
  })
}

/** O rascunho muda sem edição da pessoa: o envio esvaziou a caixa, uma limpeza. */
async function rascunho($: Engine, text: string): Promise<void> {
  await caixa($).change({ text, cursor: text.length, origin: { kind: 'history' } })
}

async function enviar($: Engine, text: string): Promise<void> {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  await rascunho($, '')
}

/** Desenha a faixa acima do prompt e devolve a árvore. */
async function faixa($: Engine, surface: 'terminal' | 'desktop' = 'terminal'): Promise<RenderElement> {
  const ui = await $.ui.mount({ plugin: 'miniaturas', surface, component: 'AbovePrompt', requestId: 'faixa', props: FAIXA, viewport: TELA })
  const arvore = await ui.drawn()
  await ui.unmount()

  return arvore
}

/** Desenha a linha de uma mensagem enviada e devolve a árvore. */
async function mensagem($: Engine, text: string): Promise<RenderElement> {
  const ui = await $.ui.mount({
    plugin: 'miniaturas',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'msg-1',
    props: { text, origin: { kind: 'composer' }, isExpanded: false },
    viewport: TELA,
  })
  const arvore = await ui.drawn()
  await ui.unmount()

  return arvore
}

/** Os elementos da árvore, em ordem, cada um com os `display` dos Box acima dele. */
function elementos(no: RenderNode, acima: string[] = []): { el: Exclude<RenderNode, string>; acima: string[] }[] {
  if (typeof no === 'string') return []
  const props = (no as { props?: Record<string, unknown> }).props ?? {}
  const display = no.type === 'Box' && typeof props.display === 'string' ? [props.display] : []
  const filhos = (no as { children?: RenderNode[] }).children ?? []

  return [{ el: no, acima }, ...filhos.flatMap(f => elementos(f, [...acima, ...display]))]
}

function doTipo(arvore: RenderElement, tipo: string) {
  return elementos(arvore).filter(({ el }) => el.type === tipo)
}

function textos(arvore: RenderElement): string {
  const partes: string[] = []
  const visitar = (no: RenderNode): void => {
    if (typeof no === 'string') {
      partes.push(no)

      return
    }
    for (const f of (no as { children?: RenderNode[] }).children ?? []) visitar(f)
    const label = (no as { props?: { label?: unknown } }).props?.label
    if (no.type === 'Button' && typeof label === 'string') partes.push(label)
  }
  visitar(arvore)

  return partes.join(' ')
}

/** Avança o relógio aos poucos até a faixa (ou a mensagem) trazer o elemento pedido. */
async function ate($: Engine, relogio: MockClock, desenhar: ($: Engine) => Promise<RenderElement>, tipo: string) {
  for (let i = 0; i < 60; i++) {
    const achados = doTipo(await desenhar($), tipo)
    if (achados.length > 0) return achados

    await relogio.advance(50)
  }
  throw new Error(`nenhum ${tipo} apareceu`)
}

function propsDe(achado: { el: Exclude<RenderNode, string> }): Record<string, unknown> {
  return (achado.el as { props?: Record<string, unknown> }).props ?? {}
}

test('colar uma imagem mostra a miniatura na faixa acima do prompt', async ($, on) => {
  const { relogio, comandos } = mundo(on)
  await comecar($)
  await colar($, 3)

  const [raster] = await ate($, relogio, faixa, 'Raster')
  expect(propsDe(raster!).columns).toBe(32)
  expect(propsDe(raster!).rows).toBe(8)
  expect(textos(await faixa($))).toContain('#3')
  expect(textos(await faixa($))).toContain('engine')

  const colagem = comandos.find(c => c[0] === 'sh' && (c[2] ?? '').includes('wl-paste'))
  expect(colagem?.[4]).toBe(`${PASTA}/3-colagem.png`)
})

test('enquanto a imagem é lida a faixa já mostra a etiqueta dizendo que está lendo', async ($, on) => {
  mundo(on)
  await comecar($)
  await colar($, 3)

  expect(textos(await faixa($))).toMatch(/#3\s+lendo…/)
})

test('apagar o marcador do rascunho tira a miniatura da faixa', async ($, on) => {
  const { relogio } = mundo(on)
  await comecar($)
  await colar($, 3)
  await ate($, relogio, faixa, 'Raster')

  await rascunho($, 'mudei de ideia')

  expect(doTipo(await faixa($), 'Raster')).toHaveLength(0)
  expect(textos(await faixa($))).toContain('engine')
})

test('sem imagem no rascunho a faixa fica como o Claude Code desenha', async ($, on) => {
  mundo(on)
  await comecar($)

  const arvore = await faixa($)

  expect(doTipo(arvore, 'Raster')).toHaveLength(0)
  expect(textos(arvore)).toContain('engine')
})

test('modo dica: a faixa mostra só a etiqueta e a miniatura fica escondida até passar o mouse', { options: { modo: 'dica' } }, async ($, on) => {
  const { relogio } = mundo(on)
  await comecar($)
  await colar($, 3)

  const [raster] = await ate($, relogio, faixa, 'Raster')
  expect(raster!.acima).toContain('none')
  const escondido = elementos(await faixa($)).find(({ el }) => {
    const hover = (el as { hover?: { display?: string } }).hover

    return el.type === 'Box' && propsDe({ el }).display === 'none' && hover?.display === 'flex'
  })
  expect(escondido).toBeDefined()
  expect(textos(await faixa($))).toContain('#3')
})

test('modo fixa: a imagem continua grande acima do prompt depois de enviar', { options: { modo: 'fixa' } }, async ($, on) => {
  const { relogio } = mundo(on)
  await comecar($)
  await colar($, 3)
  await ate($, relogio, faixa, 'Raster')

  await enviar($, 'olha [Image #3]')
  const [raster] = await ate($, relogio, faixa, 'Raster')

  expect(propsDe(raster!).columns).toBe(40)
  expect(propsDe(raster!).rows).toBe(10)
})

test('a mensagem enviada ganha a miniatura embaixo do que o Claude Code desenha', async ($, on) => {
  const { relogio } = mundo(on)
  await comecar($)
  await colar($, 3)
  await enviar($, 'olha [Image #3]')

  const [raster] = await ate($, relogio, $ => mensagem($, 'olha [Image #3]'), 'Raster')

  expect(propsDe(raster!).rows).toBe(6)
  expect(textos(await mensagem($, 'olha [Image #3]'))).toContain('engine')
})

test('fora do terminal o mod deixa o desenho com o Claude Code', async ($, on) => {
  const { relogio } = mundo(on)
  await comecar($)
  await colar($, 3)
  await ate($, relogio, faixa, 'Raster')

  const arvore = await faixa($, 'desktop')

  expect(doTipo(arvore, 'Raster')).toHaveLength(0)
  expect(textos(arvore)).toContain('engine')
})

test('sem ffmpeg o mod avisa uma vez só', async ($, on) => {
  const { relogio, toasts } = mundo(on, {}, 'ausente')
  await comecar($)
  await colar($, 3)
  await colar($, 4, '[Image #3] ')
  await relogio.advance(500)
  await relogio.advance(500)

  expect(toasts.filter(t => t.includes('ffmpeg'))).toHaveLength(1)
  expect(doTipo(await faixa($), 'Raster')).toHaveLength(0)
})

test('no kitty a miniatura é a imagem de verdade', async ($, on) => {
  const { relogio } = mundo(on, { TERM: 'xterm-kitty' })
  await comecar($)
  await colar($, 3)

  const [imagem] = await ate($, relogio, faixa, 'Image')
  const fonte = propsDe(imagem!).source as { file?: string; format?: string }

  expect(fonte.format).toBe('png')
  expect(fonte.file?.startsWith(`${PASTA}/3-`)).toBe(true)
  expect(doTipo(await faixa($), 'Raster')).toHaveLength(0)
})

test('clicar na etiqueta abre a imagem inteira no visualizador', async ($, on) => {
  const { relogio, comandos } = mundo(on)
  await comecar($)
  await colar($, 3)
  await ate($, relogio, faixa, 'Raster')

  const ui = await $.ui.mount({ plugin: 'miniaturas', surface: 'terminal', component: 'AbovePrompt', requestId: 'faixa', props: FAIXA, viewport: TELA })
  await ui.press({ key: 'abrir-3' })
  await ui.unmount()

  const abrir = comandos.find(c => c[0] === 'sh' && (c[2] ?? '').includes('xdg-open'))
  expect(abrir?.[4]).toBe(`${PASTA}/3-colagem.png`)
})

test('/miniaturas troca o modo, e sem argumento diz qual está valendo', async ($, on) => {
  const { configs } = mundo(on)
  await comecar($)
  const presentation = { isFullscreen: true, columns: 100 }

  const troca = await $.command.run({ command: 'miniaturas', args: 'dica', origin: { kind: 'composer' }, presentation })
  const atual = await $.command.run({ command: 'miniaturas', args: '', origin: { kind: 'composer' }, presentation })
  const errado = await $.command.run({ command: 'miniaturas', args: 'gigante', origin: { kind: 'composer' }, presentation })

  expect(configs).toEqual([{ key: 'miniaturas.modo', value: 'dica' }])
  expect(troca.text).toContain('dica')
  expect(atual.text).toContain('miniatura')
  expect(errado.text).toContain('miniatura, dica ou fixa')
})

test('depois do envio a miniatura passa a vir do arquivo que o Claude Code mandou', async ($, on) => {
  const { relogio, comandos } = mundo(on)
  await comecar($)
  await colar($, 3)
  await ate($, relogio, faixa, 'Raster')

  await enviar($, 'olha [Image #3]')
  for (let i = 0; i < 20; i++) await relogio.advance(100)

  const fontes = comandos.filter(c => c[0] === 'sh' && (c[2] ?? '').includes('ffmpeg')).map(c => c[4])
  expect(fontes).toEqual([`${PASTA}/3-colagem.png`, `${IMAGENS_DO_CLAUDE}/3.png`])
})

